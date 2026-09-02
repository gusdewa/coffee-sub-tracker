import { TableClient, TableServiceClient } from '@azure/data-tables'
import { DefaultAzureCredential } from '@azure/identity'
import { TABLES, type TableName } from './entities.js'

/**
 * Table client factory.
 *
 * Production uses `DefaultAzureCredential`, which on App Service resolves to
 * the system-assigned managed identity — so no storage key or SAS exists
 * anywhere in the deployed system.
 *
 * `AZURE_TABLES_CONNECTION_STRING` is honoured only for the local Azurite
 * emulator during tests. It is deliberately not a production code path: if it
 * is set while `NODE_ENV === 'production'` the process refuses to start,
 * rather than silently downgrading to key-based auth.
 */

const AZURITE_CONNECTION_STRING =
  'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;' +
  'AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;' +
  'TableEndpoint=http://127.0.0.1:10002/devstoreaccount1;'

export function azuriteConnectionString(): string {
  return AZURITE_CONNECTION_STRING
}

function connectionStringFromEnv(): string | undefined {
  const cs = process.env.AZURE_TABLES_CONNECTION_STRING
  if (!cs) return undefined
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'AZURE_TABLES_CONNECTION_STRING is set in production. Storage access must ' +
        'use the managed identity; refusing to start with key-based auth.',
    )
  }
  return cs
}

function accountUrl(): string {
  const account = process.env.STORAGE_ACCOUNT_NAME
  if (!account) throw new Error('STORAGE_ACCOUNT_NAME is not configured')
  return `https://${account}.table.core.windows.net`
}

export function createTableClient(table: TableName): TableClient {
  const cs = connectionStringFromEnv()
  if (cs) {
    return TableClient.fromConnectionString(cs, table, { allowInsecureConnection: true })
  }
  return new TableClient(accountUrl(), table, new DefaultAzureCredential())
}

export function createTableServiceClient(): TableServiceClient {
  const cs = connectionStringFromEnv()
  if (cs) {
    return TableServiceClient.fromConnectionString(cs, { allowInsecureConnection: true })
  }
  return new TableServiceClient(accountUrl(), new DefaultAzureCredential())
}

/**
 * Idempotent — safe to run on every deploy and at the start of every test.
 *
 * In production the tables are created by provisioning, and the managed
 * identity holds *table-scoped* roles, which deliberately do not include the
 * table-service permission needed to create one. A 403 here is therefore the
 * expected, correct outcome of least privilege, not a failure: the tables
 * already exist and the service should start. A 403 when a table genuinely is
 * missing surfaces on first use instead, with a clearer message than a
 * start-up crash would give.
 */
export async function ensureTablesExist(): Promise<void> {
  const svc = createTableServiceClient()
  for (const name of Object.values(TABLES)) {
    await svc.createTable(name).catch((err: unknown) => {
      const status = (err as { statusCode?: number }).statusCode
      if (status === 409) return // already exists
      if (status === 403) return // table-scoped identity may not create tables
      throw err
    })
  }
}

// --- Error classification ---------------------------------------------------

export function statusCodeOf(err: unknown): number | undefined {
  return (err as { statusCode?: number } | undefined)?.statusCode
}

/** 412: an ETag precondition failed — someone else wrote first. Re-read and retry. */
export function isPreconditionFailed(err: unknown): boolean {
  return statusCodeOf(err) === 412
}

/** 409: an insert lost a race against an identical key. The conflict *is* the guarantee. */
export function isConflict(err: unknown): boolean {
  return statusCodeOf(err) === 409
}

/** 404: entity absent. */
export function isNotFound(err: unknown): boolean {
  return statusCodeOf(err) === 404
}
