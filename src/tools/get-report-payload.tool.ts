import { z } from "zod";
import { ToolDefinition } from "../types/tool-definition.js";
import { getQuickbooksProfitAndLoss } from "../handlers/get-quickbooks-profit-and-loss.handler.js";
import { getQuickbooksBalanceSheet } from "../handlers/get-quickbooks-balance-sheet.handler.js";
import { getQuickbooksAgedReceivables } from "../handlers/get-quickbooks-aged-receivables.handler.js";
import { getQuickbooksAgedPayables } from "../handlers/get-quickbooks-aged-payables.handler.js";
import { QuickbooksClient } from "../clients/quickbooks-client.js";

// The entity's display name comes from the app setting the provisioning script
// already sets on every web app. The realm is NOT read from an environment
// variable — this fork loads it from Key Vault at runtime, so the only reliable
// source is the live client. See the payload assembly at the bottom.
const ENTITY_DISPLAY_NAME = process.env.ENTITY_DISPLAY_NAME || "";

/**
 * Returns a QuickBooks report already shaped for downstream consumers:
 * the PDF.co template payload and a flat row array for Excel.
 *
 * WHY THIS EXISTS
 * QBO reports come back as `Rows.Row[]` where each entry is either a Data row
 * with a `ColData[]` array or a Section containing more rows — recursively, to
 * arbitrary depth. Extracting a figure from that in Power Automate means an
 * index chain like
 *     ?['Rows']?['Row'][3]?['Summary']?['ColData'][1]?['value']
 * which is unreadable and breaks whenever QuickBooks adds a section. Doing the
 * walk once here, server-side, turns twenty fragile expressions into a handful
 * of plain field reads.
 *
 * Read-only. Calls the same handlers the individual report tools call.
 */

const toolName = "get_report_payload";

const toolDescription =
  "Fetch a QuickBooks report and return it pre-shaped for reporting: formatted " +
  "display strings for a PDF template, a flat row array for Excel, and headline " +
  "totals. Use this instead of the raw report tools when the output is going " +
  "into a document rather than being read directly.";

const toolSchema = z.object({
  report: z
    .enum(["profit_and_loss", "balance_sheet", "aged_receivables", "aged_payables"])
    .describe("Which report to fetch"),
  start_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
  end_date: z.string().optional().describe("End date (YYYY-MM-DD). For a balance sheet or aging report this is the as-of date."),
  accounting_method: z.enum(["Cash", "Accrual"]).optional(),
  period_label: z.string().optional().describe("Heading text, e.g. 'July 2026'. Derived from the dates if omitted."),
});

// ── Formatting ────────────────────────────────────────────────────────────────
const num = (s: unknown): number => {
  const n = parseFloat(String(s ?? "").replace(/,/g, ""));
  return Number.isNaN(n) ? 0 : n;
};

const money = (v: number): string => {
  const s = "$" + Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
  return v < 0 ? `(${s})` : s;
};

const pct = (v: number | null): string =>
  v === null || !Number.isFinite(v) ? "" : `${(v * 100).toFixed(1)}%`;

interface FlatRow {
  label: string;
  depth: number;
  kind: "data" | "header" | "subtotal";
  values: number[];
}

interface Section {
  title: string;
  subtotalLabel: string;
  subtotal: number | null;
  rows: FlatRow[];
}

// ── The walk ──────────────────────────────────────────────────────────────────
function walkReport(report: any): {
  columns: string[];
  sections: Section[];
  totals: Record<string, number>;
} {
  const columns: string[] = (report?.Columns?.Column ?? []).map(
    (c: any) => c.ColTitle || ""
  );
  const sections: Section[] = [];
  const totals: Record<string, number> = {};
  const rowsOf = (node: any): any[] => node?.Rows?.Row ?? [];

  // Recursive so nested sub-sections survive. A one-level walk silently drops
  // them, which is how a report quietly loses a whole expense group.
  function collect(node: any, depth: number, out: FlatRow[]): void {
    for (const r of rowsOf(node)) {
      if (r.ColData && !r.Rows && !r.Summary) {
        out.push({
          label: r.ColData[0]?.value ?? "",
          depth,
          kind: "data",
          values: r.ColData.slice(1).map((c: any) => num(c.value)),
        });
      } else if (r.Header || r.Summary || r.Rows) {
        const title = r.Header?.ColData?.[0]?.value;
        if (title) out.push({ label: title, depth, kind: "header", values: [] });
        collect(r, depth + 1, out);
        const s = r.Summary?.ColData;
        if (s) {
          out.push({
            label: s[0]?.value ?? "",
            depth,
            kind: "subtotal",
            values: s.slice(1).map((c: any) => num(c.value)),
          });
        }
      }
    }
  }

  for (const top of rowsOf(report)) {
    const group: string | undefined = top.group;
    const summary = top.Summary?.ColData;
    const title = top.Header?.ColData?.[0]?.value;

    // A standalone summary with no header is a headline figure: Gross Profit,
    // Net Income, Total Assets.
    if (summary && !title && !top.Rows) {
      const key = group || summary[0]?.value || "";
      totals[key] = num(summary[1]?.value);
      continue;
    }

    const rows: FlatRow[] = [];
    collect(top, 0, rows);
    sections.push({
      title: title ?? group ?? "",
      subtotalLabel: summary?.[0]?.value ?? "",
      subtotal: summary ? num(summary[1]?.value) : null,
      rows,
    });
    if (group && summary) totals[group] = num(summary[1]?.value);
  }

  return { columns, sections, totals };
}

// ── Payload assembly ──────────────────────────────────────────────────────────
const TITLES: Record<string, string> = {
  profit_and_loss: "Profit and loss",
  balance_sheet: "Balance sheet",
  aged_receivables: "Accounts receivable aging",
  aged_payables: "Accounts payable aging",
};

function periodLabelFor(
  report: string,
  start?: string,
  end?: string,
  supplied?: string
): string {
  if (supplied) return supplied;
  if (report === "balance_sheet" || report.startsWith("aged")) {
    return end ? `As of ${end}` : "As of today";
  }
  return start && end ? `${start} to ${end}` : "Current period";
}

const toolHandler = async ({ params }: any) => {
  const {
    report,
    start_date,
    end_date,
    accounting_method = "Accrual",
    period_label,
  } = params ?? {};

  const opts: any = {};
  if (start_date) opts.start_date = start_date;
  if (end_date) opts.end_date = end_date;
  if (accounting_method) opts.accounting_method = accounting_method;

  let response: any;
  if (report === "profit_and_loss") {
    response = await getQuickbooksProfitAndLoss(opts);
  } else if (report === "balance_sheet") {
    response = await getQuickbooksBalanceSheet(opts);
  } else if (report === "aged_receivables") {
    response = await getQuickbooksAgedReceivables(
      end_date ? { report_date: end_date } : {}
    );
  } else {
    response = await getQuickbooksAgedPayables(
      end_date ? { report_date: end_date } : {}
    );
  }

  if (response.isError) {
    return {
      content: [{ type: "text" as const, text: `Error: ${response.error}` }],
      isError: true,
    };
  }

  // Pulled from the live client rather than an env var, since the realm is
  // loaded from Key Vault on this fork.
  const realmIdValue = (await QuickbooksClient.getAuthCredentials()).realmId;

  const walked = walkReport(response.result);
  const label = periodLabelFor(report, start_date, end_date, period_label);

  // Primary basis for percentages: total income on a P&L, total assets on a
  // balance sheet. Null when there is no sensible denominator.
  const basisValue =
    walked.totals["Income"] ??
    walked.totals["TotalIncome"] ??
    walked.totals["Assets"] ??
    walked.totals["TotalAssets"] ??
    null;

  // ── Shape 1: the PDF template payload ──────────────────────────────────
  // Emit up to five value columns generically (c2..c6) rather than assuming a
  // single Amount column. A P&L has one; an aging report has five buckets. One
  // template shape then serves every report type.
  const valueCols = Math.min(Math.max(walked.columns.length - 1, 1), 5);

  // Only a single-column report gets a computed "% of basis" column — on a
  // five-bucket aging report there is no meaningful denominator per cell.
  const addPctColumn = valueCols === 1 && basisValue !== null && basisValue !== 0;

  const columnHeaders: Record<string, string> = {
    col1Header: walked.columns[0] || "Account",
  };
  for (let i = 0; i < valueCols; i++) {
    columnHeaders[`col${i + 2}Header`] = walked.columns[i + 1] || "Amount";
  }
  if (addPctColumn) columnHeaders[`col3Header`] = "% of total";

  const mapRow = (label: string, values: number[], indent: boolean) => {
    const row: Record<string, string> = {
      label: (indent ? "\u00a0\u00a0\u00a0" : "") + label,
    };
    for (let i = 0; i < valueCols; i++) {
      const v = values[i];
      row[`c${i + 2}`] = v === undefined ? "" : money(v);
      row[`tone${i + 2}`] = v !== undefined && v < 0 ? "neg" : "";
    }
    if (addPctColumn) {
      const v = values[0];
      row["c3"] = v === undefined ? "" : pct(v / (basisValue as number));
      row["tone3"] = "";
    }
    return row;
  };

  const pdfSections = walked.sections.map((s) => {
    const sec: Record<string, unknown> = {
      title: s.title,
      subtotalLabel: s.subtotalLabel,
      rows: s.rows
        .filter((r) => r.kind !== "header")
        .map((r) => mapRow(r.label, r.values, r.depth > 0)),
    };
    const subVals = s.subtotal === null ? [] : [s.subtotal];
    const mapped = mapRow(s.subtotalLabel, subVals, false);
    for (const k of Object.keys(mapped)) {
      if (k !== "label") sec[`subtotal${k.replace(/^(c|tone)/, "$1")}`] = mapped[k];
    }
    // Flatten to the names the template reads: subtotal2..subtotal6
    for (let i = 0; i < valueCols; i++) {
      sec[`subtotal${i + 2}`] = mapped[`c${i + 2}`] ?? "";
    }
    if (addPctColumn) sec["subtotal3"] = mapped["c3"] ?? "";
    return sec;
  });

  // ── KPI band ──────────────────────────────────────────────────────────────
  // Chosen per report from whatever summary groups QuickBooks actually
  // returned, rather than hardcoding group names that vary by report and by
  // company chart of accounts.
  const pick = (...keys: string[]): [string, number] | null => {
    for (const k of keys) {
      if (walked.totals[k] !== undefined) return [k, walked.totals[k]];
    }
    return null;
  };

  const KPI_SETS: Record<string, Array<[string, string[]]>> = {
    profit_and_loss: [
      ["Total income", ["Income", "TotalIncome"]],
      ["Gross profit", ["GrossProfit"]],
      ["Total expenses", ["Expenses", "TotalExpenses"]],
      ["Net income", ["NetIncome", "NetOperatingIncome"]],
    ],
    balance_sheet: [
      ["Total assets", ["Assets", "TotalAssets"]],
      ["Total liabilities", ["Liabilities", "TotalLiabilities"]],
      ["Total equity", ["Equity", "TotalEquity"]],
    ],
    aged_receivables: [["Total receivable", ["TOTAL", "Total", "GrandTotal"]]],
    aged_payables: [["Total payable", ["TOTAL", "Total", "GrandTotal"]]],
  };

  const kpis: Array<{ label: string; value: string; tone: string }> = [];
  for (const [label, keys] of KPI_SETS[report] ?? []) {
    const hit = pick(...keys);
    if (hit) {
      kpis.push({ label, value: money(hit[1]), tone: hit[1] < 0 ? "neg" : "" });
    }
  }
  // Fall back to the last section subtotal so the band is never empty.
  if (kpis.length === 0 && walked.sections.length) {
    const last = walked.sections[walked.sections.length - 1];
    if (last.subtotal !== null) {
      kpis.push({
        label: last.subtotalLabel || "Total",
        value: money(last.subtotal),
        tone: last.subtotal < 0 ? "neg" : "",
      });
    }
  }

  const grand = pick("NetIncome", "TotalAssets", "Assets", "TOTAL", "Total");

  // ── Shape 2: flat rows for Excel ──────────────────────────────────────────
  // Raw numbers, not formatted strings, so the workbook's own number formats
  // apply and the figures stay sortable and summable.
  const excelRows: Array<{
    section: string; account: string; depth: number;
    kind: string; amount: number | null;
  }> = [];
  for (const s of walked.sections) {
    for (const r of s.rows) {
      excelRows.push({
        section: s.title,
        account: r.label,
        depth: r.depth,
        kind: r.kind,
        amount: r.values.length ? r.values[0] : null,
      });
    }
    if (s.subtotal !== null) {
      excelRows.push({
        section: s.title,
        account: s.subtotalLabel,
        depth: 0,
        kind: "subtotal",
        amount: s.subtotal,
      });
    }
  }

  const payload = {
    entityName: ENTITY_DISPLAY_NAME,
    realmId: realmIdValue,
    reportTitle: TITLES[report] ?? report,
    reportKey: report,
    periodLabel: label,
    periodStart: start_date ?? null,
    periodEnd: end_date ?? null,
    accountingBasis: accounting_method,
    generatedOn: new Date().toISOString().slice(0, 10),
    preparedBy: "Finishes Solutions automated reporting",
    totals: walked.totals,
    totalsFormatted: Object.fromEntries(
      Object.entries(walked.totals).map(([k, v]) => [k, money(v)])
    ),
    columns: walked.columns,
    ...columnHeaders,
    valueColumnCount: valueCols,
    kpis,
    totalLabel: grand ? grand[0].replace(/([a-z])([A-Z])/g, "$1 $2") : "Total",
    totalValue: grand ? money(grand[1]) : "",
    sections: pdfSections,
    excelRows,
    rowCount: excelRows.length,
  };

  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
};

export const GetReportPayloadTool: ToolDefinition<typeof toolSchema> = {
  name: toolName,
  description: toolDescription,
  schema: toolSchema,
  handler: toolHandler,
};
