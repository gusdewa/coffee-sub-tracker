import { describe, test, beforeAll, beforeEach, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { odata, type TableClient } from '@azure/data-tables'

import { createTableClient, ensureTablesExist, azuriteConnectionString } from '../../src/storage/tableClient.js'
import { TABLES } from '../../src/storage/entities.js'
import { ledgerPartitionKey, allocationRowKey, ALLOC_RANGE, TXN_RANGE, prefixRange } from '../../src/storage/keys.js'
import { consumeOne } from '../../src/domain/consume.js'
import {
  undoConsume,
  AlreadyUndoneError,
  UndoWindowExpiredError,
  TransactionNotFoundError,
  UNDO_WINDOW_SECONDS,
} from '../../src/domain/undo.js'

process.env.AZURE_TABLES_CONNECTION_STRING ??= azuriteConnectionString()

let ledger: TableClient

function newMemberId(): string {
  return `U${randomUUID().replace(/-/g, '').toUpperCase().slice(0, 25)}`
}

async function seed(memberId: string, granted: number, batchId = 'B1'): Promise<string> {
  const effectiveAt = new Date('2026-01-01T00:00:00Z')
  const rowKey = allocationRowKey(effectiveAt, batchId)
  await ledger.createEntity({
    partitionKey: ledgerPartitionKey(memberId),
    rowKey,
    kind: 'allocation',
    batchId,
    batchLabel: 'seed',
    granted,
    consumed: 0,
    remaining: granted,
    effectiveAt,
  })
  return rowKey
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

beforeAll(async () => {
  await ensureTablesExist()
  ledger = createTableClient(TABLES.ledger)
})

describe('Undo writes a reversal and never mutates history (plan §4.2)', () => {
  let member: string
  beforeEach(async () => {
    member = newMemberId()
    await seed(member, 5)
  })

  test('restores the unit to the original allocation', async () => {
    const drink = await consumeOne({ ledger }, member, randomUUID())
    const before = await rows(member, ALLOC_RANGE)
    expect(before[0]!.remaining).toBe(4)

    const result = await undoConsume({ ledger }, member, drink.opId, randomUUID())
    expect(result.restoredAllocRowKey).toBe(drink.allocRowKey)
    expect(result.remainingTotal).toBe(5)

    const after = await rows(member, ALLOC_RANGE)
    expect(after[0]!.remaining).toBe(5)
    expect(after[0]!.consumed).toBe(0)
  })

  test('appends a REVERSAL row and leaves the original CONSUME row byte-identical', async () => {
    const drink = await consumeOne({ ledger }, member, randomUUID())
    const originalTxn = (await rows(member, TXN_RANGE)).find((t) => t.rowKey === drink.txnRowKey)!
    const originalEtag = originalTxn.etag

    await undoConsume({ ledger }, member, drink.opId, randomUUID())

    const txns = await rows(member, TXN_RANGE)
    expect(txns).toHaveLength(2)

    const consume = txns.find((t) => t.rowKey === drink.txnRowKey)!
    const reversal = txns.find((t) => t.type === 'REVERSAL')!

    // Append-only: the original row must be untouched, proven by its ETag.
    expect(consume.etag).toBe(originalEtag)
    expect(consume.type).toBe('CONSUME')
    expect(consume.delta).toBe(-1)

    expect(reversal.delta).toBe(1)
    expect(reversal.reversesOpId).toBe(drink.opId)
    expect(reversal.allocRowKey).toBe(drink.allocRowKey)
  })

  test('the reversal returns the unit to the batch it came from, not the newest', async () => {
    const other = newMemberId()
    await seed(other, 1, 'OLD')
    // Give this member an older batch and drink from it, then add a newer batch.
    const oldKey = await seed(member, 1, 'AAAOLD')
    const drink = await consumeOne({ ledger }, member, randomUUID())
    expect(drink.allocRowKey).toBe(oldKey)

    const undone = await undoConsume({ ledger }, member, drink.opId, randomUUID())
    expect(undone.restoredAllocRowKey).toBe(oldKey)

    const all = await rows(member, ALLOC_RANGE)
    const restored = all.find((r) => r.rowKey === oldKey)!
    expect(restored.remaining).toBe(1)
  })

  test('a second undo is refused atomically by the sentinel insert', async () => {
    const drink = await consumeOne({ ledger }, member, randomUUID())
    await undoConsume({ ledger }, member, drink.opId, randomUUID())

    await expect(
      undoConsume({ ledger }, member, drink.opId, randomUUID()),
    ).rejects.toBeInstanceOf(AlreadyUndoneError)

    // Still exactly one reversal, and the balance did not creep upward.
    const txns = await rows(member, TXN_RANGE)
    expect(txns.filter((t) => t.type === 'REVERSAL')).toHaveLength(1)
    expect((await rows(member, ALLOC_RANGE))[0]!.remaining).toBe(5)
  })

  test('concurrent double-undo yields exactly one reversal', async () => {
    const drink = await consumeOne({ ledger }, member, randomUUID())

    const settled = await Promise.allSettled(
      Array.from({ length: 6 }, () => undoConsume({ ledger }, member, drink.opId, randomUUID())),
    )
    const ok = settled.filter((s) => s.status === 'fulfilled')
    expect(ok).toHaveLength(1)

    const txns = await rows(member, TXN_RANGE)
    expect(txns.filter((t) => t.type === 'REVERSAL')).toHaveLength(1)
    expect((await rows(member, ALLOC_RANGE))[0]!.remaining).toBe(5)
  })

  test('undo is itself idempotent under its own operation id', async () => {
    const drink = await consumeOne({ ledger }, member, randomUUID())
    const undoOp = randomUUID()

    const first = await undoConsume({ ledger }, member, drink.opId, undoOp)
    const second = await undoConsume({ ledger }, member, drink.opId, undoOp)

    expect(second.replayed).toBe(true)
    expect(second.reversalTxnRowKey).toBe(first.reversalTxnRowKey)
    expect((await rows(member, ALLOC_RANGE))[0]!.remaining).toBe(5)
  })

  test('refuses after the undo window closes', async () => {
    const drink = await consumeOne({ ledger }, member, randomUUID())
    const wayLater = () => new Date(Date.now() + (UNDO_WINDOW_SECONDS + 5) * 1000)

    await expect(
      undoConsume({ ledger, now: wayLater }, member, drink.opId, randomUUID()),
    ).rejects.toBeInstanceOf(UndoWindowExpiredError)

    expect((await rows(member, ALLOC_RANGE))[0]!.remaining).toBe(4) // unchanged
  })

  test('an unknown operation id is refused', async () => {
    await expect(
      undoConsume({ ledger }, member, randomUUID(), randomUUID()),
    ).rejects.toBeInstanceOf(TransactionNotFoundError)
  })
})

describe('cross-user denial (plan acceptance 8)', () => {
  test('one member cannot undo another member’s drink', async () => {
    const victim = newMemberId()
    const attacker = newMemberId()
    await seed(victim, 3)
    await seed(attacker, 3)

    const victimDrink = await consumeOne({ ledger }, victim, randomUUID())

    // The attacker names the victim's opId. Identity comes from the caller, so
    // the lookup happens in the attacker's own partition and finds nothing.
    await expect(
      undoConsume({ ledger }, attacker, victimDrink.opId, randomUUID()),
    ).rejects.toBeInstanceOf(TransactionNotFoundError)

    const victimAllocs = await rows(victim, ALLOC_RANGE)
    expect(victimAllocs[0]!.remaining).toBe(2) // still spent
    expect(await rows(victim, prefixRange('R'))).toHaveLength(0)
  })
})
