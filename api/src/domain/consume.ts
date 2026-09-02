import { odata, type TableClient, type TransactionAction } from '@azure/data-tables'

import {
  ledgerPartitionKey,
  transactionRowKey,
  idempotencyRowKey,
  assertValidOpId,
  ALLOC_RANGE,
} from '../storage/keys.js'
import { isConflict, isPreconditionFailed } from '../storage/tableClient.js'

/**
 * Consume exactly one unit from the caller's oldest unfinished allocation.
 *
 * The three guarantees here are structural, not conventional:
 *
 *  - **Non-negativity** comes from the ETag precondition, not from the
 *    `remaining > 0` check. The check picks a candidate; the precondition is
 *    what refuses to commit if anyone touched that row in between. There is no
 *    window in which two writers both spend the last unit.
 *
 *  - **Idempotency** is the insert of `I|<opId>` inside the same transaction.
 *    A duplicate delivery collides on the key and the whole batch fails, so a
 *    retry can never produce a second drink. There is no read-then-check race.
 *
 *  - **Atomicity** comes from all three rows sharing the member's partition,
 *    which is the only scope in which Azure Table Storage offers a transaction.
 *
 * A simultaneous tap and a retried tap are different events and are treated
 * differently: distinct opIds each consume, an identical opId consumes once.
 */

export const MAX_ATTEMPTS = 6
const BACKOFF_BASE_MS = 25

export class NoBalanceError extends Error {
  readonly code = 'NO_BALANCE'
  constructor() {
    super('No drinks remaining')
    this.name = 'NoBalanceError'
  }
}

export class StorageConflictError extends Error {
  readonly code = 'STORAGE_CONFLICT'
  constructor(attempts: number) {
    super(`Could not commit after ${attempts} attempts due to concurrent writes`)
    this.name = 'StorageConflictError'
  }
}

export interface ConsumeDeps {
  ledger: TableClient
  /** Injectable for deterministic tests. */
  now?: () => Date
}

export interface ConsumeResult {
  opId: string
  txnRowKey: string
  allocRowKey: string
  batchId: string
  batchLabel: string
  remainingTotal: number
  replayed: boolean
}

interface AllocationRow {
  rowKey: string
  etag: string
  batchId: string
  batchLabel: string
  granted: number
  consumed: number
  remaining: number
}

async function listAllocations(ledger: TableClient, partitionKey: string): Promise<AllocationRow[]> {
  const rows: AllocationRow[] = []
  const iter = ledger.listEntities({
    queryOptions: {
      filter: odata`PartitionKey eq ${partitionKey} and RowKey ge ${ALLOC_RANGE.from} and RowKey lt ${ALLOC_RANGE.to}`,
    },
  })
  for await (const e of iter) {
    const r = e as unknown as Record<string, unknown>
    rows.push({
      rowKey: String(r.rowKey),
      etag: String(r.etag),
      batchId: String(r.batchId ?? ''),
      batchLabel: String(r.batchLabel ?? ''),
      granted: Number(r.granted ?? 0),
      consumed: Number(r.consumed ?? 0),
      remaining: Number(r.remaining ?? 0),
    })
  }
  // Table Storage returns rows in RowKey order, and the allocation key encodes
  // effectiveAt first, so this is already FIFO. Sorting defensively costs
  // nothing at this size and removes a dependency on that guarantee.
  rows.sort((a, b) => a.rowKey.localeCompare(b.rowKey))
  return rows
}

async function readIdempotencyResult(
  ledger: TableClient,
  partitionKey: string,
  opId: string,
): Promise<ConsumeResult | undefined> {
  try {
    const row = await ledger.getEntity(partitionKey, idempotencyRowKey(opId))
    const stored = JSON.parse(String((row as Record<string, unknown>).resultJson)) as ConsumeResult
    return { ...stored, replayed: true }
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return undefined
    throw err
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function consumeOne(
  deps: ConsumeDeps,
  memberId: string,
  opId: string,
): Promise<ConsumeResult> {
  assertValidOpId(opId)
  const { ledger } = deps
  const now = deps.now ?? (() => new Date())
  const partitionKey = ledgerPartitionKey(memberId)

  // Fast path: a delivery we have already answered.
  const replay = await readIdempotencyResult(ledger, partitionKey, opId)
  if (replay) return replay

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const rows = await listAllocations(ledger, partitionKey)
    const target = rows.find((r) => r.remaining > 0)
    if (!target) throw new NoBalanceError()

    const createdAt = now()
    const txnRowKey = transactionRowKey(createdAt, opId)
    const remainingTotal = rows.reduce((sum, r) => sum + r.remaining, 0) - 1

    const result: ConsumeResult = {
      opId,
      txnRowKey,
      allocRowKey: target.rowKey,
      batchId: target.batchId,
      batchLabel: target.batchLabel,
      remainingTotal,
      replayed: false,
    }

    const actions: TransactionAction[] = [
      [
        'update',
        {
          partitionKey,
          rowKey: target.rowKey,
          consumed: target.consumed + 1,
          remaining: target.remaining - 1,
        },
        'Merge',
        // Must be an options object: passing a bare string silently sends no
        // precondition at all, and every concurrent write then clobbers the last.
        { etag: target.etag }, // the precondition that makes over-spend impossible
      ],
      [
        'create',
        {
          partitionKey,
          rowKey: txnRowKey,
          kind: 'transaction',
          type: 'CONSUME',
          delta: -1,
          allocRowKey: target.rowKey,
          batchId: target.batchId,
          opId,
          actorMemberId: memberId,
          subjectMemberId: memberId,
          createdAt,
        },
      ],
      [
        'create',
        {
          partitionKey,
          rowKey: idempotencyRowKey(opId),
          kind: 'idempotency',
          txnRowKey,
          statusCode: 200,
          resultJson: JSON.stringify(result),
          createdAt,
        },
      ],
    ]

    try {
      await ledger.submitTransaction(actions)
      return result
    } catch (err) {
      // An identical opId committed first: return its stored answer, not ours.
      if (isConflict(err)) {
        const winner = await readIdempotencyResult(ledger, partitionKey, opId)
        if (winner) return winner
        // A conflict without a winning idempotency row means the transaction
        // row key collided, which only happens if the same opId is reused for
        // a different intent. Surfacing it is better than silently retrying.
        throw err
      }
      // Someone else spent from this allocation between our read and write.
      if (isPreconditionFailed(err)) {
        if (attempt === MAX_ATTEMPTS) throw new StorageConflictError(MAX_ATTEMPTS)
        const jitter = Math.random() * BACKOFF_BASE_MS * 2 ** (attempt - 1)
        await sleep(jitter)
        continue
      }
      throw err
    }
  }

  throw new StorageConflictError(MAX_ATTEMPTS)
}
