#!/usr/bin/env node

import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./server/build-server.js";

const PORT = Number(process.env.PORT ?? 3000);
// Shared bearer token the MCP client (e.g. the Copilot custom connector) must
// present. Deploy one distinct value per company. If unset, the server refuses
// to start rather than exposing QuickBooks data unauthenticated.
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

if (!AUTH_TOKEN) {
  console.error(
    "MCP_AUTH_TOKEN is not set. Refusing to start an unauthenticated QuickBooks server."
  );
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "10mb" }));

// Liveness/readiness probe for Azure Container Apps. Must stay unauthenticated.
app.get("/healthz", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// Bearer-token auth for everything else.
app.use((req: Request, res: Response, next: NextFunction) => {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token !== AUTH_TOKEN) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
    return;
  }
  next();
});

// MCP endpoint. Stateless mode: a fresh server + transport per request, so no
// cross-request session state is retained. Fits the read-only, single-company
// deployment model and keeps horizontal scaling trivial.
app.post("/mcp", async (req: Request, res: Response) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Streamable HTTP in stateless mode only uses POST. GET (server-initiated SSE
// stream) and DELETE (session teardown) have no meaning without sessions.
const methodNotAllowed = (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed" },
    id: null,
  });
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

app.listen(PORT, () => {
  // Log to stderr to mirror the stdio entry point's convention.
  console.error(`QuickBooks MCP server (HTTP) listening on :${PORT}/mcp`);
});
