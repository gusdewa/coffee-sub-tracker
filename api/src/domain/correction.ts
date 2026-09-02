import { odata, type TableClient, type TransactionAction } from '@azure/data-tables'

import {
  ledgerPartitionKey,
  allocationRowKey,
  transactionRowKey,
  idempotencyRowKey,
  assertValidOpId,
  ALLOC_RANGE,
} from '../storage/keys.js'
import { isConflict, isNotFound, isPreconditionFailed } from '../storage/tableClient.js'
import { StorageConflictError, MAX_ATTEMPTS } from './consume.js'

/**
 * Admin correction — the audited escape hatch.
 *
 * A negative correction debits FIFO across allocations and refuses rather than
 * going negative. Because every allocation it touches lives in the subject's
 * own partition, even a multi-allocation debit commits as one transaction.
 *
 * A positive correction lands on a dedicated adjustment allocation dated now,
 * so FIFO still drains genuinely older batches first — a gift does not jump
 * the queue.
 *
 * A reason is mandatory. A correction without one is indistinguishable from
 * tampering when someone reads the ledger back six months later.
 */

export const ADJUSTMENT_BATCH_ID = 'ADJUSTMENT'

export class InsufficientBalanceError extends Error {
  readonly code = 'INSUFFICIENT_BALANCE'
  constructor(available: number, requested: number) {
    super(`Cannot deduct ${requested}: only ${available} remaining`)
    this.name = 'InsufficientBalanceError'
  }
}

export class MissingReasonError extends Error {
  readonly code = 'VALIDATION_FAILED'
  constructor() {
    super('A correction requires a reason')
    this.name = 'MissingReasonError'
  }
}

export class InvalidDeltaError extends Error {
  readonly code = 'VALIDATION_FAILED'
  constructor() {
    super('A correction delta must be a non-zero whole number')
    this.name = 'InvalidDeltaError'
  }
}

export interface CorrectionDeps {
  ledger: TableClient
  now?: () => Date
}

export interface CorrectionResult {
  opId: string
  txnRowKey: string
  delta: number
  remainingTotal: number
  touchedAllocRowKeys: string[]
  replayed: boolean
}

interface AllocRow {
  rowKey: string
  etag: string
  batchId: string
  batchLabel: string
  consumed: number
  remaining: number
}

async function listAllocations(ledger: TableClient, partitionKey: string): Promise<AllocRow[]> {
  const rows: AllocRow[] = []
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
      consumed: Number(r.consumed ?? 0),
      remaining: Number(r.remaining ?? 0),
    })
  }
  rows.sort((a, b) => a.rowKey.localeCompare(b.rowKey))
  return rows
}

async function readStored(
  ledger: TableClient,
  partitionKey: string,
  opId: string,
): Promise<CorrectionResult | undefined> {
  try {
    const row = await ledger.getEntity(partitionKey, idempotencyRowKey(opId))
    const stored = JSON.parse(String((row as Record<string, unknown>).resultJson)) as CorrectionResult
    return { ...stored, replayed: true }
  } catch (err) {
    if (isNotFound(err)) return undefined
    throw err
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function applyCorrection(
  deps: CorrectionDeps,
  actorMemberId: string,
  subjectMemberId: string,
  delta: number,
  reason: string,
  opId: string,
): Promise<CorrectionResult> {
  assertValidOpId(opId)
  if (!Number.isInteger(delta) || delta === 0) throw new InvalidDeltaError()
  if (!reason?.trim()) throw new MissingReasonError()

  const { ledger } = deps
  const now = deps.now ?? (() => new Date())
  const partitionKey = ledgerPartitionKey(subjectMemberId)

  const replay = await readStored(ledger, partitionKey, opId)
  if (replay) return replay

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const rows = await listAllocations(ledger, partitionKey)
    const available = rows.reduce((s, r) => s + r.remaining, 0)

    const at = now()
    const txnRowKey = transactionRowKey(at, opId)
    const updates: TransactionAction[] = []
    const touched: string[] = []

    if (delta < 0) {
      let toDeduct = -delta
      if (available < toDeduct) throw new InsufficientBalanceError(available, toDeduct)

      for (const row of rows) {
        if (toDeduct === 0) break
        if (row.remaining <= 0) continue
        const take = Math.min(row.remaining, toDeduct)
        updates.push([
          'update',
          {
            partitionKey,
            rowKey: row.rowKey,
            consumed: row.consumed + take,
            remaining: row.remaining - take,
          },
          'Merge',
          { etag: row.etag },
        ])
        touched.push(row.rowKey)
        toDeduct -= take
      }
    } else {
      // Credit onto an adjustment allocation dated now, so it is spent last.
      const adjustRowKey = allocationRowKey(at, ADJUSTMENT_BATCH_ID)
      const existing = rows.find((r) => r.rowKey === adjustRowKey)
      if (existing) {
        updates.push([
          'update',
          { partitionKey, rowKey: adjustRowKey, remaining: existing.remaining + delta },
          'Merge',
          { etag: existing.etag },
        ])
      } else {
        updates.push([
          'create',
          {
            partitionKey,
            rowKey: adjustRowKey,
            kind: 'allocation',
            batchId: ADJUSTMENT_BATCH_ID,
            batchLabel: 'Admin correction',
            granted: delta,
            consumed: 0,
            remaining: delta,
            effectiveAt: at,
          },
        ])
      }
      touched.push(adjustRowKey)
    }

    const result: CorrectionResult = {
      opId,
      txnRowKey,
      delta,
      remainingTotal: available + delta,
      touchedAllocRowKeys: touched,
      replayed: false,
    }

    const actions: TransactionAction[] = [
      ...updates,
      [
        'create',
        {
          partitionKey,
          rowKey: txnRowKey,
          kind: 'transaction',
          type: 'CORRECTION',
          delta,
          allocRowKey: touched[0] ?? '',
          batchId: delta > 0 ? ADJUSTMENT_BATCH_ID : '',
          batchLabel: delta > 0 ? 'Admin correction' : 'Correction',
          opId,
          actorMemberId,
          subjectMemberId,
          reason: reason.trim(),
          createdAt: at,
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
          createdAt: at,
        },
      ],
    ]

    try {
      await ledger.submitTransaction(actions)
      return result
    } catch (err) {
      if (isConflict(err)) {
        const winner = await readStored(ledger, partitionKey, opId)
        if (winner) return winner
        throw err
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
