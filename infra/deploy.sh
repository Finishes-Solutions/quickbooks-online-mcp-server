#!/usr/bin/env bash
#
# Deploy (or update) one company's QuickBooks MCP server on Azure Container Apps.
#
# Shared resources (resource group, Log Analytics, Container Apps environment,
# ACR) are created once and reused; everything company-specific comes from
# main.bicep. Safe to re-run — every step is idempotent.
#
# Usage:
#   ./deploy.sh <company-slug>
#
# Required environment variables (from the company's one-time `npm run auth`):
#   QBO_CLIENT_ID           Intuit app client id
#   QBO_CLIENT_SECRET       Intuit app client secret
#   QBO_REFRESH_TOKEN       Refresh token produced by `npm run auth`
#   QBO_REALM_ID            Company realm id
#   MCP_AUTH_TOKEN          Bearer token clients must present (choose a strong value)
#
# Optional:
#   LOCATION                Azure region (default: eastus)
#   QBO_ENVIRONMENT         sandbox | production (default: sandbox)
#   PREFIX                  Shared-resource name prefix (default: qbomcp)
#
set -euo pipefail

COMPANY="${1:-}"
if [[ -z "$COMPANY" ]]; then
  echo "ERROR: company slug required. Usage: ./deploy.sh <company-slug>" >&2
  exit 1
fi

# Validate required secrets are present before doing anything.
: "${QBO_CLIENT_ID:?set QBO_CLIENT_ID}"
: "${QBO_CLIENT_SECRET:?set QBO_CLIENT_SECRET}"
: "${QBO_REFRESH_TOKEN:?set QBO_REFRESH_TOKEN}"
: "${QBO_REALM_ID:?set QBO_REALM_ID}"
: "${MCP_AUTH_TOKEN:?set MCP_AUTH_TOKEN}"

LOCATION="${LOCATION:-eastus}"
QBO_ENVIRONMENT="${QBO_ENVIRONMENT:-sandbox}"
PREFIX="${PREFIX:-qbomcp}"

RG="${PREFIX}-rg"
ACR_NAME="${PREFIX}acr"                 # ACR names: alphanumeric only
ENV_NAME="${PREFIX}-env"
LAW_NAME="${PREFIX}-logs"
IMAGE_TAG="qbo-mcp:$(date +%Y%m%d-%H%M%S)"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Subscription: $(az account show --query name -o tsv)"
echo "==> Company '${COMPANY}' | region ${LOCATION} | env ${QBO_ENVIRONMENT}"

# ---------------------------------------------------------------------------
# 1. Shared resources (create-if-absent).
# ---------------------------------------------------------------------------
echo "==> Ensuring resource group ${RG}"
az group create --name "$RG" --location "$LOCATION" -o none

if ! az acr show --name "$ACR_NAME" -o none 2>/dev/null; then
  echo "==> Creating shared ACR ${ACR_NAME}"
  az acr create --resource-group "$RG" --name "$ACR_NAME" --sku Basic -o none
fi
ACR_LOGIN_SERVER="$(az acr show --name "$ACR_NAME" --query loginServer -o tsv)"

if ! az monitor log-analytics workspace show -g "$RG" -n "$LAW_NAME" -o none 2>/dev/null; then
  echo "==> Creating Log Analytics workspace ${LAW_NAME}"
  az monitor log-analytics workspace create -g "$RG" -n "$LAW_NAME" -o none
fi
LAW_ID="$(az monitor log-analytics workspace show -g "$RG" -n "$LAW_NAME" --query customerId -o tsv)"
LAW_KEY="$(az monitor log-analytics workspace get-shared-keys -g "$RG" -n "$LAW_NAME" --query primarySharedKey -o tsv)"

if ! az containerapp env show -g "$RG" -n "$ENV_NAME" -o none 2>/dev/null; then
  echo "==> Creating Container Apps environment ${ENV_NAME}"
  az containerapp env create \
    -g "$RG" -n "$ENV_NAME" --location "$LOCATION" \
    --logs-workspace-id "$LAW_ID" --logs-workspace-key "$LAW_KEY" -o none
fi
ENV_ID="$(az containerapp env show -g "$RG" -n "$ENV_NAME" --query id -o tsv)"

# ---------------------------------------------------------------------------
# 2. Build the image in the cloud (no local Docker required).
# ---------------------------------------------------------------------------
echo "==> Building image ${IMAGE_TAG} in ACR"
az acr build --registry "$ACR_NAME" --image "$IMAGE_TAG" "$SCRIPT_DIR/.." -o none

# ---------------------------------------------------------------------------
# 3. Deploy the per-company stack (Key Vault + Container App + role wiring).
# ---------------------------------------------------------------------------
echo "==> Deploying Container App for ${COMPANY}"
DEPLOY_NAME="qbo-mcp-${COMPANY}-$(date +%s)"
az deployment group create \
  --name "$DEPLOY_NAME" \
  --resource-group "$RG" \
  --template-file "$SCRIPT_DIR/main.bicep" \
  --parameters \
      company="$COMPANY" \
      location="$LOCATION" \
      acrLoginServer="$ACR_LOGIN_SERVER" \
      acrName="$ACR_NAME" \
      imageTag="$IMAGE_TAG" \
      environmentId="$ENV_ID" \
      quickbooksEnvironment="$QBO_ENVIRONMENT" \
      mcpAuthToken="$MCP_AUTH_TOKEN" \
      quickbooksClientId="$QBO_CLIENT_ID" \
      quickbooksClientSecret="$QBO_CLIENT_SECRET" \
  -o none

# Read outputs individually so no JSON parser (python/jq) is required.
VAULT_NAME="$(az deployment group show -g "$RG" -n "$DEPLOY_NAME" --query properties.outputs.vaultName.value -o tsv)"
MCP_URL="$(az deployment group show -g "$RG" -n "$DEPLOY_NAME" --query properties.outputs.mcpUrl.value -o tsv)"

# ---------------------------------------------------------------------------
# 4. Seed the rotating tokens into Key Vault.
#    The vault uses RBAC, so grant the current operator Secrets Officer first,
#    then wait for the assignment to propagate before writing.
# ---------------------------------------------------------------------------
VAULT_ID="$(az keyvault show -n "$VAULT_NAME" --query id -o tsv)"
CALLER_OID="$(az ad signed-in-user show --query id -o tsv 2>/dev/null || az account show --query user.name -o tsv)"

echo "==> Granting operator Secrets Officer on ${VAULT_NAME}"
az role assignment create \
  --assignee-object-id "$CALLER_OID" --assignee-principal-type User \
  --role "Key Vault Secrets Officer" --scope "$VAULT_ID" -o none 2>/dev/null || true

echo "==> Seeding refresh token + realm id (waiting for RBAC propagation)"
for attempt in $(seq 1 12); do
  if az keyvault secret set --vault-name "$VAULT_NAME" \
       --name quickbooks-refresh-token --value "$QBO_REFRESH_TOKEN" -o none 2>/dev/null; then
    az keyvault secret set --vault-name "$VAULT_NAME" \
      --name quickbooks-realm-id --value "$QBO_REALM_ID" -o none
    break
  fi
  if [[ "$attempt" -eq 12 ]]; then
    echo "ERROR: could not write secrets after RBAC propagation wait." >&2
    echo "Grant yourself 'Key Vault Secrets Officer' on ${VAULT_NAME} and re-run seeding." >&2
    exit 1
  fi
  sleep 10
done

# Restart so the app picks up the freshly seeded tokens on its next revision.
echo "==> Restarting app to load seeded tokens"
az containerapp revision restart -g "$RG" -n "qbo-mcp-${COMPANY}" \
  --revision "$(az containerapp show -g "$RG" -n "qbo-mcp-${COMPANY}" --query properties.latestRevisionName -o tsv)" \
  -o none 2>/dev/null || true

echo ""
echo "============================================================"
echo " Deployed ${COMPANY}"
echo "   MCP endpoint : ${MCP_URL}"
echo "   Key Vault    : ${VAULT_NAME}"
echo "   Auth header  : Authorization: Bearer <MCP_AUTH_TOKEN>"
echo "============================================================"
echo ""
echo "Smoke test:"
echo "  curl -s ${MCP_URL%/mcp}/healthz"
