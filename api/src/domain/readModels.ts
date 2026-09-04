import { odata, type TableClient } from '@azure/data-tables'

import {
  ledgerPartitionKey,
  idempotencyRowKey,
  ALLOC_RANGE,
  TXN_RANGE,
  LATEST_CONSUME_MARKER_ROW_KEY,
} from '../storage/keys.js'
import { listMembers, type Member, type RosterDeps } from '../storage/roster.js'
import { isNotFound } from '../storage/tableClient.js'
import { sameDayUndoDeadline } from './undoPolicy.js'

/**
 * Read models.
 *
 * Every screen is served by a single-partition query. "All balances" fans out
 * across the roster with a bounded concurrency instead of scanning the table —
 * a cross-partition scan would be the one query whose cost grows without limit.
 */

export interface AllocationView {
  allocRowKey: string
  batchId: string
  batchLabel: string
  granted: number
  consumed: number
  remaining: number
  effectiveAt: string
}

export interface MyCoffee {
  totalRemaining: number
  allocations: AllocationView[]
  undoOffer: UndoOffer | null
}

export interface UndoOffer {
  opId: string
  allocRowKey: string
  batchId: string
  batchLabel: string
  createdAt: string
  undoExpiresAt: string
}

export interface HistoryItem {
  opId: string
  type: string
  delta: number
  batchLabel: string
  reason?: string
  reversesOpId?: string
  createdAt: string
  /** True when a later REVERSAL row points back at this one. */
  reversed: boolean
}

export interface LedgerDeps {
  ledger: TableClient
  now?: () => Date
  undoWindowSeconds?: number
  includeUndoOffer?: boolean
}

async function readEntity(
  ledger: TableClient,
  partitionKey: string,
  rowKey: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    return await ledger.getEntity(partitionKey, rowKey) as Record<string, unknown>
  } catch (err) {
    if (isNotFound(err)) return undefined
    throw err
  }
}

function undoOfferFromTransaction(
  candidate: Record<string, unknown>,
  memberId: string,
  now: Date,
  undoWindowSeconds: number,
): UndoOffer | null {
  const opId = String(candidate.opId ?? '')
  const createdAt = new Date(String(candidate.createdAt))
  const shortDeadline = candidate.undoExpiresAt
    ? new Date(String(candidate.undoExpiresAt))
    : new Date(createdAt.getTime() + undoWindowSeconds * 1000)
  const deadline = sameDayUndoDeadline(createdAt, shortDeadline)
  if (
    candidate.type !== 'CONSUME'
    || String(candidate.subjectMemberId ?? '') !== memberId
    || !opId
    || !Number.isFinite(createdAt.getTime())
    || !Number.isFinite(deadline.getTime())
    || now.getTime() > deadline.getTime()
  ) return null

  return {
    opId,
    allocRowKey: String(candidate.allocRowKey ?? ''),
    batchId: String(candidate.batchId ?? ''),
    batchLabel: String(candidate.batchLabel ?? ''),
    createdAt: createdAt.toISOString(),
    undoExpiresAt: deadline.toISOString(),
  }
}

export async function getMyCoffee(deps: LedgerDeps, memberId: string): Promise<MyCoffee> {
  const pk = ledgerPartitionKey(memberId)
  const allocations: AllocationView[] = []

  const iter = deps.ledger.listEntities({
    queryOptions: {
      filter: odata`PartitionKey eq ${pk} and RowKey ge ${ALLOC_RANGE.from} and RowKey lt ${ALLOC_RANGE.to}`,
    },
  })
  for await (const e of iter) {
    const r = e as Record<string, unknown>
    allocations.push({
      allocRowKey: String(r.rowKey),
      batchId: String(r.batchId ?? ''),
      batchLabel: String(r.batchLabel ?? ''),
      granted: Number(r.granted ?? 0),
      consumed: Number(r.consumed ?? 0),
      remaining: Number(r.remaining ?? 0),
      effectiveAt: new Date(String(r.effectiveAt)).toISOString(),
    })
  }

  allocations.sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt))

  let undoOffer: UndoOffer | null = null
  if (deps.includeUndoOffer !== false) {
    const now = (deps.now ?? (() => new Date()))()
    const undoWindowSeconds = deps.undoWindowSeconds ?? 90
    const marker = await readEntity(deps.ledger, pk, LATEST_CONSUME_MARKER_ROW_KEY)

    if (marker) {
      // The marker is serialized in the same transaction as Drink/Put Back and
      // is authoritative even when transaction row keys tie on time.
      const activeOpId = String(marker.activeOpId ?? '')
      if (activeOpId) {
        const idem = await readEntity(deps.ledger, pk, idempotencyRowKey(activeOpId))
        const txnRowKey = String(idem?.txnRowKey ?? '')
        const txn = txnRowKey ? await readEntity(deps.ledger, pk, txnRowKey) : undefined
        if (txn && String(txn.opId ?? '') === activeOpId) {
          const candidate = undoOfferFromTransaction(txn, memberId, now, undoWindowSeconds)
          // Point reads are not a snapshot. Revalidate the marker after
          // resolving the transaction so concurrent Drink/Undo cannot publish
          // an offer that was already superseded.
          const currentMarker = await readEntity(
            deps.ledger, pk, LATEST_CONSUME_MARKER_ROW_KEY,
          )
          if (
            candidate
            && String(currentMarker?.etag ?? '') === String(marker.etag ?? '')
            && String(currentMarker?.activeOpId ?? '') === activeOpId
          ) undoOffer = candidate
        }
      }
    } else {
      // Markerless partitions predate latest-consume serialization. Fall back
      // to history only there, scanning the eligible slice so a reversal that
      // shares its consume's millisecond is detected regardless of opId order.
      const reversed = new Set<string>()
      let latestConsume: Record<string, unknown> | undefined
      let latestCreatedAt: string | undefined
      let ambiguousLatest = false
      const transactions = deps.ledger.listEntities({
        queryOptions: {
          filter: odata`PartitionKey eq ${pk} and RowKey ge ${TXN_RANGE.from} and RowKey lt ${TXN_RANGE.to}`,
        },
      })
      for await (const e of transactions) {
        const row = e as Record<string, unknown>
        const createdAt = new Date(String(row.createdAt))
        const shortDeadline = row.undoExpiresAt
          ? new Date(String(row.undoExpiresAt))
          : new Date(createdAt.getTime() + undoWindowSeconds * 1000)
        if (
          !Number.isFinite(createdAt.getTime())
          || now.getTime() > sameDayUndoDeadline(createdAt, shortDeadline).getTime()
        ) break
        if (row.type === 'REVERSAL') reversed.add(String(row.reversesOpId ?? ''))
        else if (row.type === 'CONSUME') {
          const stamp = String(row.createdAt ?? '')
          if (!latestConsume) {
            latestConsume = row
            latestCreatedAt = stamp
          } else if (
            stamp === latestCreatedAt
            && String(row.opId ?? '') !== String(latestConsume.opId ?? '')
          ) {
            ambiguousLatest = true
          }
        }
      }
      if (
        latestConsume
        && !ambiguousLatest
        && !reversed.has(String(latestConsume.opId ?? ''))
        // A first Drink may have created the authoritative marker while this
        // legacy scan was running. Publish history-derived state only if the
        // partition is still genuinely markerless at the end of the read.
        && !(await readEntity(deps.ledger, pk, LATEST_CONSUME_MARKER_ROW_KEY))
      ) {
        undoOffer = undoOfferFromTransaction(latestConsume, memberId, now, undoWindowSeconds)
      }
    }
  }

  return {
    totalRemaining: allocations.reduce((s, a) => s + a.remaining, 0),
    allocations,
    undoOffer,
  }
}

export async function getHistory(
  deps: LedgerDeps,
  memberId: string,
  limit = 50,
): Promise<HistoryItem[]> {
  const pk = ledgerPartitionKey(memberId)
  const rows: Record<string, unknown>[] = []

  // RowKey encodes an inverted clock, so ascending order is already
  // newest-first and no sort or reversal is needed.
  const iter = deps.ledger.listEntities({
    queryOptions: {
      filter: odata`PartitionKey eq ${pk} and RowKey ge ${TXN_RANGE.from} and RowKey lt ${TXN_RANGE.to}`,
    },
  })
  for await (const e of iter) {
    rows.push(e as Record<string, unknown>)
    if (rows.length >= limit * 2) break // headroom for pairing reversals
  }

  const reversedOpIds = new Set(
    rows.filter((r) => r.type === 'REVERSAL').map((r) => String(r.reversesOpId)),
  )

  return rows.slice(0, limit).map((r) => {
    const item: HistoryItem = {
      opId: String(r.opId ?? ''),
      type: String(r.type ?? ''),
      delta: Number(r.delta ?? 0),
      // Deliberately not falling back to batchId: a raw ULID on screen is
      // worse than an empty label.
      batchLabel: String(r.batchLabel ?? ''),
      createdAt: new Date(String(r.createdAt)).toISOString(),
      reversed: reversedOpIds.has(String(r.opId ?? '')),
    }
    if (r.reason) item.reason = String(r.reason)
    if (r.reversesOpId) item.reversesOpId = String(r.reversesOpId)
    return item
  })
}

export interface BalanceRow {
  memberId: string
  displayName: string
  remaining: number
}

/** Run `tasks` with at most `limit` in flight, preserving input order. */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i] as T)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Every member's remaining total — display name and number only. No email, no
 * history, no correction detail leaves this endpoint.
 */
export async function getAllBalances(
  deps: LedgerDeps & RosterDeps,
  opts: { includeSynthetic?: boolean } = {},
): Promise<BalanceRow[]> {
  const members = (await listMembers(deps)).filter(
    (m: Member) => m.status === 'active' && (opts.includeSynthetic || !m.isSynthetic),
  )

  const balances = await mapWithLimit(members, 6, async (m) => {
    const coffee = await getMyCoffee({ ...deps, includeUndoOffer: false }, m.memberId)
    return { memberId: m.memberId, displayName: m.displayName, remaining: coffee.totalRemaining }
  })

  return balances.sort((a, b) => a.displayName.localeCompare(b.displayName))
}
