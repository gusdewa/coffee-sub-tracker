import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { api, type HistoryItem } from '../api/client'
import { jakartaDayKey } from '../insights/recent'
import { useCoffee } from './coffee'

/**
 * The member's own history page, shared by every screen that reads it.
 *
 * The post-Drink summary, the History screen and the Home pace card all want
 * the same page at the same moment. Fetching it once per key keeps a Drink at
 * one history request however many of them are mounted, and gives them one
 * answer to agree on instead of three that can disagree for a render.
 */

/** Enough rows to cover a fortnight of pace, and the limit the figures are computed against. */
export const HISTORY_LIMIT = 100

/**
 * A slow read must end in "took too long", not an endless skeleton. It is a
 * GET, so abandoning it cannot orphan a commit the way aborting a Drink could.
 */
export const HISTORY_TIMEOUT_MS = 8_000

export interface HistorySnapshot {
  /** The key `items` and `error` answer; null while there is neither. */
  key: string | null
  items: HistoryItem[] | null
  error: Error | null
  /** A request for the latest requested key is still out. */
  loading: boolean
  /** The limit the page was asked for with, which the figures need to judge coverage. */
  limit: number
}

const initial = (): HistorySnapshot => ({
  key: null,
  items: null,
  error: null,
  loading: false,
  limit: HISTORY_LIMIT,
})

let snapshot: HistorySnapshot = initial()
const listeners = new Set<() => void>()
/** The key the app most recently asked about; only its answer is ever published. */
let latestKey: string | null = null
const inFlight = new Map<string, Promise<void>>()
// Bumped by resetHistoryStore so a request from before the reset cannot land in
// the fresh store, even when it happens to share the new store's latest key.
let generation = 0

function set(patch: Partial<HistorySnapshot>): void {
  snapshot = { ...snapshot, ...patch }
  for (const listener of listeners) listener()
}

export function getHistorySnapshot(): HistorySnapshot {
  return snapshot
}

export function subscribeHistory(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Everything that can make the page out of date. The member comes first: the
 * store outlives a sign-out, or a QA session redeemed over a real one, and two
 * members can share every other figure here. The revision covers this device's
 * own Drink and Put Back; the balance and the undo offer come from /api/me, so
 * a cup taken or put back on another device is noticed on the next poll; and
 * the Jakarta day moves "today" in every figure at local midnight. JSON keeps a
 * missing value distinct from one that merely spells "null".
 */
export function historyKey(input: {
  memberId: string | null
  revision: number
  totalRemaining: number | null
  undoOpId: string | null
  now: number
}): string {
  return JSON.stringify([
    input.memberId,
    input.revision,
    input.totalRemaining,
    input.undoOpId,
    jakartaDayKey(input.now),
  ])
}

/** The member a historyKey was made for; undefined for a key it did not make. */
function memberOfKey(key: string): unknown {
  try {
    const parts: unknown = JSON.parse(key)
    return Array.isArray(parts) ? parts[0] : undefined
  } catch {
    return undefined
  }
}

/**
 * Fetches the page for `key` unless it is already known.
 *
 * A request already in flight for the key is always joined, even when forced:
 * a second identical read cannot be newer than one that has not answered yet.
 * Without `force`, a successful answer for the key is reused. A failure is not:
 * the next reader to ask tries again rather than inheriting an error it never
 * saw happen. Never rejects; failures become the snapshot's `error`.
 */
export function loadHistory(key: string, { force = false }: { force?: boolean } = {}): Promise<void> {
  latestKey = key
  const pending = inFlight.get(key)
  if (pending) {
    // The key may have been superseded and then asked for again, so the
    // snapshot has to say its answer is still coming.
    if (!snapshot.loading) set({ loading: true })
    return pending
  }
  if (!force && snapshot.key === key && snapshot.items !== null && snapshot.error === null) {
    if (snapshot.loading) set({ loading: false })
    return Promise.resolve()
  }

  // The rows already on screen stay while the new page loads, so a Drink does
  // not blank History into a skeleton; `key` still says which key they answer.
  // The last error goes: this attempt is the answer to wait for now.
  set({
    loading: true,
    error: null,
    key: snapshot.items !== null ? snapshot.key : null,
  })

  const started = generation
  const promise = (async () => {
    let settled: Pick<HistorySnapshot, 'items' | 'error'>
    try {
      const { items } = await api.history(HISTORY_LIMIT, { timeoutMs: HISTORY_TIMEOUT_MS })
      settled = { items, error: null }
    } catch (err) {
      // Rows are kept only when they answer this same key (a failed refresh);
      // another key's rows would pass an older ledger off as this one.
      settled = { items: snapshot.key === key ? snapshot.items : null, error: err as Error }
    }
    if (generation !== started) return
    inFlight.delete(key)
    // An answer for a key that is no longer the latest describes a balance the
    // app has moved past. Dropped, never published, however late it lands.
    if (latestKey !== key) return
    set({ key, ...settled, loading: false })
  })()
  inFlight.set(key, promise)
  return promise
}

/**
 * The shared page, keyed on the coffee store.
 *
 * The key is computed at render with the current time. The shell's 60-second
 * poll, and its refreshes on becoming visible or coming back online, all go
 * through loadMe, which re-renders every reader; so a new Jakarta day is picked
 * up on the next of those without a midnight timer of its own.
 *
 * Nothing is asked until /api/me has answered (or failed): a page read after
 * the balance is at least as new as the balance it is keyed on, and reading it
 * earlier would only be read again the moment the balance arrived.
 *
 * `loading` is true whenever the rows are not yet the answer for the current
 * key, including the render between a key change and its request. Rows kept
 * from an earlier key are returned only while it was the same member's.
 */
export function useHistory({ enabled = true }: { enabled?: boolean } = {}): HistorySnapshot & {
  refresh(): void
} {
  const coffee = useCoffee()
  const current = useSyncExternalStore(subscribeHistory, getHistorySnapshot, getHistorySnapshot)

  const known = coffee.data !== null || coffee.error !== null
  const key =
    enabled && known
      ? historyKey({
          memberId: coffee.data?.member.memberId ?? null,
          revision: coffee.revision,
          totalRemaining: coffee.data?.totalRemaining ?? null,
          undoOpId: coffee.undo?.opId ?? null,
          now: Date.now(),
        })
      : null

  useEffect(() => {
    if (key !== null) void loadHistory(key)
  }, [key])

  const refresh = useCallback(() => {
    if (key !== null) void loadHistory(key, { force: true })
  }, [key])

  // A reader that asked for nothing has no rows it can vouch for.
  if (!enabled) return { ...initial(), refresh }
  // The rows kept up while a new key loads are whoever the last key was for.
  // After a change of account that is someone else's ledger, so it goes.
  if (key !== null && current.key !== null && memberOfKey(current.key) !== memberOfKey(key)) {
    return { ...current, key: null, items: null, error: null, loading: true, refresh }
  }
  return {
    ...current,
    loading: key === null || current.key !== key || current.loading,
    refresh,
  }
}

export function resetHistoryStore(): void {
  generation += 1
  listeners.clear()
  inFlight.clear()
  latestKey = null
  snapshot = initial()
}
