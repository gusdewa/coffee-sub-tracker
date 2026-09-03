import { useSyncExternalStore } from 'react'
import { api, type DrinkResponse, type MeResponse } from '../api/client'
import { isOffline, subscribeOnline } from './online'

/**
 * The balance, and the two things you can do to it.
 *
 * This used to live inside the My Coffee screen, which had two consequences.
 * A drink was only possible on one route — and, worse, the 90-second undo was
 * component state destroyed on unmount, so tapping History silently threw away
 * a live window with 89 seconds left on it. The server would still have
 * accepted the reversal; the interface had simply forgotten the op id.
 *
 * A module store rather than a context, following `pwa/mutationGuard.ts`: it
 * needs no provider, so `main.tsx` keeps `<App /><UpdatePrompt />` as literal
 * adjacent siblings (pinned by tests/pwa/update-reachability.test.ts), and the
 * shell can read it from outside the routed tree.
 *
 * Nothing here decides *which* card a cup comes from. FIFO selection, atomicity
 * and idempotency all live server-side; this only carries the intent and the
 * key that makes a retry safe.
 */

/**
 * Mirrors `UNDO_WINDOW_SECONDS` in api/src/domain/undo.ts. Duplicated rather
 * than served, and deliberately so for now — the API would have to expose it on
 * /api/me for the two to be provably in step. If that value ever moves, this
 * one has to move with it.
 */
export const UNDO_SECONDS = 90

export interface UndoOffer {
  opId: string
  batchLabel: string
  until: number
}

export interface CoffeeState {
  data: MeResponse | null
  error: Error | null
  busy: boolean
  undo: UndoOffer | null
  offline: boolean
  /** Bumped once per successful mutation, so sibling screens can reload. */
  revision: number
}

const initial = (): CoffeeState => ({
  data: null,
  error: null,
  busy: false,
  undo: null,
  offline: isOffline(),
  revision: 0,
})

let state: CoffeeState = initial()
const listeners = new Set<() => void>()
let undoTimer: ReturnType<typeof setTimeout> | undefined
let loadMeRequest: Promise<void> | null = null

function set(patch: Partial<CoffeeState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

function clearUndoTimer(): void {
  // Re-arming without clearing was a real bug: a second drink inside the window
  // inherited the first drink's timeout, which then fired early and cancelled
  // an undo the person still had 80 seconds to use.
  if (undoTimer !== undefined) clearTimeout(undoTimer)
  undoTimer = undefined
}

// Offline is shell state, not banner state: the banner, the Drink action and
// the login screen have to agree, so all three read state/online.ts.
subscribeOnline(() => set({ offline: isOffline() }))

export function getCoffeeState(): CoffeeState {
  return state
}

export function subscribeCoffee(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useCoffee(): CoffeeState {
  return useSyncExternalStore(subscribeCoffee, getCoffeeState, getCoffeeState)
}

const getRevision = () => state.revision

/**
 * For screens that own their own request. History, Team and Cards each fetch a
 * different endpoint, so a drink taken from the FAB while one of them is on
 * screen would otherwise leave it displaying a number that is now wrong.
 */
export function useCoffeeRevision(): number {
  return useSyncExternalStore(subscribeCoffee, getRevision, getRevision)
}

/** Load the balance, sharing an authoritative request with overlapping callers. */
export function loadMe(): Promise<void> {
  if (loadMeRequest) return loadMeRequest

  loadMeRequest = (async () => {
    try {
      const data = await api.me()
      set({ data, error: null })
    } catch (err) {
      // The rejection is kept: App reads it to detect an unbound account.
      set({ error: err as Error })
    }
  })()
  const currentRequest = loadMeRequest
  void currentRequest.finally(() => {
    if (loadMeRequest === currentRequest) loadMeRequest = null
  })
  return currentRequest
}

export async function drink(): Promise<DrinkResponse | null> {
  if (state.busy) return null
  if (state.offline) return null
  if (!state.data || state.data.totalRemaining === 0) return null

  set({ busy: true, error: null })
  // One key per intent, so a retry of this press reuses it and the server
  // collapses the duplicate rather than pouring twice.
  const key = crypto.randomUUID()
  try {
    const result = await api.drink(key)
    clearUndoTimer()
    set({
      data: state.data ? { ...state.data, totalRemaining: result.remainingTotal } : state.data,
      undo: {
        opId: result.opId,
        batchLabel: result.batchLabel,
        until: Date.now() + UNDO_SECONDS * 1000,
      },
      revision: state.revision + 1,
    })
    undoTimer = setTimeout(() => set({ undo: null }), UNDO_SECONDS * 1000)
    void loadMe()
    return result
  } catch (err) {
    set({ error: err as Error })
    return null
  } finally {
    set({ busy: false })
  }
}

export async function undoDrink(): Promise<void> {
  const offer = state.undo
  if (!offer || state.busy) return
  if (state.offline) return

  set({ busy: true, error: null })
  try {
    const result = await api.undo(offer.opId, crypto.randomUUID())
    clearUndoTimer()
    set({
      data: state.data ? { ...state.data, totalRemaining: result.remainingTotal } : state.data,
      undo: null,
      revision: state.revision + 1,
    })
    void loadMe()
  } catch (err) {
    set({ error: err as Error })
  } finally {
    set({ busy: false })
  }
}

/** Clear a transient error without discarding the balance behind it. */
export function dismissCoffeeError(): void {
  set({ error: null })
}

/** Test-only: reset module state between cases. */
export function resetCoffeeStore(): void {
  clearUndoTimer()
  listeners.clear()
  loadMeRequest = null
  state = initial()
}
