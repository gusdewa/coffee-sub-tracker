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
  LATEST_CONSUME_MARKER_ROW_KEY,
} from '../../src/storage/keys.js'
import { consumeOne } from '../../src/domain/consume.js'
import { getMyCoffee } from '../../src/domain/readModels.js'
import {
  undoConsume,
  AlreadyUndoneError,
  UndoWindowExpiredError,
  TransactionNotFoundError,
  NotLatestConsumeError,
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

  test('refuses an older drink while a newer drink exists', async () => {
    const older = await consumeOne(
      { ledger, now: () => new Date('2026-09-04T01:00:00.000Z') }, member, 'older-active',
    )
    await consumeOne(
      { ledger, now: () => new Date('2026-09-04T02:00:00.000Z') }, member, 'newer-active',
    )

    await expect(undoConsume(
      { ledger, now: () => new Date('2026-09-04T03:00:00.000Z') },
      member, older.opId, 'undo-older-active',
    )).rejects.toBeInstanceOf(NotLatestConsumeError)

    expect((await rows(member, TXN_RANGE)).filter((r) => r.type === 'REVERSAL')).toHaveLength(0)
    expect((await rows(member, ALLOC_RANGE))[0]!.remaining).toBe(3)
  })

  test('does not make an older drink eligible after the newer drink is reversed', async () => {
    const older = await consumeOne(
      { ledger, now: () => new Date('2026-09-04T01:00:00.000Z') }, member, 'older-before-reversal',
    )
    const newer = await consumeOne(
      { ledger, now: () => new Date('2026-09-04T02:00:00.000Z') }, member, 'newer-before-reversal',
    )
    await undoConsume(
      { ledger, now: () => new Date('2026-09-04T03:00:00.000Z') },
      member, newer.opId, 'undo-newer-first',
    )

    await expect(undoConsume(
      { ledger, now: () => new Date('2026-09-04T04:00:00.000Z') },
      member, older.opId, 'undo-older-afterward',
    )).rejects.toBeInstanceOf(NotLatestConsumeError)

    expect((await rows(member, TXN_RANGE)).filter((r) => r.type === 'REVERSAL')).toHaveLength(1)
    expect((await rows(member, ALLOC_RANGE))[0]!.remaining).toBe(4)
  })

  test('serializes a concurrent newer Drink against Undo of the older drink', async () => {
    const older = await consumeOne(
      { ledger, now: () => new Date('2026-09-04T01:00:00.000Z') }, member, 'race-older',
    )

    const [drinkOutcome, undoOutcome] = await Promise.allSettled([
      consumeOne(
        { ledger, now: () => new Date('2026-09-04T02:00:00.000Z') }, member, 'race-newer',
      ),
      undoConsume(
        { ledger, now: () => new Date('2026-09-04T03:00:00.000Z') },
        member, older.opId, 'race-undo-older',
      ),
    ])

    expect(drinkOutcome.status).toBe('fulfilled')
    if (undoOutcome.status === 'rejected') {
      expect(undoOutcome.reason).toBeInstanceOf(NotLatestConsumeError)
    }
    const marker = await ledger.getEntity(
      ledgerPartitionKey(member), LATEST_CONSUME_MARKER_ROW_KEY,
    ) as Record<string, unknown>
    expect(marker.latestOpId).toBe('race-newer')
    expect(marker.activeOpId).toBe('race-newer')

    const txns = await rows(member, TXN_RANGE)
    expect(txns.filter((row) => row.opId === 'race-newer')).toHaveLength(1)
    expect(txns.filter((row) => row.type === 'REVERSAL')).toHaveLength(
      undoOutcome.status === 'fulfilled' ? 1 : 0,
    )
    expect((await rows(member, ALLOC_RANGE))[0]!.remaining).toBe(
      undoOutcome.status === 'fulfilled' ? 4 : 3,
    )

    await expect(undoConsume(
      { ledger, now: () => new Date('2026-09-04T04:00:00.000Z') },
      member, older.opId, 'race-undo-older-again',
    )).rejects.toBeInstanceOf(NotLatestConsumeError)
  })

  test('bootstraps a marker atomically when undoing a legacy same-day latest drink', async () => {
    const drink = await consumeOne(
      { ledger, now: () => new Date('2026-09-04T08:00:00.000Z') }, member, 'legacy-latest',
    )
    await ledger.deleteEntity(ledgerPartitionKey(member), LATEST_CONSUME_MARKER_ROW_KEY)

    await expect(undoConsume(
      { ledger, now: () => new Date('2026-09-04T15:00:00.000Z') },
      member, drink.opId, 'undo-legacy-latest',
    )).resolves.toMatchObject({ reversesOpId: drink.opId, remainingTotal: 5 })

    const marker = await ledger.getEntity(
      ledgerPartitionKey(member), LATEST_CONSUME_MARKER_ROW_KEY,
    ) as Record<string, unknown>
    expect(marker.latestOpId).toBe(drink.opId)
    expect(marker.activeOpId).toBe('')
  })

  test('fails closed for markerless same-millisecond legacy drinks', async () => {
    const at = new Date('2026-09-04T08:00:00.000Z')
    const older = await consumeOne({ ledger, now: () => at }, member, 'A-legacy-older')
    const newer = await consumeOne({ ledger, now: () => at }, member, 'Z-legacy-newer')
    await ledger.deleteEntity(ledgerPartitionKey(member), LATEST_CONSUME_MARKER_ROW_KEY)

    for (const drink of [older, newer]) {
      await expect(undoConsume(
        { ledger, now: () => new Date('2026-09-04T09:00:00.000Z') },
        member, drink.opId, `undo-${drink.opId}`,
      )).rejects.toBeInstanceOf(NotLatestConsumeError)
    }
    expect((await getMyCoffee(
      { ledger, now: () => new Date('2026-09-04T09:00:00.000Z') }, member,
    )).undoOffer).toBeNull()
  })

  test('still allows this morning’s drink to be put back after the old 90-second window', async () => {
    const createdAt = new Date('2026-09-04T10:00:00.000Z')
    const drink = await consumeOne(
      { ledger, now: () => createdAt, undoWindowSeconds: 90 }, member, randomUUID(),
    )
    const wayLater = () => new Date('2026-09-04T15:00:00.000Z') // 22:00 Jakarta

    await expect(
      undoConsume({ ledger, now: wayLater, undoWindowSeconds: 90 }, member, drink.opId, randomUUID()),
    ).resolves.toMatchObject({ reversesOpId: drink.opId, remainingTotal: 5 })
  })

  test('refuses a drink after its Jakarta calendar day has ended', async () => {
    const createdAt = new Date('2026-09-04T16:30:00.000Z') // 23:30 Jakarta
    const drink = await consumeOne({ ledger, now: () => createdAt }, member, randomUUID())

    await expect(
      undoConsume(
        { ledger, now: () => new Date('2026-09-04T17:02:00.000Z') }, // 00:02 Jakarta
        member, drink.opId, randomUUID(),
      ),
    ).rejects.toBeInstanceOf(UndoWindowExpiredError)
  })

  test('keeps the original short grace when a drink crosses Jakarta midnight', async () => {
    const createdAt = new Date('2026-09-04T16:59:30.000Z') // 23:59:30 Jakarta
    const drink = await consumeOne(
      { ledger, now: () => createdAt, undoWindowSeconds: 90 }, member, randomUUID(),
    )
    const result = await undoConsume(
      { ledger, now: () => new Date('2026-09-04T17:00:15.000Z'), undoWindowSeconds: 90 },
      member, drink.opId, randomUUID(),
    )
    expect(result.restoredAllocRowKey).toBe(drink.allocRowKey)
  })

  test('revalidates the deadline after a precondition retry and writes no reversal once expired', async () => {
    const createdAt = new Date('2026-09-04T16:59:30.000Z') // short grace ends 00:01 Jakarta
    const drink = await consumeOne(
      { ledger, now: () => createdAt, undoWindowSeconds: 90 }, member, 'retry-deadline-drink',
    )
    const attemptTimes = [
      new Date('2026-09-04T17:00:30.000Z'),
      new Date('2026-09-04T17:01:00.001Z'),
    ]
    let submitAttempts = 0
    const retryLedger = new Proxy(ledger, {
      get(target, property) {
        if (property === 'submitTransaction') {
          return async () => {
            submitAttempts += 1
            throw { statusCode: 412 }
          }
        }
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as TableClient

    await expect(undoConsume(
      { ledger: retryLedger, now: () => attemptTimes.shift()!, undoWindowSeconds: 90 },
      member, drink.opId, 'retry-deadline-undo',
    )).rejects.toBeInstanceOf(UndoWindowExpiredError)

    expect(submitAttempts).toBe(1)
    expect(attemptTimes).toHaveLength(0)
    expect((await rows(member, TXN_RANGE)).filter((row) => row.type === 'REVERSAL')).toHaveLength(0)
    expect((await rows(member, ALLOC_RANGE))[0]!.remaining).toBe(4)
  })

  test('an unknown operation id is refused', async () => {
    await expect(
      undoConsume({ ledger }, member, randomUUID(), randomUUID()),
    ).rejects.toBeInstanceOf(TransactionNotFoundError)
  })
})

describe('durable Put Back offer', () => {
  test('GET read model rediscovers today’s latest unreversed drink after reload', async () => {
    const member = newMemberId()
    await seed(member, 2)
    const morning = new Date('2026-09-04T08:00:00.000Z')
    const drink = await consumeOne({ ledger, now: () => morning }, member, randomUUID())

    const coffee = await getMyCoffee(
      { ledger, now: () => new Date('2026-09-04T15:00:00.000Z') },
      member,
    )
    expect(coffee.undoOffer).toEqual({
      opId: drink.opId,
      allocRowKey: drink.allocRowKey,
      batchId: drink.batchId,
      batchLabel: drink.batchLabel,
      createdAt: morning.toISOString(),
      undoExpiresAt: '2026-09-04T16:59:59.999Z',
    })
  })

  test('uses the marker when same-millisecond opId order disagrees with consume order', async () => {
    const member = newMemberId()
    await seed(member, 3)
    const at = new Date('2026-09-04T08:00:00.000Z')
    await consumeOne({ ledger, now: () => at }, member, 'A-older')
    const newer = await consumeOne({ ledger, now: () => at }, member, 'Z-newer')

    const coffee = await getMyCoffee(
      { ledger, now: () => new Date('2026-09-04T09:00:00.000Z') }, member,
    )
    expect(coffee.undoOffer?.opId).toBe(newer.opId)

    await expect(undoConsume(
      { ledger, now: () => new Date('2026-09-04T09:00:00.000Z') },
      member, coffee.undoOffer!.opId, 'undo-Z-newer',
    )).resolves.toMatchObject({ reversesOpId: newer.opId, remainingTotal: 2 })
    expect((await rows(member, ALLOC_RANGE))[0]!.remaining).toBe(2)
  })

  test('does not publish an offer when the marker changes during read assembly', async () => {
    const member = newMemberId()
    await seed(member, 2)
    const drink = await consumeOne(
      { ledger, now: () => new Date('2026-09-04T08:00:00.000Z') }, member, 'read-race',
    )
    const pk = ledgerPartitionKey(member)
    let changed = false
    const raceLedger = new Proxy(ledger, {
      get(target, property) {
        if (property === 'getEntity') {
          return async (partitionKey: string, rowKey: string) => {
            const row = await target.getEntity(partitionKey, rowKey)
            if (!changed && rowKey === drink.txnRowKey) {
              changed = true
              await target.updateEntity({
                partitionKey: pk,
                rowKey: LATEST_CONSUME_MARKER_ROW_KEY,
                activeOpId: '',
                updatedAt: new Date('2026-09-04T08:30:00.000Z'),
              }, 'Merge')
            }
            return row
          }
        }
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as TableClient

    const coffee = await getMyCoffee(
      { ledger: raceLedger, now: () => new Date('2026-09-04T09:00:00.000Z') }, member,
    )
    expect(changed).toBe(true)
    expect(coffee.undoOffer).toBeNull()
  })

  test('does not publish legacy history if a marker appears during the scan', async () => {
    const member = newMemberId()
    await seed(member, 2)
    await consumeOne(
      { ledger, now: () => new Date('2026-09-04T08:00:00.000Z') }, member, 'bootstrap-race',
    )
    let markerReads = 0
    const raceLedger = new Proxy(ledger, {
      get(target, property) {
        if (property === 'getEntity') {
          return async (partitionKey: string, rowKey: string) => {
            if (rowKey === LATEST_CONSUME_MARKER_ROW_KEY && markerReads++ === 0) {
              throw { statusCode: 404 }
            }
            return target.getEntity(partitionKey, rowKey)
          }
        }
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as TableClient

    const coffee = await getMyCoffee(
      { ledger: raceLedger, now: () => new Date('2026-09-04T09:00:00.000Z') }, member,
    )
    expect(markerReads).toBe(2)
    expect(coffee.undoOffer).toBeNull()
  })

  test('does not resurrect an immediately reversed drink whose rows share a timestamp', async () => {
    const member = newMemberId()
    await seed(member, 2)
    const at = new Date('2026-09-04T08:00:00.000Z')
    const drink = await consumeOne({ ledger, now: () => at }, member, 'A-consume')
    await undoConsume({ ledger, now: () => at }, member, drink.opId, 'Z-reversal')

    expect((await getMyCoffee(
      { ledger, now: () => new Date('2026-09-04T09:00:00.000Z') }, member,
    )).undoOffer).toBeNull()
  })

  test('does not cascade backward to an older drink after the latest drink is reversed', async () => {
    const member = newMemberId()
    await seed(member, 3)
    await consumeOne(
      { ledger, now: () => new Date('2026-09-04T01:00:00.000Z') }, member, 'older-drink',
    )
    const accidental = await consumeOne(
      { ledger, now: () => new Date('2026-09-04T02:00:00.000Z') }, member, 'latest-drink',
    )
    await undoConsume(
      { ledger, now: () => new Date('2026-09-04T03:00:00.000Z') },
      member, accidental.opId, 'undo-latest',
    )

    expect((await getMyCoffee(
      { ledger, now: () => new Date('2026-09-04T04:00:00.000Z') }, member,
    )).undoOffer).toBeNull()
  })

  test('read model does not offer an already-reversed drink or yesterday’s drink', async () => {
    const reversedMember = newMemberId()
    await seed(reversedMember, 2)
    const morning = new Date('2026-09-04T08:00:00.000Z')
    const drink = await consumeOne({ ledger, now: () => morning }, reversedMember, randomUUID())
    await undoConsume(
      { ledger, now: () => new Date('2026-09-04T12:00:00.000Z') },
      reversedMember, drink.opId, randomUUID(),
    )
    expect((await getMyCoffee(
      { ledger, now: () => new Date('2026-09-04T15:00:00.000Z') }, reversedMember,
    )).undoOffer).toBeNull()

    const oldMember = newMemberId()
    await seed(oldMember, 2)
    await consumeOne({ ledger, now: () => morning }, oldMember, randomUUID())
    expect((await getMyCoffee(
      { ledger, now: () => new Date('2026-09-05T00:00:00.000Z') }, oldMember,
    )).undoOffer).toBeNull()
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
