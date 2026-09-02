import { describe, test, beforeAll, beforeEach, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { odata, type TableClient } from '@azure/data-tables'

import { createTableClient, ensureTablesExist, azuriteConnectionString } from '../../src/storage/tableClient.js'
import { TABLES } from '../../src/storage/entities.js'
import { ledgerPartitionKey, ALLOC_RANGE, TXN_RANGE } from '../../src/storage/keys.js'
import { consumeOne, NoBalanceError } from '../../src/domain/consume.js'
import { createBatch, reprovisionBatch, findBatch, type BatchDeps } from '../../src/domain/batches.js'
import {
  applyCorrection,
  InsufficientBalanceError,
  MissingReasonError,
  InvalidDeltaError,
} from '../../src/domain/correction.js'

process.env.AZURE_TABLES_CONNECTION_STRING ??= azuriteConnectionString()

let ledger: TableClient
let batches: TableClient
let deps: BatchDeps

const ADMIN = 'ADMIN0000000000000000000AA'

function newMemberId(): string {
  return `B${randomUUID().replace(/-/g, '').toUpperCase().slice(0, 25)}`
}

async function rows(memberId: string, range: { from: string; to: string }) {
  const pk = ledgerPartitionKey(memberId)
  const out: Record<string, unknown>[] = []
  for await (const e of ledger.listEntities({
    queryOptions: { filter: odata`PartitionKey eq ${pk} and RowKey ge ${range.from} and RowKey lt ${range.to}` },
  })) {
    out.push(e as Record<string, unknown>)
  }
  return out
}

const totalRemaining = async (m: string) =>
  (await rows(m, ALLOC_RANGE)).reduce((s, r) => s + Number(r.remaining), 0)

beforeAll(async () => {
  await ensureTablesExist()
  ledger = createTableClient(TABLES.ledger)
  batches = createTableClient(TABLES.batches)
  deps = { ledger, batches }
})

describe('batch provisioning across partitions (plan §4.4)', () => {
  test('grants each member their own quota from one batch', async () => {
    const [a, b, c] = [newMemberId(), newMemberId(), newMemberId()]
    const batch = await createBatch(deps, ADMIN, {
      label: 'September beans',
      allocations: [
        { memberId: a, units: 10 },
        { memberId: b, units: 5 },
        { memberId: c, units: 1 },
      ],
    })

    expect(batch.status).toBe('active')
    expect(batch.totalUnits).toBe(16)
    expect(batch.provisionedMemberIds).toHaveLength(3)

    expect(await totalRemaining(a)).toBe(10)
    expect(await totalRemaining(b)).toBe(5)
    expect(await totalRemaining(c)).toBe(1)
  })

  test('history shows the batch name, never a raw id', async () => {
    const m = newMemberId()
    await createBatch(deps, ADMIN, { label: 'September beans', allocations: [{ memberId: m, units: 2 }] })
    await consumeOne({ ledger }, m, randomUUID())

    const { getHistory } = await import('../../src/domain/readModels.js')
    const items = await getHistory({ ledger }, m)
    expect(items.length).toBe(2)
    for (const item of items) {
      expect(item.batchLabel).toBe('September beans')
      // A ULID on screen is meaningless to a person reading their history.
      expect(item.batchLabel).not.toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    }
  })

  test('records a GRANT transaction per member', async () => {
    const m = newMemberId()
    await createBatch(deps, ADMIN, { label: 'Grant audit', allocations: [{ memberId: m, units: 3 }] })

    const txns = await rows(m, TXN_RANGE)
    expect(txns).toHaveLength(1)
    expect(txns[0]!.type).toBe('GRANT')
    expect(txns[0]!.delta).toBe(3)
    expect(txns[0]!.actorMemberId).toBe(ADMIN)
    expect(txns[0]!.subjectMemberId).toBe(m)
  })

  test('overlapping batches stack, and FIFO drains the older one first', async () => {
    const m = newMemberId()
    await createBatch(deps, ADMIN, {
      label: 'Older', effectiveAt: new Date('2026-01-01T00:00:00Z'),
      allocations: [{ memberId: m, units: 2 }],
    })
    await createBatch(deps, ADMIN, {
      label: 'Newer', effectiveAt: new Date('2026-06-01T00:00:00Z'),
      allocations: [{ memberId: m, units: 4 }],
    })

    expect(await totalRemaining(m)).toBe(6)

    const first = await consumeOne({ ledger }, m, randomUUID())
    expect(first.batchLabel).toBe('Older')

    await consumeOne({ ledger }, m, randomUUID())
    const third = await consumeOne({ ledger }, m, randomUUID())
    expect(third.batchLabel).toBe('Newer')
  })

  test('reprovisioning is idempotent and never double-grants', async () => {
    const m = newMemberId()
    const allocations = [{ memberId: m, units: 4 }]
    const batch = await createBatch(deps, ADMIN, { label: 'Repeatable', allocations })

    await reprovisionBatch(deps, ADMIN, batch.batchId, allocations)
    await reprovisionBatch(deps, ADMIN, batch.batchId, allocations)

    expect(await totalRemaining(m)).toBe(4)
    expect(await rows(m, TXN_RANGE)).toHaveLength(1)
  })

  test('a batch interrupted mid-provision converges under reprovision', async () => {
    const done = newMemberId()
    const missed = newMemberId()
    const allocations = [{ memberId: done, units: 2 }, { memberId: missed, units: 7 }]

    // Simulate a crash after the first member: provision only that one.
    const partial = await createBatch(deps, ADMIN, {
      label: 'Interrupted', allocations: [{ memberId: done, units: 2 }],
    })
    expect(await totalRemaining(done)).toBe(2)
    expect(await totalRemaining(missed)).toBe(0)

    await reprovisionBatch(deps, ADMIN, partial.batchId, allocations)

    expect(await totalRemaining(done)).toBe(2) // not doubled
    expect(await totalRemaining(missed)).toBe(7) // repaired
    expect((await findBatch(deps, partial.batchId)).status).toBe('active')
  })

  test('rejects malformed batches before writing anything', async () => {
    const m = newMemberId()
    await expect(createBatch(deps, ADMIN, { label: '', allocations: [{ memberId: m, units: 1 }] }))
      .rejects.toThrow(/label/i)
    await expect(createBatch(deps, ADMIN, { label: 'x', allocations: [] }))
      .rejects.toThrow(/at least one/i)
    await expect(createBatch(deps, ADMIN, { label: 'x', allocations: [{ memberId: m, units: 0 }] }))
      .rejects.toThrow(/positive/i)
    await expect(createBatch(deps, ADMIN, {
      label: 'x', allocations: [{ memberId: m, units: 1 }, { memberId: m, units: 2 }],
    })).rejects.toThrow(/duplicate/i)
    expect(await totalRemaining(m)).toBe(0)
  })
})

describe('admin corrections are audited and bounded (plan §4.3)', () => {
  let member: string
  beforeEach(async () => {
    member = newMemberId()
    await createBatch(deps, ADMIN, { label: 'Base', allocations: [{ memberId: member, units: 5 }] })
  })

  test('a negative correction debits FIFO and is attributed', async () => {
    const res = await applyCorrection({ ledger }, ADMIN, member, -2, 'Spilled two cups', randomUUID())
    expect(res.delta).toBe(-2)
    expect(await totalRemaining(member)).toBe(3)

    const txn = (await rows(member, TXN_RANGE)).find((t) => t.type === 'CORRECTION')!
    expect(txn.reason).toBe('Spilled two cups')
    expect(txn.actorMemberId).toBe(ADMIN)
    expect(txn.subjectMemberId).toBe(member)
  })

  test('a positive correction credits without jumping the FIFO queue', async () => {
    await applyCorrection({ ledger }, ADMIN, member, 3, 'Goodwill top-up', randomUUID())
    expect(await totalRemaining(member)).toBe(8)

    // The original batch must still be drained first.
    const drink = await consumeOne({ ledger }, member, randomUUID())
    expect(drink.batchLabel).toBe('Base')
  })

  test('cannot drive a balance negative', async () => {
    await expect(
      applyCorrection({ ledger }, ADMIN, member, -99, 'typo', randomUUID()),
    ).rejects.toBeInstanceOf(InsufficientBalanceError)

    expect(await totalRemaining(member)).toBe(5) // untouched
    expect((await rows(member, TXN_RANGE)).filter((t) => t.type === 'CORRECTION')).toHaveLength(0)
  })

  test('a debit spanning two allocations commits as one transaction', async () => {
    await createBatch(deps, ADMIN, {
      label: 'Second', effectiveAt: new Date('2027-01-01T00:00:00Z'),
      allocations: [{ memberId: member, units: 4 }],
    })
    expect(await totalRemaining(member)).toBe(9)

    const res = await applyCorrection({ ledger }, ADMIN, member, -7, 'Bulk reconciliation', randomUUID())
    expect(res.touchedAllocRowKeys.length).toBe(2)
    expect(await totalRemaining(member)).toBe(2)
  })

  test('requires a reason and a non-zero whole delta', async () => {
    await expect(applyCorrection({ ledger }, ADMIN, member, -1, '   ', randomUUID()))
      .rejects.toBeInstanceOf(MissingReasonError)
    await expect(applyCorrection({ ledger }, ADMIN, member, 0, 'why', randomUUID()))
      .rejects.toBeInstanceOf(InvalidDeltaError)
    await expect(applyCorrection({ ledger }, ADMIN, member, 1.5, 'why', randomUUID()))
      .rejects.toBeInstanceOf(InvalidDeltaError)
    expect(await totalRemaining(member)).toBe(5)
  })

  test('is idempotent under its operation id', async () => {
    const opId = randomUUID()
    const first = await applyCorrection({ ledger }, ADMIN, member, -2, 'Once only', opId)
    const second = await applyCorrection({ ledger }, ADMIN, member, -2, 'Once only', opId)

    expect(second.replayed).toBe(true)
    expect(second.txnRowKey).toBe(first.txnRowKey)
    expect(await totalRemaining(member)).toBe(3)
  })

  test('a correction to zero leaves the member unable to drink', async () => {
    await applyCorrection({ ledger }, ADMIN, member, -5, 'Reset', randomUUID())
    await expect(consumeOne({ ledger }, member, randomUUID())).rejects.toBeInstanceOf(NoBalanceError)
  })
})
