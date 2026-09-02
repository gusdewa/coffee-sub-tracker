import { describe, test, beforeAll, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { odata, type TableClient } from '@azure/data-tables'

import { createTableClient, ensureTablesExist, azuriteConnectionString } from '../../src/storage/tableClient.js'
import { TABLES } from '../../src/storage/entities.js'
import { QA_PARTITION, qaLinkRowKey, ledgerPartitionKey, ALLOC_RANGE } from '../../src/storage/keys.js'
import { RosterCache, findMemberById } from '../../src/storage/roster.js'
import {
  createQaLink,
  redeemQaLink,
  revokeQaLink,
  resolveQaSession,
  QaLinkInvalidError,
  QaSessionInvalidError,
  type QaDeps,
} from '../../src/domain/qaLinks.js'
import { authorizeQaMember, requireAdmin, QaScopeDeniedError } from '../../src/auth/authorize.js'
import { createBatch } from '../../src/domain/batches.js'
import { consumeOne } from '../../src/domain/consume.js'

process.env.AZURE_TABLES_CONNECTION_STRING ??= azuriteConnectionString()

const ADMIN = 'ADMINQA00000000000000000AA'

let deps: QaDeps
let qaSessions: TableClient
let ledger: TableClient
let batches: TableClient

beforeAll(async () => {
  await ensureTablesExist()
  qaSessions = createTableClient(TABLES.qaSessions)
  ledger = createTableClient(TABLES.ledger)
  batches = createTableClient(TABLES.batches)
  deps = {
    members: createTableClient(TABLES.members),
    qaSessions,
    cache: new RosterCache(0),
  }
})

async function allQaRows(): Promise<string> {
  const rows: string[] = []
  for await (const e of qaSessions.listEntities({
    queryOptions: { filter: odata`PartitionKey eq ${QA_PARTITION}` },
  })) {
    rows.push(JSON.stringify(e))
  }
  return rows.join('')
}

describe('QA links store only hashes (plan §7)', () => {
  test('the plaintext code never appears in storage', async () => {
    const link = await createQaLink(deps, ADMIN)
    const dump = await allQaRows()
    expect(dump).not.toContain(link.code)
    // The hash IS the key, so a lookup stays a point read.
    const row = (await qaSessions.getEntity(QA_PARTITION, qaLinkRowKey(link.code))) as Record<string, unknown>
    expect(row.linkId).toBe(link.linkId)
  })

  test('the code carries 256 bits of entropy and is never reused', async () => {
    const a = await createQaLink(deps, ADMIN)
    const b = await createQaLink(deps, ADMIN)
    expect(Buffer.from(a.code, 'base64url')).toHaveLength(32)
    expect(a.code).not.toBe(b.code)
  })

  test('creates a synthetic, non-admin member with no address', async () => {
    const link = await createQaLink(deps, ADMIN)
    const member = await findMemberById(deps, link.qaMemberId)
    expect(member!.isSynthetic).toBe(true)
    expect(member!.role).toBe('member')
    expect(member!.email).toBe('')
  })
})

describe('redemption needs no Firebase at all', () => {
  test('a valid code mints an opaque session, not a JWT', async () => {
    const link = await createQaLink(deps, ADMIN)
    const session = await redeemQaLink(deps, link.code)

    expect(session.qaMemberId).toBe(link.qaMemberId)
    // 256 opaque bits. Nothing here depends on Identity Platform being
    // initialised, and no signing key exists to leak.
    expect(Buffer.from(session.sessionToken, 'base64url')).toHaveLength(32)
    expect(session.sessionToken).not.toContain('.')

    expect(await resolveQaSession(deps, session.sessionToken)).toBe(link.qaMemberId)
  })

  test('the session token is stored only as a hash', async () => {
    const link = await createQaLink(deps, ADMIN)
    const session = await redeemQaLink(deps, link.code)
    const dump = await allQaRows()
    expect(dump).not.toContain(session.sessionToken)
    expect(dump).not.toContain(link.code)
  })

  test('a second redemption of a single-use link is refused', async () => {
    const link = await createQaLink(deps, ADMIN)
    await redeemQaLink(deps, link.code)
    await expect(redeemQaLink(deps, link.code)).rejects.toBeInstanceOf(QaLinkInvalidError)
  })

  test('concurrent redemption of a single-use link yields exactly one session', async () => {
    const link = await createQaLink(deps, ADMIN)
    const settled = await Promise.allSettled(
      Array.from({ length: 8 }, () => redeemQaLink(deps, link.code)),
    )
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1)
  })

  test('a multi-use link allows exactly its quota', async () => {
    const link = await createQaLink(deps, ADMIN, { maxUses: 3 })
    await redeemQaLink(deps, link.code)
    await redeemQaLink(deps, link.code)
    await redeemQaLink(deps, link.code)
    await expect(redeemQaLink(deps, link.code)).rejects.toBeInstanceOf(QaLinkInvalidError)
  })

  test('an expired link is refused', async () => {
    const link = await createQaLink(deps, ADMIN, { ttlMinutes: 1 })
    const later = { ...deps, now: () => new Date(Date.now() + 5 * 60_000) }
    await expect(redeemQaLink(later, link.code)).rejects.toBeInstanceOf(QaLinkInvalidError)
  })

  test('an unknown code is refused without disclosing why', async () => {
    await expect(redeemQaLink(deps, 'x')).rejects.toBeInstanceOf(QaLinkInvalidError)
    await expect(
      redeemQaLink(deps, randomUUID() + randomUUID()),
    ).rejects.toBeInstanceOf(QaLinkInvalidError)
  })

  test('an unknown or expired session token is refused', async () => {
    await expect(resolveQaSession(deps, 'nonsense-token-value-000')).rejects.toBeInstanceOf(
      QaSessionInvalidError,
    )
    const link = await createQaLink(deps, ADMIN)
    const session = await redeemQaLink(deps, link.code)
    const later = { ...deps, now: () => new Date(Date.now() + 4 * 60 * 60_000) }
    await expect(resolveQaSession(later, session.sessionToken)).rejects.toBeInstanceOf(
      QaSessionInvalidError,
    )
  })
})

describe('scope containment and revocation', () => {
  test('a QA session can never reach an admin route', async () => {
    const link = await createQaLink(deps, ADMIN)
    const session = await redeemQaLink(deps, link.code)
    const ctx = await authorizeQaMember(deps, await resolveQaSession(deps, session.sessionToken))

    expect(ctx.isQa).toBe(true)
    expect(ctx.role).toBe('member')
    expect(() => requireAdmin(ctx)).toThrow(QaScopeDeniedError)
    // Even if the row were tampered to admin, the QA flag is checked first.
    expect(() => requireAdmin({ ...ctx, role: 'admin' })).toThrow(QaScopeDeniedError)
  })

  test('revoking kills an issued session immediately, not at expiry', async () => {
    const link = await createQaLink(deps, ADMIN)
    const session = await redeemQaLink(deps, link.code)
    expect(await resolveQaSession(deps, session.sessionToken)).toBe(link.qaMemberId)

    await revokeQaLink(deps, link.linkId)

    await expect(resolveQaSession(deps, session.sessionToken)).rejects.toBeInstanceOf(
      QaSessionInvalidError,
    )
    expect((await findMemberById(deps, link.qaMemberId))!.status).toBe('disabled')
    await expect(redeemQaLink(deps, link.code)).rejects.toBeInstanceOf(QaLinkInvalidError)
  })

  test('QA drinks land in their own partition and never touch a real balance', async () => {
    const real = `R${randomUUID().replace(/-/g, '').toUpperCase().slice(0, 25)}`
    await createBatch({ ledger, batches }, ADMIN, {
      label: 'Real beans', allocations: [{ memberId: real, units: 4 }],
    })

    const link = await createQaLink(deps, ADMIN)
    await redeemQaLink(deps, link.code)
    await createBatch({ ledger, batches }, ADMIN, {
      label: 'QA beans', allocations: [{ memberId: link.qaMemberId, units: 2 }],
    })
    await consumeOne({ ledger }, link.qaMemberId, randomUUID())

    const pk = ledgerPartitionKey(real)
    const rows: Record<string, unknown>[] = []
    for await (const e of ledger.listEntities({
      queryOptions: { filter: odata`PartitionKey eq ${pk} and RowKey ge ${ALLOC_RANGE.from} and RowKey lt ${ALLOC_RANGE.to}` },
    })) {
      rows.push(e as Record<string, unknown>)
    }
    expect(rows).toHaveLength(1)
    expect(rows[0]!.remaining).toBe(4)
    expect(ledgerPartitionKey(link.qaMemberId)).not.toBe(pk)
  })
})
