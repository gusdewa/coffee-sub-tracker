import { odata, type TableClient, type TransactionAction } from '@azure/data-tables'

import {
  ledgerPartitionKey,
  transactionRowKey,
  reversalSentinelRowKey,
  idempotencyRowKey,
  assertValidOpId,
  ALLOC_RANGE,
  TXN_RANGE,
  LATEST_CONSUME_MARKER_ROW_KEY,
} from '../storage/keys.js'
import { isConflict, isNotFound, isPreconditionFailed } from '../storage/tableClient.js'
import { StorageConflictError, MAX_ATTEMPTS } from './consume.js'
import { sameDayUndoDeadline } from './undoPolicy.js'

/**
 * Reverse a consumption during the Jakarta day in which it was recorded,
 * while retaining the original short grace across local midnight.
 *
 * Two design points carry the weight:
 *
 *  - **Nothing is ever mutated.** The original CONSUME row is not flagged as
 *    reversed; instead a sentinel row `R|<originalOpId>` is inserted. "Has this
 *    been undone?" is therefore a point read, and a double undo is refused by
 *    the insert conflict itself rather than by a check that could race.
 *
 *  - **The unit goes back where it came from.** The reversal credits the
 *    allocation named on the original transaction, which stays correct even if
 *    a newer batch has arrived in the meantime.
 */


export class AlreadyUndoneError extends Error {
  readonly code = 'ALREADY_UNDONE'
  constructor() {
    super('That drink has already been undone')
    this.name = 'AlreadyUndoneError'
  }
}

export class UndoWindowExpiredError extends Error {
  readonly code = 'UNDO_WINDOW_EXPIRED'
  constructor() {
    super('The undo window for that drink has closed')
    this.name = 'UndoWindowExpiredError'
  }
}

export class TransactionNotFoundError extends Error {
  readonly code = 'TRANSACTION_NOT_FOUND'
  constructor() {
    super('No such drink for this member')
    this.name = 'TransactionNotFoundError'
  }
}

export class NotReversibleError extends Error {
  readonly code = 'NOT_REVERSIBLE'
  constructor(type: string) {
    super(`A ${type} transaction cannot be undone`)
    this.name = 'NotReversibleError'
  }
}

export class NotLatestConsumeError extends Error {
  readonly code = 'NOT_LATEST_CONSUME'
  constructor() {
    super('Only the latest drink can be undone')
    this.name = 'NotLatestConsumeError'
  }
}

export interface UndoDeps {
  ledger: TableClient
  now?: () => Date
  /** Short grace retained across the Jakarta midnight boundary. */
  undoWindowSeconds?: number
}

export interface UndoResult {
  opId: string
  reversalTxnRowKey: string
  reversesOpId: string
  restoredAllocRowKey: string
  remainingTotal: number
  replayed: boolean
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface LatestConsumeMarker {
  latestOpId: string
  activeOpId: string
  etag?: string
}

async function readLatestConsumeMarker(
  ledger: TableClient,
  partitionKey: string,
): Promise<LatestConsumeMarker | undefined> {
  try {
    const row = await ledger.getEntity(partitionKey, LATEST_CONSUME_MARKER_ROW_KEY)
    const record = row as Record<string, unknown>
    return {
      latestOpId: String(record.latestOpId ?? ''),
      activeOpId: String(record.activeOpId ?? ''),
      etag: String(record.etag),
    }
  } catch (err) {
    if (isNotFound(err)) return undefined
    throw err
  }
}

/** Derive the marker state for partitions written before markers existed. */
async function deriveLatestConsumeMarker(
  ledger: TableClient,
  partitionKey: string,
): Promise<LatestConsumeMarker | undefined> {
  let latestOpId: string | undefined
  let latestCreatedAt: string | undefined
  let ambiguousLatest = false
  const reversed = new Set<string>()
  for await (const entity of ledger.listEntities({
    queryOptions: {
      filter: odata`PartitionKey eq ${partitionKey} and RowKey ge ${TXN_RANGE.from} and RowKey lt ${TXN_RANGE.to}`,
    },
  })) {
    const row = entity as Record<string, unknown>
    if (row.type === 'CONSUME') {
      const createdAt = String(row.createdAt ?? '')
      if (latestOpId === undefined) {
        latestOpId = String(row.opId ?? '')
        latestCreatedAt = createdAt
      } else if (createdAt === latestCreatedAt && String(row.opId ?? '') !== latestOpId) {
        // Markerless rows with equal timestamps have no authoritative commit
        // order: RowKey falls back to opId. Fail closed.
        ambiguousLatest = true
      }
    }
    if (row.type === 'REVERSAL') reversed.add(String(row.reversesOpId ?? ''))
  }
  if (latestOpId === undefined || ambiguousLatest) return undefined
  return {
    latestOpId,
    activeOpId: reversed.has(latestOpId) ? '' : latestOpId,
  }
}

async function readStoredResult(
  ledger: TableClient,
  partitionKey: string,
  opId: string,
): Promise<UndoResult | undefined> {
  try {
    const row = await ledger.getEntity(partitionKey, idempotencyRowKey(opId))
    const stored = JSON.parse(String((row as Record<string, unknown>).resultJson)) as UndoResult
    return { ...stored, replayed: true }
  } catch (err) {
    if (isNotFound(err)) return undefined
    throw err
  }
}

export async function undoConsume(
  deps: UndoDeps,
  memberId: string,
  originalOpId: string,
  undoOpId: string,
): Promise<UndoResult> {
  assertValidOpId(originalOpId)
  assertValidOpId(undoOpId)
  const { ledger } = deps
  const now = deps.now ?? (() => new Date())
  const partitionKey = ledgerPartitionKey(memberId)

  const replay = await readStoredResult(ledger, partitionKey, undoOpId)
  if (replay) return replay

  // Resolve the original drink *within the caller's own partition*. A member
  // naming someone else's operation id simply finds nothing — cross-user undo
  // is impossible by addressing, not by a permission check.
  let originalTxnRowKey: string
  try {
    const idem = await ledger.getEntity(partitionKey, idempotencyRowKey(originalOpId))
    originalTxnRowKey = String((idem as Record<string, unknown>).txnRowKey)
  } catch (err) {
    if (isNotFound(err)) throw new TransactionNotFoundError()
    throw err
  }

  const txn = (await ledger
    .getEntity(partitionKey, originalTxnRowKey)
    .catch((err: unknown) => {
      if (isNotFound(err)) throw new TransactionNotFoundError()
      throw err
    })) as Record<string, unknown>

  const type = String(txn.type)
  if (type !== 'CONSUME') throw new NotReversibleError(type)
  if (String(txn.subjectMemberId) !== memberId) throw new TransactionNotFoundError()

  const createdAt = new Date(String(txn.createdAt))
  // Old rows persisted only the short deadline. Taking the later of that and
  // Jakarta end-of-day upgrades today's existing drinks without losing the
  // original cross-midnight grace.
  const shortDeadline = txn.undoExpiresAt
    ? new Date(String(txn.undoExpiresAt))
    : new Date(createdAt.getTime() + (deps.undoWindowSeconds ?? 90) * 1000)
  const deadline = sameDayUndoDeadline(createdAt, shortDeadline)

  const allocRowKey = String(txn.allocRowKey)

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const storedMarker = await readLatestConsumeMarker(ledger, partitionKey)
    const marker = storedMarker ?? await deriveLatestConsumeMarker(ledger, partitionKey)
    // The original transaction was resolved above, so absence here means the
    // ledger is inconsistent rather than permission to bypass latest-only.
    if (!marker || marker.latestOpId !== originalOpId) throw new NotLatestConsumeError()
    if (marker.activeOpId !== originalOpId) throw new AlreadyUndoneError()

    const alloc = (await ledger.getEntity(partitionKey, allocRowKey)) as Record<string, unknown>
    const consumed = Number(alloc.consumed ?? 0)
    const remaining = Number(alloc.remaining ?? 0)

    // Total across the partition, with this restoration applied.
    let remainingTotal = 1
    for await (const e of ledger.listEntities({
      queryOptions: {
        filter: odata`PartitionKey eq ${partitionKey} and RowKey ge ${ALLOC_RANGE.from} and RowKey lt ${ALLOC_RANGE.to}`,
      },
    })) {
      remainingTotal += Number((e as Record<string, unknown>).remaining ?? 0)
    }

    // Sample time exactly once per attempt, after all retryable reads and just
    // before constructing/submitting the write. The same instant determines
    // eligibility and row keys, so a retry cannot cross the deadline and still
    // reverse the drink or produce unstable timestamps within an attempt.
    const at = now()
    if (at.getTime() > deadline.getTime()) throw new UndoWindowExpiredError()
    const reversalTxnRowKey = transactionRowKey(at, undoOpId)

    const result: UndoResult = {
      opId: undoOpId,
      reversalTxnRowKey,
      reversesOpId: originalOpId,
      restoredAllocRowKey: allocRowKey,
      remainingTotal,
      replayed: false,
    }

    const actions: TransactionAction[] = [
      // The sentinel goes first: it is the thing that makes a second undo impossible.
      [
        'create',
        {
          partitionKey,
          rowKey: reversalSentinelRowKey(originalOpId),
          kind: 'reversal-sentinel',
          reversalOpId: undoOpId,
          createdAt: at,
        },
      ],
      [
        'create',
        {
          partitionKey,
          rowKey: reversalTxnRowKey,
          kind: 'transaction',
          type: 'REVERSAL',
          delta: 1,
          allocRowKey,
          batchId: String(txn.batchId ?? ''),
          batchLabel: String(txn.batchLabel ?? ''),
          opId: undoOpId,
          actorMemberId: memberId,
          subjectMemberId: memberId,
          reversesOpId: originalOpId,
          createdAt: at,
        },
      ],
      [
        'update',
        { partitionKey, rowKey: allocRowKey, consumed: consumed - 1, remaining: remaining + 1 },
        'Merge',
        { etag: String(alloc.etag) },
      ],
      [
        'create',
        {
          partitionKey,
          rowKey: idempotencyRowKey(undoOpId),
          kind: 'idempotency',
          txnRowKey: reversalTxnRowKey,
          statusCode: 200,
          resultJson: JSON.stringify(result),
          createdAt: at,
        },
      ],
      storedMarker
        ? [
            'update',
            {
              partitionKey,
              rowKey: LATEST_CONSUME_MARKER_ROW_KEY,
              kind: 'latest-consume-marker',
              latestOpId: originalOpId,
              activeOpId: '',
              updatedAt: at,
            },
            'Merge',
            { etag: storedMarker.etag as string },
          ]
        : [
            'create',
            {
              partitionKey,
              rowKey: LATEST_CONSUME_MARKER_ROW_KEY,
              kind: 'latest-consume-marker',
              latestOpId: originalOpId,
              activeOpId: '',
              updatedAt: at,
            },
          ],
    ]

    try {
      await ledger.submitTransaction(actions)
      return result
    } catch (err) {
      if (isConflict(err)) {
        const mine = await readStoredResult(ledger, partitionKey, undoOpId)
        if (mine) return mine
        // On a legacy partition, a concurrent Drink or Undo may have won the
        // marker create. Retry so its marker state determines the right error.
        if (!storedMarker && await readLatestConsumeMarker(ledger, partitionKey)) {
          if (attempt === MAX_ATTEMPTS) throw new StorageConflictError(MAX_ATTEMPTS)
          await sleep(Math.random() * 25 * 2 ** (attempt - 1))
          continue
        }
        throw new AlreadyUndoneError()
      }
      if (isPreconditionFailed(err)) {
        if (attempt === MAX_ATTEMPTS) throw new StorageConflictError(MAX_ATTEMPTS)
        await sleep(Math.random() * 25 * 2 ** (attempt - 1))
        continue
      }
      throw err
    }
  }

  throw new StorageConflictError(MAX_ATTEMPTS)
}
