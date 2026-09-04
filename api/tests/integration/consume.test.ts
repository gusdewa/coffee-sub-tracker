import { describe, test, beforeAll, beforeEach, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { odata, type TableClient } from '@azure/data-tables'

import { createTableClient, ensureTablesExist, azuriteConnectionString } from '../../src/storage/tableClient.js'
import { TABLES } from '../../src/storage/entities.js'
import {
  ledgerPartitionKey,
  allocationRowKey,
  ALLOC_RANGE,
  TXN_RANGE,
  prefixRange,
} from '../../src/storage/keys.js'
import { consumeOne, NoBalanceError } from '../../src/domain/consume.js'

process.env.AZURE_TABLES_CONNECTION_STRING ??= azuriteConnectionString()

let ledger: TableClient

/** A fresh member id per test keeps partitions isolated without dropping tables. */
function newMemberId(): string {
  return `T${randomUUID().replace(/-/g, '').toUpperCase().slice(0, 25)}`
}

async function seedAllocation(
  memberId: string,
  opts: { effectiveAt: string; batchId: string; granted: number; consumed?: number; label?: string },
): Promise<string> {
  const effectiveAt = new Date(opts.effectiveAt)
  const rowKey = allocationRowKey(effectiveAt, opts.batchId)
  const consumed = opts.consumed ?? 0
  await ledger.createEntity({
    partitionKey: ledgerPartitionKey(memberId),
    rowKey,
    kind: 'allocation',
    batchId: opts.batchId,
    batchLabel: opts.label ?? 'test batch',
    granted: opts.granted,
    consumed,
    remaining: opts.granted - consumed,
    effectiveAt,
  })
  return rowKey
}

async function readRows(memberId: string, range: { from: string; to: string }) {
  const pk = ledgerPartitionKey(memberId)
  const out = []
  const iter = ledger.listEntities({
    queryOptions: {
      filter: odata`PartitionKey eq ${pk} and RowKey ge ${range.from} and RowKey lt ${range.to}`,
    },
  })
  for await (const e of iter) out.push(e as Record<string, unknown>)
  return out
}

const allocations = (m: string) => readRows(m, ALLOC_RANGE)
const transactions = (m: string) => readRows(m, TXN_RANGE)
const idempotencyRows = (m: string) => readRows(m, prefixRange('I'))

beforeAll(async () => {
  await ensureTablesExist()
  ledger = createTableClient(TABLES.ledger)
})

describe('FIFO consumption (plan §4.1)', () => {
  let member: string
  beforeEach(() => {
    member = newMemberId()
  })

  test('drains the oldest allocation first and leaves newer batches untouched', async () => {
    const oldKey = await seedAllocation(member, {
      effectiveAt: '2026-01-01T00:00:00Z', batchId: 'BATCHOLD', granted: 2,
    })
    const newKey = await seedAllocation(member, {
      effectiveAt: '2026-06-01T00:00:00Z', batchId: 'BATCHNEW', granted: 5,
    })

    const first = await consumeOne({ ledger }, member, randomUUID())
    expect(first.allocRowKey).toBe(oldKey)
    expect(first.remainingTotal).toBe(6)

    const rows = await allocations(member)
    const older = rows.find((r) => r.rowKey === oldKey)!
    const newer = rows.find((r) => r.rowKey === newKey)!
    expect(older.remaining).toBe(1)
    expect(older.consumed).toBe(1)
    expect(newer.remaining).toBe(5) // untouched until the first is exhausted
  })

  test('moves to the next batch only once the oldest is exhausted', async () => {
    await seedAllocation(member, { effectiveAt: '2026-01-01T00:00:00Z', batchId: 'BATCHOLD', granted: 1 })
    const newKey = await seedAllocation(member, {
      effectiveAt: '2026-06-01T00:00:00Z', batchId: 'BATCHNEW', granted: 1,
    })

    await consumeOne({ ledger }, member, randomUUID())
    const second = await consumeOne({ ledger }, member, randomUUID())

    expect(second.allocRowKey).toBe(newKey)
    expect(second.remainingTotal).toBe(0)
  })

  test('two batches with the same instant fall back to batchId deterministically', async () => {
    const a = await seedAllocation(member, { effectiveAt: '2026-03-03T03:03:03Z', batchId: 'AAAA', granted: 1 })
    await seedAllocation(member, { effectiveAt: '2026-03-03T03:03:03Z', batchId: 'BBBB', granted: 1 })
    const first = await consumeOne({ ledger }, member, randomUUID())
    expect(first.allocRowKey).toBe(a)
  })

  test('zero balance is refused and writes nothing at all', async () => {
    await seedAllocation(member, {
      effectiveAt: '2026-01-01T00:00:00Z', batchId: 'SPENT', granted: 3, consumed: 3,
    })

    await expect(consumeOne({ ledger }, member, randomUUID())).rejects.toBeInstanceOf(NoBalanceError)

    expect(await transactions(member)).toHaveLength(0)
    expect(await idempotencyRows(member)).toHaveLength(0)
    const rows = await allocations(member)
    expect(rows[0]!.remaining).toBe(0)
    expect(rows[0]!.consumed).toBe(3) // untouched
  })

  test('a member with no allocations at all is refused', async () => {
    await expect(consumeOne({ ledger }, member, randomUUID())).rejects.toBeInstanceOf(NoBalanceError)
  })

  test('writes exactly one audit transaction per drink', async () => {
    await seedAllocation(member, { effectiveAt: '2026-01-01T00:00:00Z', batchId: 'B1', granted: 3 })
    await consumeOne({ ledger }, member, randomUUID())
    await consumeOne({ ledger }, member, randomUUID())

    const txns = await transactions(member)
    expect(txns).toHaveLength(2)
    for (const t of txns) {
      expect(t.type).toBe('CONSUME')
      expect(t.delta).toBe(-1)
      expect(t.subjectMemberId).toBe(member)
    }
  })
})

describe('idempotency — a retry is not a second drink (plan §4.1)', () => {
  let member: string
  beforeEach(async () => {
    member = newMemberId()
    await seedAllocation(member, { effectiveAt: '2026-01-01T00:00:00Z', batchId: 'B1', granted: 10 })
  })

  test('replaying the same opId returns the original result and consumes nothing more', async () => {
    const opId = randomUUID()
    const at = new Date('2026-09-04T10:00:00.000Z')
    const first = await consumeOne({ ledger, now: () => at, undoWindowSeconds: 37 }, member, opId)
    const second = await consumeOne(
      { ledger, now: () => new Date('2026-09-04T11:00:00.000Z'), undoWindowSeconds: 999 },
      member,
      opId,
    )

    expect(first.replayed).toBe(false)
    expect(second.replayed).toBe(true)
    expect(second.txnRowKey).toBe(first.txnRowKey)
    expect(second.remainingTotal).toBe(first.remainingTotal)
    expect(first.createdAt).toBe('2026-09-04T10:00:00.000Z')
    expect(first.undoExpiresAt).toBe('2026-09-04T10:00:37.000Z')
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.undoExpiresAt).toBe(first.undoExpiresAt)

    expect(await transactions(member)).toHaveLength(1)
    const rows = await allocations(member)
    expect(rows[0]!.remaining).toBe(9)
  })

  test('20 parallel deliveries of ONE opId produce exactly one transaction', async () => {
    const opId = randomUUID()
    const results = await Promise.all(
      Array.from({ length: 20 }, () => consumeOne({ ledger }, member, opId)),
    )

    expect(await transactions(member)).toHaveLength(1)
    const rows = await allocations(member)
    expect(rows[0]!.remaining).toBe(9)
    expect(rows[0]!.consumed).toBe(1)

    // Every caller must observe the same outcome, whoever won the race.
    const txnKeys = new Set(results.map((r) => r.txnRowKey))
    expect(txnKeys.size).toBe(1)
  })
})

describe('simultaneous taps — distinct intents each count (plan §4.1)', () => {
  test('N parallel distinct opIds against N units yield exactly N transactions', async () => {
    const member = newMemberId()
    const N = 8
    await seedAllocation(member, { effectiveAt: '2026-01-01T00:00:00Z', batchId: 'B1', granted: N })

    const results = await Promise.all(
      Array.from({ length: N }, () => consumeOne({ ledger }, member, randomUUID())),
    )

    expect(results).toHaveLength(N)
    expect(await transactions(member)).toHaveLength(N)

    const rows = await allocations(member)
    expect(rows[0]!.remaining).toBe(0)
    expect(rows[0]!.consumed).toBe(N)

    // Each concurrent caller must have been given a distinct ledger row.
    expect(new Set(results.map((r) => r.txnRowKey)).size).toBe(N)
  })

  test('over-subscription cannot drive the balance negative', async () => {
    const member = newMemberId()
    const units = 5
    const attempts = 12
    await seedAllocation(member, { effectiveAt: '2026-01-01T00:00:00Z', batchId: 'B1', granted: units })

    const settled = await Promise.allSettled(
      Array.from({ length: attempts }, () => consumeOne({ ledger }, member, randomUUID())),
    )
    const ok = settled.filter((s) => s.status === 'fulfilled')
    const refused = settled.filter(
      (s) => s.status === 'rejected' && s.reason instanceof NoBalanceError,
    )

    expect(ok).toHaveLength(units)
    expect(refused).toHaveLength(attempts - units)

    const rows = await allocations(member)
    expect(rows[0]!.remaining).toBe(0)
    expect(rows[0]!.remaining).toBeGreaterThanOrEqual(0)
    expect(rows[0]!.consumed).toBe(units)
    expect(await transactions(member)).toHaveLength(units)
  })

  test('parallel taps spanning two batches respect FIFO in aggregate', async () => {
    const member = newMemberId()
    await seedAllocation(member, { effectiveAt: '2026-01-01T00:00:00Z', batchId: 'OLD', granted: 3 })
    await seedAllocation(member, { effectiveAt: '2026-06-01T00:00:00Z', batchId: 'NEW', granted: 3 })

    await Promise.all(Array.from({ length: 4 }, () => consumeOne({ ledger }, member, randomUUID())))

    const rows = (await allocations(member)).sort((a, b) =>
      String(a.rowKey).localeCompare(String(b.rowKey)),
    )
    // The older batch must be fully drained before the newer one is touched.
    expect(rows[0]!.remaining).toBe(0)
    expect(rows[1]!.remaining).toBe(2)
  })
})
