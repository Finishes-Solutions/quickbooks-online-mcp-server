// Per-company QuickBooks MCP deployment.
//
// Creates one company's Key Vault + Container App and wires them together via
// the app's system-assigned managed identity:
//   - AcrPull on the (shared) registry           -> the app can pull its image
//   - Key Vault Secrets Officer (get/set) on the -> the app can read the rotating
//     company's vault                               refresh token at startup and
//                                                    write the rotated value back
//
// The shared registry and Container Apps environment are created once by
// deploy.sh and passed in here as parameters, so this template can be deployed
// repeatedly — once per company — with only `company` changing.

targetScope = 'resourceGroup'

@description('Short company slug (lowercase, e.g. "acme"). Used to name resources.')
@minLength(2)
@maxLength(16)
param company string

@description('Azure region. Defaults to the resource group location.')
param location string = resourceGroup().location

@description('Login server of the shared ACR, e.g. qbomcpshared.azurecr.io')
param acrLoginServer string

@description('Name of the shared ACR (for AcrPull role scoping).')
param acrName string

@description('Image reference within the registry, e.g. qbo-mcp:2026-07-30-1')
param imageTag string

@description('Resource id of the shared Container Apps managed environment.')
param environmentId string

@description('QuickBooks environment: sandbox or production.')
@allowed(['sandbox', 'production'])
param quickbooksEnvironment string = 'sandbox'

@description('Container listen port. Must match the app (default 3000).')
param containerPort int = 3000

@secure()
@description('Bearer token clients must present on /mcp. Distinct per company.')
param mcpAuthToken string

@secure()
param quickbooksClientId string

@secure()
param quickbooksClientSecret string

var appName = 'qbo-mcp-${company}'
// Key Vault names: <=24 chars, alphanumeric/hyphen, globally unique. The
// uniqueString suffix avoids collisions across subscriptions.
var vaultName = take('kvqbo${company}${uniqueString(resourceGroup().id, company)}', 24)

// Built-in role definition ids.
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d' // AcrPull
var secretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7' // Key Vault Secrets Officer

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: acrName
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: vaultName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    // RBAC (not access policies) so the app identity is authorized via a role
    // assignment below; deploy.sh grants the human operator the same role to
    // seed the initial secrets.
    enableRbacAuthorization: true
    enableSoftDelete: true
  }
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    managedEnvironmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: containerPort
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: acrLoginServer
          identity: 'system'
        }
      ]
      secrets: [
        {
          name: 'mcp-auth-token'
          value: mcpAuthToken
        }
        {
          name: 'qbo-client-id'
          value: quickbooksClientId
        }
        {
          name: 'qbo-client-secret'
          value: quickbooksClientSecret
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'qbo-mcp'
          image: '${acrLoginServer}/${imageTag}'
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: [
            {
              name: 'PORT'
              value: string(containerPort)
            }
            {
              name: 'MCP_AUTH_TOKEN'
              secretRef: 'mcp-auth-token'
            }
            {
              name: 'QUICKBOOKS_CLIENT_ID'
              secretRef: 'qbo-client-id'
            }
            {
              name: 'QUICKBOOKS_CLIENT_SECRET'
              secretRef: 'qbo-client-secret'
            }
            {
              name: 'QUICKBOOKS_ENVIRONMENT'
              value: quickbooksEnvironment
            }
            // The app reads/writes the rotating refresh token here via its
            // managed identity (see the Secrets Officer role assignment below).
            {
              name: 'QUICKBOOKS_KEYVAULT_URL'
              value: vault.properties.vaultUri
            }
            // Read-only deployment: suppress all mutating tool categories.
            {
              name: 'QUICKBOOKS_DISABLE_WRITE'
              value: 'true'
            }
            {
              name: 'QUICKBOOKS_DISABLE_UPDATE'
              value: 'true'
            }
            {
              name: 'QUICKBOOKS_DISABLE_DELETE'
              value: 'true'
            }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/healthz'
                port: containerPort
              }
              initialDelaySeconds: 5
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/healthz'
                port: containerPort
              }
              initialDelaySeconds: 3
              periodSeconds: 15
            }
          ]
        }
      ]
      scale: {
        // Scale to zero when idle; one company's server costs nothing at rest.
        minReplicas: 0
        maxReplicas: 2
      }
    }
  }
}

// Wire 1: let the app pull its image from the shared registry.
resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, app.id, acrPullRoleId)
  scope: acr
  properties: {
    principalId: app.identity.principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalType: 'ServicePrincipal'
  }
}

// Wire 3: let the app read/write the rotating token in its Key Vault.
resource secretsOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, app.id, secretsOfficerRoleId)
  scope: vault
  properties: {
    principalId: app.identity.principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', secretsOfficerRoleId)
    principalType: 'ServicePrincipal'
  }
}

output appFqdn string = app.properties.configuration.ingress.fqdn
output mcpUrl string = 'https://${app.properties.configuration.ingress.fqdn}/mcp'
output vaultName string = vault.name
output vaultUri string = vault.properties.vaultUri
