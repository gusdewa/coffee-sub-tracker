import { odata, type TableClient } from '@azure/data-tables'

import { ledgerPartitionKey, ALLOC_RANGE, TXN_RANGE } from '../storage/keys.js'
import { listMembers, type Member, type RosterDeps } from '../storage/roster.js'

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
  return {
    totalRemaining: allocations.reduce((s, a) => s + a.remaining, 0),
    allocations,
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
    const coffee = await getMyCoffee(deps, m.memberId)
    return { memberId: m.memberId, displayName: m.displayName, remaining: coffee.totalRemaining }
  })

  return balances.sort((a, b) => a.displayName.localeCompare(b.displayName))
}
