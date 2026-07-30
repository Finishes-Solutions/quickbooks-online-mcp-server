# Azure deployment (Container Apps)

Provisions the QuickBooks MCP server on Azure Container Apps — **one isolated
server per company**, all sharing a registry and environment.

## What gets created

**Shared (once, by `deploy.sh`):**
- Resource group, Log Analytics workspace
- Azure Container Registry (holds the image)
- Container Apps managed environment

**Per company (`main.bicep`):**
- Key Vault (holds that company's rotating refresh token + realm id)
- Container App with a **system-assigned managed identity** and external HTTPS ingress
- Two role assignments that wire it together:
  - **AcrPull** on the registry → the app pulls its image without passwords
  - **Key Vault Secrets Officer** (get/set) on the vault → the app reads the
    refresh token at startup and writes the rotated value back on each refresh

## How it wires to the app

| App expectation (Phase 1) | Provided by the deployment |
|---------------------------|----------------------------|
| `MCP_AUTH_TOKEN` bearer auth | Container App secret → env var |
| `QUICKBOOKS_CLIENT_ID` / `_SECRET` | Container App secrets → env vars |
| `QUICKBOOKS_KEYVAULT_URL` | Set to the company vault URI; app uses its managed identity to reach it |
| refresh token / realm persistence | Key Vault secrets `quickbooks-refresh-token`, `quickbooks-realm-id` |
| read-only mode | `QUICKBOOKS_DISABLE_WRITE/UPDATE/DELETE=true` env vars |
| `/healthz` probe | Liveness + readiness probes on the container port |

The app authenticates to Key Vault via `DefaultAzureCredential`, which resolves
to the Container App's managed identity at runtime — no secrets in the image.

## Prerequisites

- Azure CLI (`az`) logged in to the target subscription (`az login`)
- The Bicep CLI (`az bicep install`)
- A completed one-time `npm run auth` for the company, giving you its
  **refresh token** and **realm id**

## Deploy a company

```bash
export QBO_CLIENT_ID=...            # Intuit app client id
export QBO_CLIENT_SECRET=...        # Intuit app client secret
export QBO_REFRESH_TOKEN=...        # from `npm run auth`
export QBO_REALM_ID=...             # from `npm run auth`
export MCP_AUTH_TOKEN=$(openssl rand -hex 32)   # strong per-company bearer token
export QBO_ENVIRONMENT=sandbox      # or production

./deploy.sh acme
```

Re-run with a different slug for each company (`./deploy.sh globex`). Every step
is idempotent, so re-running the same slug safely updates that company (and
redeploys the latest image).

The script prints the MCP endpoint URL and the Key Vault name on success. Save
the URL and its `MCP_AUTH_TOKEN` — you'll need both for the Copilot Studio
custom connector (Phase 4).

## Notes

- **First-deploy image-pull race:** the AcrPull role is granted as the app is
  created, and role propagation can lag a few seconds. `deploy.sh` restarts the
  app at the end, which resolves it; if a very first revision shows a pull error,
  re-running the script clears it.
- **Scale to zero:** idle companies cost effectively nothing; the first request
  after idle incurs a cold start.
- **Secret rotation:** the app writes rotated refresh tokens straight to Key
  Vault, so they survive restarts and new revisions with no manual step.
