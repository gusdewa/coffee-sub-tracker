import { odata, type TableClient, type TransactionAction } from '@azure/data-tables'

import {
  ledgerPartitionKey,
  transactionRowKey,
  reversalSentinelRowKey,
  idempotencyRowKey,
  assertValidOpId,
  ALLOC_RANGE,
} from '../storage/keys.js'
import { isConflict, isNotFound, isPreconditionFailed } from '../storage/tableClient.js'
import { StorageConflictError, MAX_ATTEMPTS } from './consume.js'

/**
 * Reverse a consumption within a short window.
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

export const UNDO_WINDOW_SECONDS = Number(process.env.UNDO_WINDOW_SECONDS ?? 90)

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

export interface UndoDeps {
  ledger: TableClient
  now?: () => Date
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
  const ageSeconds = (now().getTime() - createdAt.getTime()) / 1000
  if (ageSeconds > UNDO_WINDOW_SECONDS) throw new UndoWindowExpiredError()

  const allocRowKey = String(txn.allocRowKey)

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const alloc = (await ledger.getEntity(partitionKey, allocRowKey)) as Record<string, unknown>
    const consumed = Number(alloc.consumed ?? 0)
    const remaining = Number(alloc.remaining ?? 0)

    const at = now()
    const reversalTxnRowKey = transactionRowKey(at, undoOpId)

    // Total across the partition, with this restoration applied.
    let remainingTotal = 1
    for await (const e of ledger.listEntities({
      queryOptions: {
        filter: odata`PartitionKey eq ${partitionKey} and RowKey ge ${ALLOC_RANGE.from} and RowKey lt ${ALLOC_RANGE.to}`,
      },
    })) {
      remainingTotal += Number((e as Record<string, unknown>).remaining ?? 0)
    }

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
    ]

    try {
      await ledger.submitTransaction(actions)
      return result
    } catch (err) {
      if (isConflict(err)) {
        // Either this undo op already ran, or the drink was already reversed.
        const mine = await readStoredResult(ledger, partitionKey, undoOpId)
        if (mine) return mine
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
