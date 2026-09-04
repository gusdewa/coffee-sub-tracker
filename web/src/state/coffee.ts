import { useSyncExternalStore } from 'react'
import { ApiError, api, type DrinkResponse, type MeResponse } from '../api/client'
import { isOffline, subscribeOnline } from './online'

/** Success is transient UI; undo eligibility is an independent server deadline. */
export const SUCCESS_NOTICE_SECONDS = 10

export interface UndoOffer {
  opId: string
  batchLabel: string
  allocRowKey: string
  batchId: string
  createdAt: string
  undoExpiresAt: string
}

export interface SuccessNotice {
  text: 'Drink 1'
  until: number
}

export interface CoffeeState {
  data: MeResponse | null
  error: Error | null
  busy: boolean
  undo: UndoOffer | null
  notice: SuccessNotice | null
  offline: boolean
  revision: number
}

const initial = (): CoffeeState => ({
  data: null,
  error: null,
  busy: false,
  undo: null,
  notice: null,
  offline: isOffline(),
  revision: 0,
})

let state: CoffeeState = initial()
const listeners = new Set<() => void>()
let noticeTimer: ReturnType<typeof setTimeout> | undefined
let undoTimer: ReturnType<typeof setTimeout> | undefined
interface LoadMeRequest {
  revision: number
  promise: Promise<void>
}
let loadMeRequest: LoadMeRequest | null = null
const reversedDrinkOps = new Set<string>()

function set(patch: Partial<CoffeeState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

function clearTimer(timer: ReturnType<typeof setTimeout> | undefined): void {
  if (timer !== undefined) clearTimeout(timer)
}

function clearMutationTimers(): void {
  clearTimer(noticeTimer)
  clearTimer(undoTimer)
  noticeTimer = undefined
  undoTimer = undefined
}

function armUndoExpiry(opId: string, undoExpiresAt: string): void {
  clearTimer(undoTimer)
  const deadline = Date.parse(undoExpiresAt)
  // A rolling web/API deployment can briefly pair a new client with an old
  // response that has no deadline. Keep the server-authoritative offer usable;
  // an expired undo is still rejected by the API and cleared below.
  if (!Number.isFinite(deadline)) {
    undoTimer = undefined
    return
  }
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

export function loadMe(): Promise<void> {
  const revision = state.revision
  if (loadMeRequest?.revision === revision) return loadMeRequest.promise
  const promise = (async () => {
    try {
      const data = await api.me()
      if (state.revision === revision) {
        // The offer comes from ledger history, not browser memory, so reloads
        // and other devices rediscover the same authoritative Put Back action.
        // `undefined` keeps compatibility with an old API during rolling deploys.
        if (data.undoOffer !== undefined) {
          clearTimer(undoTimer)
          undoTimer = undefined
          set({ data, error: null, undo: data.undoOffer })
          if (data.undoOffer) armUndoExpiry(data.undoOffer.opId, data.undoOffer.undoExpiresAt)
        } else {
          set({ data, error: null })
        }
      }
    } catch (err) {
      if (state.revision === revision) set({ error: err as Error })
    }
  })()
  const currentRequest = { revision, promise }
  loadMeRequest = currentRequest
  void promise.finally(() => {
    if (loadMeRequest === currentRequest) loadMeRequest = null
  })
  return promise
}

export async function drink(
  options: { confirmedAnother?: boolean } = {},
): Promise<DrinkResponse | null> {
  if (state.busy || state.offline || !state.data || state.data.totalRemaining === 0) return null
  // This is the mutation-boundary guard. The UI opens a warning dialog first,
  // but no other caller can bypass that warning and create another opId.
  if (state.undo && !options.confirmedAnother) return null

  set({ busy: true, error: null })
  // Deliberately generated only after the confirmation layer calls this function.
  const key = crypto.randomUUID()
  try {
    const result = await api.drink(key)
    clearMutationTimers()
    const allocations = state.data.allocations.map((allocation) =>
      (result.allocRowKey
        ? allocation.allocRowKey === result.allocRowKey
        : allocation.batchId === result.batchId)
        ? {
            ...allocation,
            consumed: allocation.consumed + 1,
            remaining: Math.max(0, allocation.remaining - 1),
          }
        : allocation,
    )
    const undo: UndoOffer = {
      opId: result.opId,
      batchLabel: result.batchLabel,
      allocRowKey: result.allocRowKey || '',
      batchId: result.batchId,
      createdAt: result.createdAt,
      undoExpiresAt: result.undoExpiresAt,
    }
    set({
      data: { ...state.data, totalRemaining: result.remainingTotal, allocations },
      undo,
      notice: { text: 'Drink 1', until: Date.now() + SUCCESS_NOTICE_SECONDS * 1000 },
      revision: state.revision + 1,
    })
    noticeTimer = setTimeout(() => {
      noticeTimer = undefined
      if (state.notice) set({ notice: null })
    }, SUCCESS_NOTICE_SECONDS * 1000)
    armUndoExpiry(result.opId, result.undoExpiresAt)
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
  if (!offer || state.busy || state.offline) return
  const deadline = Date.parse(offer.undoExpiresAt)
  if (Number.isFinite(deadline) && Date.now() > deadline) {
    set({ undo: null })
    return
  }

  set({ busy: true, error: null })
  try {
    const result = await api.undo(offer.opId, crypto.randomUUID())
    reversedDrinkOps.add(offer.opId)
    clearTimer(noticeTimer)
    noticeTimer = undefined
    clearTimer(undoTimer)
    undoTimer = undefined
    set({
      data: state.data ? { ...state.data, totalRemaining: result.remainingTotal } : state.data,
      undo: null,
      notice: null,
      revision: state.revision + 1,
    })
    void loadMe()
  } catch (err) {
    const error = err as Error
    if (
      error instanceof ApiError &&
      (
        error.code === 'UNDO_WINDOW_EXPIRED'
        || error.code === 'ALREADY_UNDONE'
        || error.code === 'NOT_LATEST_CONSUME'
      )
    ) {
      clearTimer(undoTimer)
      undoTimer = undefined
      set({ undo: null, error })
    } else {
      set({ error })
    }
  } finally {
    set({ busy: false })
  }
}

export function wasDrinkUndone(opId: string): boolean {
  return reversedDrinkOps.has(opId)
}

export function dismissCoffeeError(): void {
  set({ error: null })
}

export function resetCoffeeStore(): void {
  clearMutationTimers()
  listeners.clear()
  loadMeRequest = null
  reversedDrinkOps.clear()
  state = initial()
}
