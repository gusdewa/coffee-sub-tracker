import { useSyncExternalStore } from 'react'

/**
 * Whether the browser thinks it is offline.
 *
 * One source of truth, because three places need it and they must never
 * disagree: the offline banner, the Drink action, and the login screen — which
 * needs it before there is any session at all, so it cannot come from the
 * coffee store.
 */

let offline = typeof navigator === 'undefined' ? false : !navigator.onLine
const listeners = new Set<() => void>()

function set(next: boolean): void {
  if (next === offline) return
  offline = next
  for (const listener of listeners) listener()
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => set(false))
  window.addEventListener('offline', () => set(true))
}

export const isOffline = (): boolean => offline

export function subscribeOnline(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useOffline(): boolean {
  return useSyncExternalStore(subscribeOnline, isOffline, isOffline)
}
