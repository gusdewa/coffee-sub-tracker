// coffee-sub-tracker infrastructure.
//
// Deployed by GitHub Actions via OIDC — never from a workstation. The shared
// storage account and App Service plan are referenced as existing resources:
// this template owns only what the coffee tracker adds, so a redeploy can
// never reshape infrastructure the other thirteen apps depend on.

targetScope = 'resourceGroup'

@description('Name of the API web app.')
param appName string = 'simo-digitalassets-svc-coffee-sub'

@description('Existing Linux App Service plan shared with the other digital-assets apps.')
param appServicePlanName string = 'simo-digitalassets-shared-plan'

@description('Existing StorageV2 account that holds the four coffee tables.')
param storageAccountName string = 'smartinnovdigitalassets'

@description('Existing Log Analytics workspace for table-service audit logs.')
param logAnalyticsName string = 'simo-digitalassets-logs'

@description('Key Vault holding the single secret: the Firebase service-account JSON.')
param keyVaultName string = 'kv-simo-coffeesub-dev'

param location string = resourceGroup().location
param firebaseProjectId string = 'srx-co-id'
param allowedEmailDomain string = 'srx.co.id'
param allowedOrigin string = 'https://gusdewa.github.io'
param undoWindowSeconds int = 90

@description('Object id of the GitHub Actions deployment principal, granted Website Contributor.')
param deployPrincipalId string = ''

var tableNames = [
  'CoffeeMembers'
  'CoffeeLedger'
  'CoffeeBatches'
  'CoffeeQaSessions'
]

// Built-in role definition ids.
var tableDataContributorRoleId = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'
var websiteContributorRoleId = 'de139f84-1756-47ae-9be6-808fbbe84772'

resource plan 'Microsoft.Web/serverfarms@2023-12-01' existing = {
  name: appServicePlanName
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: logAnalyticsName
}

// --- the four tables -------------------------------------------------------
// Declared here so the schema's existence is reviewable, and so a fresh
// environment can be stood up without a manual CLI step.

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' existing = {
  parent: storage
  name: 'default'
}

resource tables 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = [
  for name in tableNames: {
    parent: tableService
    name: name
  }
]

// --- key vault -------------------------------------------------------------

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    sku: { family: 'A', name: 'standard' }
    tenantId: subscription().tenantId
    // RBAC rather than access policies: one authorization model for the whole
    // estate, and role assignments are auditable alongside everything else.
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    // Purge protection stays off: this is nonprod and the vault must remain
    // cleanable. Turn it on before anything production depends on it.
    enablePurgeProtection: null
    publicNetworkAccess: 'Enabled'
  }
}

// --- the API ---------------------------------------------------------------

resource api 'Microsoft.Web/sites@2023-12-01' = {
  name: appName
  location: location
  identity: {
    // System-assigned: the app's only credential to Azure. No connection
    // string or storage key exists anywhere in the deployed system.
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|22-lts'
      alwaysOn: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      http20Enabled: true
      appCommandLine: 'node dist/server.js'
      appSettings: [
        { name: 'NODE_ENV', value: 'production' }
        { name: 'FIREBASE_PROJECT_ID', value: firebaseProjectId }
        { name: 'ALLOWED_EMAIL_DOMAIN', value: allowedEmailDomain }
        { name: 'STORAGE_ACCOUNT_NAME', value: storageAccountName }
        { name: 'ALLOWED_ORIGIN', value: allowedOrigin }
        { name: 'UNDO_WINDOW_SECONDS', value: string(undoWindowSeconds) }
        { name: 'ROSTER_CACHE_TTL_MS', value: '60000' }
        { name: 'WEBSITE_RUN_FROM_PACKAGE', value: '1' }
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'false' }
        {
          // Resolved by the managed identity at start-up. The value never
          // passes through a workflow log or a local shell.
          name: 'FIREBASE_SA_JSON'
          value: '@Microsoft.KeyVault(SecretUri=${vault.properties.vaultUri}secrets/firebase-sa-json/)'
        }
      ]
    }
  }
}

// --- least-privilege RBAC --------------------------------------------------
// Table scope, not account scope: the identity can reach the four coffee
// tables and nothing else in an account shared with thirteen other apps.

resource tableRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for (name, i) in tableNames: {
    name: guid(storage.id, name, appName, 'table-data-contributor')
    scope: tables[i]
    properties: {
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableDataContributorRoleId)
      principalId: api.identity.principalId
      principalType: 'ServicePrincipal'
    }
  }
]

resource vaultRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, appName, 'kv-secrets-user')
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: api.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// The Actions principal also seeds the roster, so it needs data-plane access to
// CoffeeMembers — and to nothing else. It can admit or disable a person; it
// cannot alter a balance or rewrite an audit row.
resource seedRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(deployPrincipalId)) {
  name: guid(storage.id, 'CoffeeMembers', deployPrincipalId, 'roster-seed')
  scope: tables[0]
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableDataContributorRoleId)
    principalId: deployPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// The Actions principal may deploy this one app — not the plan, not the group.
resource deployRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(deployPrincipalId)) {
  name: guid(api.id, deployPrincipalId, 'website-contributor')
  scope: api
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', websiteContributorRoleId)
    principalId: deployPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// --- tamper evidence -------------------------------------------------------
// Azure Tables have no WORM mode and no append-only role, so the audit rows are
// append-only by application discipline. These logs are the independent check:
// they land in a workspace the API's identity cannot write to, so an
// out-of-band update or delete is still visible.

resource tableAudit 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'coffee-sub-table-audit'
  scope: tableService
  properties: {
    workspaceId: workspace.id
    logs: [
      { category: 'StorageWrite', enabled: true }
      { category: 'StorageDelete', enabled: true }
    ]
  }
}

output apiPrincipalId string = api.identity.principalId
output apiHostName string = api.properties.defaultHostName
output keyVaultUri string = vault.properties.vaultUri
