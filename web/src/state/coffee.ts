import { useSyncExternalStore } from 'react'
import {
  ApiError,
  OfflineError,
  UnconfirmedDrinkError,
  api,
  type DrinkResponse,
  type MeResponse,
} from '../api/client'
import { isOffline, subscribeOnline } from './online'

/**
 * The latest Drink's Put Back, as long as the server allows it. Timestamps are
 * null when an older API left them out or sent something unparseable.
 */
export interface UndoOffer {
  opId: string
  batchLabel: string
  allocRowKey: string
  batchId: string
  createdAt: string | null
  undoExpiresAt: string | null
}

/**
 * One successful Drink tap, for the summary that follows it.
 *
 * Deliberately separate from the undo offer: the offer ends at a server
 * deadline or when a newer cup takes it over, while the receipt lasts until
 * the person dismisses it and records what became of its own cup.
 */
export interface DrinkReceipt {
  opId: string
  batchLabel: string
  /** '' when an older API did not say which allocation the cup came off. */
  allocRowKey: string
  batchId: string
  createdAt: string | null
  undoExpiresAt: string | null
  replayed: boolean
  memberId: string
  memberName: string
  status: 'counted' | 'putBack'
}

export interface CoffeeState {
  data: MeResponse | null
  error: Error | null
  busy: boolean
  undo: UndoOffer | null
  receipt: DrinkReceipt | null
  /**
   * A failed Put Back, tied to the cup it was for. Kept out of `error`, which
   * the whole shell renders: an undo failure belongs next to its own button.
   */
  undoError: { opId: string; error: Error } | null
  offline: boolean
  revision: number
}

const initial = (): CoffeeState => ({
  data: null,
  error: null,
  busy: false,
  undo: null,
  receipt: null,
  undoError: null,
  offline: isOffline(),
  revision: 0,
})

let state: CoffeeState = initial()
const listeners = new Set<() => void>()
let undoTimer: ReturnType<typeof setTimeout> | undefined
interface LoadMeRequest {
  revision: number
  promise: Promise<void>
}
let loadMeRequest: LoadMeRequest | null = null

function set(patch: Partial<CoffeeState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

function clearUndoTimer(): void {
  if (undoTimer !== undefined) clearTimeout(undoTimer)
  undoTimer = undefined
}

/** NaN for a missing or unparseable deadline, so callers test it with isFinite. */
function deadlineOf(undoExpiresAt: string | null | undefined): number {
  return typeof undoExpiresAt === 'string' ? Date.parse(undoExpiresAt) : Number.NaN
}

/** A timestamp as sent, or null when it is missing or would be an Invalid Date. */
function instantOrNull(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
}

function armUndoExpiry(opId: string, undoExpiresAt: string | null): void {
  clearUndoTimer()
  const deadline = deadlineOf(undoExpiresAt)
  // A rolling web/API deployment can briefly pair a new client with an old
  // response that has no deadline. Keep the server-authoritative offer usable;
  // an expired undo is still rejected by the API and cleared below.
  if (!Number.isFinite(deadline)) return
  const expire = () => {
    if (state.undo?.opId !== opId) return
    const left = deadline - Date.now()
    if (left <= 0) {
      undoTimer = undefined
      set({ undo: null })
      return
    }
    // Browsers clamp/overflow very large delays; re-arm until the real deadline.
    undoTimer = setTimeout(expire, Math.min(left, 2_147_000_000))
  }
  expire()
}

subscribeOnline(() => set({ offline: isOffline() }))

export function getCoffeeState(): CoffeeState {
  return state
}

export function subscribeCoffee(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useCoffee(): CoffeeState {
  return useSyncExternalStore(subscribeCoffee, getCoffeeState, getCoffeeState)
}

const getRevision = () => state.revision
export function useCoffeeRevision(): number {
  return useSyncExternalStore(subscribeCoffee, getRevision, getRevision)
}

/**
 * Publishes an /api/me answer. Whether it also clears `error` is the caller's
 * call: an ordinary refresh clears the error it was sent after, the one after
 * a failed mutation clears nothing.
 */
function applyMe(data: MeResponse, { clearError }: { clearError: boolean }): void {
  const errorPatch = clearError ? { error: null } : {}
  // The offer comes from ledger history, not browser memory, so reloads
  // and other devices rediscover the same authoritative Put Back action.
  // `undefined` keeps compatibility with an old API during rolling deploys.
  // The receipt is left alone even when the offer moved on: whether its
  // cup was put back is for the summary to confirm from history.
  if (data.undoOffer !== undefined) {
    clearUndoTimer()
    set({ data, ...errorPatch, undo: data.undoOffer })
    if (data.undoOffer) armUndoExpiry(data.undoOffer.opId, data.undoOffer.undoExpiresAt)
  } else {
    set({ data, ...errorPatch })
  }
}

export function loadMe(): Promise<void> {
  const revision = state.revision
  if (loadMeRequest?.revision === revision) return loadMeRequest.promise
  // An answer clears only the error this read was sent after. A Drink that
  // failed while it was out (refused, or unanswered and perhaps committed) is
  // news it left too early to know about, so its reason stays on screen.
  const errorSeen = state.error
  const promise = (async () => {
    try {
      const data = await api.me()
      if (state.revision === revision) applyMe(data, { clearError: state.error === errorSeen })
    } catch (err) {
      if (state.revision !== revision) return
      // A refresh that failed has learnt nothing about a Drink whose answer was
      // lost, so it must not swap "couldn't confirm" for a read error whose
      // copy says the cup was not counted. An answer from the API still wins.
      if (state.error instanceof UnconfirmedDrinkError && !(err instanceof ApiError)) return
      set({ error: err as Error })
    }
  })()
  const currentRequest = { revision, promise }
  loadMeRequest = currentRequest
  void promise.finally(() => {
    if (loadMeRequest === currentRequest) loadMeRequest = null
  })
  return promise
}

/**
 * Asks /api/me again after a mutation whose outcome is unknown, so a Drink
 * that did commit comes back as the undoOffer that guards the next tap.
 *
 * It leaves `error` to the mutation: that error is the person's only account
 * of what happened, and the refresh answering does not make it untrue. Only
 * an answer from the API itself (an account unbound meanwhile) replaces it.
 *
 * A refresh already in flight is not joined, because it may have left before
 * the mutation reached the server. This one waits for it instead, so the
 * stale answer cannot land last.
 */
function reconcile(): void {
  const revision = state.revision
  const earlier = loadMeRequest?.revision === revision ? loadMeRequest.promise : undefined
  const run = async () => {
    // A successful mutation since has already asked /api/me for itself.
    if (state.revision !== revision) return
    try {
      const data = await api.me()
      if (state.revision === revision) applyMe(data, { clearError: false })
    } catch (err) {
      if (state.revision === revision && err instanceof ApiError) set({ error: err })
    }
  }
  void (earlier ? earlier.then(run) : run())
}

/** Whether the browser still believes it is online; unknown counts as online. */
function browserOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

export async function drink(
  options: { confirmedAnother?: boolean } = {},
): Promise<DrinkResponse | null> {
  if (state.busy || state.offline || !state.data || state.data.totalRemaining === 0) return null
  // This is the mutation-boundary guard. The UI opens a warning dialog first,
  // but no other caller can bypass that warning and create another opId.
  if (state.undo && !options.confirmedAnother) return null

  set({ busy: true, error: null })
  try {
    // Deliberately generated only after the guards above. Inside the try
    // because randomUUID throws outside a secure context, and a throw out here
    // used to leave the store busy for good.
    const key = crypto.randomUUID()
    const result = await api.drink(key)
    // An older API during a rolling deploy answers with only opId, batchLabel
    // and remainingTotal. Normalise once, here, so nothing downstream meets an
    // undefined where the type promises a string.
    const allocRowKey = result.allocRowKey || ''
    const batchId = result.batchId || ''
    const allocations = state.data.allocations.map((allocation) =>
      (allocRowKey
        ? allocation.allocRowKey === allocRowKey
        : batchId !== '' && allocation.batchId === batchId)
        ? {
            ...allocation,
            consumed: allocation.consumed + 1,
            remaining: Math.max(0, allocation.remaining - 1),
          }
        : allocation,
    )
    const undo: UndoOffer = {
      opId: result.opId,
      batchLabel: result.batchLabel || '',
      allocRowKey,
      batchId,
      createdAt: instantOrNull(result.createdAt),
      undoExpiresAt: instantOrNull(result.undoExpiresAt),
    }
    const { member } = state.data
    // One update, so no render sees the new balance without its receipt or
    // the receipt without its Put Back. A replay is the same tap answered
    // again, so it is still exactly one receipt. `error` goes too: anything
    // set since the tap came from a read that left before this answer, and
    // "not counted" must never sit beside a cup that was.
    set({
      data: { ...state.data, totalRemaining: result.remainingTotal, allocations },
      error: null,
      undo,
      revision: state.revision + 1,
      receipt: {
        ...undo,
        replayed: result.replayed === true,
        memberId: member.memberId,
        memberName: member.displayName,
        status: 'counted',
      },
      undoError: null,
    })
    armUndoExpiry(undo.opId, undo.undoExpiresAt)
    void loadMe()
    return result
  } catch (err) {
    const error = err as Error
    if (error instanceof ApiError) {
      // The server answered, and its code says what happened: handled as before.
      set({ error })
    } else {
      // No answer is not "not counted": the request may have committed before
      // the connection dropped. Only a browser that knows it is offline gets
      // the plain OfflineError. Either way /api/me is asked, and a committed
      // Drink comes back as its undoOffer, which guards the next tap.
      set({
        error:
          error instanceof OfflineError && browserOnline() ? new UnconfirmedDrinkError() : error,
      })
      reconcile()
    }
    return null
  } finally {
    set({ busy: false })
  }
}

/** The cup is back, by our request or by the server's account of it. */
function markPutBack(opId: string, remainingTotal?: number): void {
  clearUndoTimer()
  const { data, receipt } = state
  set({
    data: data && remainingTotal !== undefined ? { ...data, totalRemaining: remainingTotal } : data,
    undo: null,
    revision: state.revision + 1,
    receipt: receipt?.opId === opId ? { ...receipt, status: 'putBack' } : receipt,
    undoError: null,
  })
  void loadMe()
}

/**
 * Puts back the latest cup. Given `expectedOpId`, only that cup: a button
 * rendered for one Drink must never reverse a newer one that took over the
 * offer while it was on screen. Resolves true once the cup is back.
 */
export async function undoDrink(expectedOpId?: string): Promise<boolean> {
  const offer = state.undo
  if (expectedOpId !== undefined && offer?.opId !== expectedOpId) return false
  if (!offer || state.busy || state.offline) return false
  const deadline = deadlineOf(offer.undoExpiresAt)
  if (Number.isFinite(deadline) && Date.now() > deadline) {
    set({ undo: null })
    return false
  }

  set({ busy: true, undoError: null })
  try {
    const result = await api.undo(offer.opId, crypto.randomUUID())
    markPutBack(offer.opId, result.remainingTotal)
    return true
  } catch (err) {
    const error = err as Error
    if (error instanceof ApiError && error.code === 'ALREADY_UNDONE') {
      // The server is authoritative: this exact cup is already back, perhaps
      // from another device or a retry whose first answer was lost.
      markPutBack(offer.opId)
      return true
    }
    if (
      error instanceof ApiError &&
      (error.code === 'UNDO_WINDOW_EXPIRED' || error.code === 'NOT_LATEST_CONSUME')
    ) {
      // Only this cup's offer goes. A refresh that landed while the request was
      // out may already hold the newer cup's, and that one is still good.
      const stillThisCup = state.undo?.opId === offer.opId
      if (stillThisCup) clearUndoTimer()
      set({ ...(stillThisCup ? { undo: null } : {}), undoError: { opId: offer.opId, error } })
    } else {
      // Unanswered, so it may have committed: keep the offer, and let /api/me
      // settle which it was.
      set({ undoError: { opId: offer.opId, error } })
    }
    reconcile()
    return false
  } finally {
    set({ busy: false })
  }
}

/** Closes the summary. The offer is the card's as well, so Put Back stays there. */
export function dismissReceipt(): void {
  set({ receipt: null, undoError: null })
}

export function dismissCoffeeError(): void {
  set({ error: null })
}

export function resetCoffeeStore(): void {
  clearUndoTimer()
  listeners.clear()
  loadMeRequest = null
  state = initial()
}
