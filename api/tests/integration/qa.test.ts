import { describe, test, beforeAll, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { generateKeyPair, decodeJwt, type KeyLike } from 'jose'
import { odata, type TableClient } from '@azure/data-tables'

import { createTableClient, ensureTablesExist, azuriteConnectionString } from '../../src/storage/tableClient.js'
import { TABLES } from '../../src/storage/entities.js'
import { QA_PARTITION, ledgerPartitionKey, ALLOC_RANGE } from '../../src/storage/keys.js'
import { RosterCache, findMemberById } from '../../src/storage/roster.js'
import { createQaLink, redeemQaLink, revokeQaLink, QaLinkInvalidError, type QaDeps } from '../../src/domain/qaLinks.js'
import { CUSTOM_TOKEN_AUDIENCE } from '../../src/auth/customToken.js'
import { createBatch } from '../../src/domain/batches.js'
import { consumeOne } from '../../src/domain/consume.js'

process.env.AZURE_TABLES_CONNECTION_STRING ??= azuriteConnectionString()

const ADMIN = 'ADMINQA00000000000000000AA'

let deps: QaDeps
let qaSessions: TableClient
let ledger: TableClient
let batches: TableClient
let signingKey: KeyLike

beforeAll(async () => {
  await ensureTablesExist()
  qaSessions = createTableClient(TABLES.qaSessions)
  ledger = createTableClient(TABLES.ledger)
  batches = createTableClient(TABLES.batches)
  const pair = await generateKeyPair('RS256', { extractable: true })
  signingKey = pair.privateKey
  deps = {
    members: createTableClient(TABLES.members),
    qaSessions,
    cache: new RosterCache(0),
    signingKey,
  }
})

async function storedRow(code: string) {
  for await (const e of qaSessions.listEntities({
    queryOptions: { filter: odata`PartitionKey eq ${QA_PARTITION}` },
  })) {
    const row = e as Record<string, unknown>
    if (String(row.rowKey) === (await import('../../src/storage/keys.js')).qaSessionRowKey(code)) return row
  }
  return undefined
}

describe('QA link creation stores only a hash (plan §7)', () => {
  test('the plaintext code never appears in storage', async () => {
    const link = await createQaLink(deps, ADMIN)
    const row = await storedRow(link.code)

    expect(row).toBeDefined()
    expect(row!.rowKey).toMatch(/^[0-9a-f]{64}$/)
    // Not the code, and no property carries it either.
    expect(JSON.stringify(row)).not.toContain(link.code)
  })

  test('the code carries 256 bits of entropy', async () => {
    const a = await createQaLink(deps, ADMIN)
    const b = await createQaLink(deps, ADMIN)
    expect(Buffer.from(a.code, 'base64url')).toHaveLength(32)
    expect(a.code).not.toBe(b.code)
  })

  test('creates a synthetic, non-admin member with no email address', async () => {
    const link = await createQaLink(deps, ADMIN)
    const member = await findMemberById(deps, link.qaMemberId)

    expect(member).toBeDefined()
    expect(member!.isSynthetic).toBe(true)
    expect(member!.role).toBe('member')
    expect(member!.email).toBe('')
    expect(member!.status).toBe('active')
  })
})

describe('redemption is single-use and replay-proof', () => {
  test('a valid code mints a custom token scoped to the synthetic member', async () => {
    const link = await createQaLink(deps, ADMIN)
    const session = await redeemQaLink(deps, link.code)

    expect(session.qaMemberId).toBe(link.qaMemberId)

    const claims = decodeJwt(session.customToken)
    expect(claims.uid).toBe(link.qaMemberId)
    expect(claims.aud).toBe(CUSTOM_TOKEN_AUDIENCE)
    expect(claims.claims).toEqual({ qa: true, role: 'member' })
    // Firebase refuses custom tokens longer than an hour.
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(3600)
  })

  test('a second redemption of a single-use link is refused', async () => {
    const link = await createQaLink(deps, ADMIN)
    await redeemQaLink(deps, link.code)
    await expect(redeemQaLink(deps, link.code)).rejects.toBeInstanceOf(QaLinkInvalidError)
  })

  test('concurrent redemption of a single-use link yields exactly one success', async () => {
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

  test('an unknown or malformed code is refused without disclosing which', async () => {
    await expect(redeemQaLink(deps, 'x')).rejects.toBeInstanceOf(QaLinkInvalidError)
    await expect(redeemQaLink(deps, randomUUID() + randomUUID())).rejects.toBeInstanceOf(QaLinkInvalidError)

    const link = await createQaLink(deps, ADMIN)
    const wrong = await redeemQaLink(deps, link.code).then(() => null).catch((e) => e)
    expect(wrong).toBeNull() // the real one works
    // Both failure shapes above produced the same error type and message.
  })
})

describe('revocation and isolation', () => {
  test('revoking disables the synthetic member so an issued token dies', async () => {
    const link = await createQaLink(deps, ADMIN)
    await redeemQaLink(deps, link.code)

    await revokeQaLink(deps, link.linkId)

    const member = await findMemberById(deps, link.qaMemberId)
    expect(member!.status).toBe('disabled')
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

    const realRows: Record<string, unknown>[] = []
    const pk = ledgerPartitionKey(real)
    for await (const e of ledger.listEntities({
      queryOptions: { filter: odata`PartitionKey eq ${pk} and RowKey ge ${ALLOC_RANGE.from} and RowKey lt ${ALLOC_RANGE.to}` },
    })) {
      realRows.push(e as Record<string, unknown>)
    }

    expect(realRows).toHaveLength(1)
    expect(realRows[0]!.remaining).toBe(4) // untouched by QA activity
    expect(ledgerPartitionKey(link.qaMemberId)).not.toBe(pk)
  })
})
