/**
 * Tracks in-flight mutations so an update never reloads over one.
 *
 * A drink is a transaction. Reloading between the request leaving and the
 * response arriving would leave the person staring at a balance they cannot
 * explain — and while the idempotency key means the server would not double
 * count, the *user* has no way to know that. So activation waits.
 *
 * A counter rather than a boolean: two mutations can overlap, and the guard
 * must not lift when the first of them finishes.
 */

let inFlight = 0
const listeners = new Set<(busy: boolean) => void>()

function notify(): void {
  const busy = inFlight > 0
  for (const listener of listeners) listener(busy)
}

export function beginMutation(): void {
  inFlight += 1
  notify()
}

export function endMutation(): void {
  // Never go negative: a stuck-negative counter would silently disable the
  // guard for the rest of the session.
  inFlight = Math.max(0, inFlight - 1)
  notify()
}

export function isMutating(): boolean {
  return inFlight > 0
}

export function onMutationChange(listener: (busy: boolean) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Run a mutating call inside the guard.
 *
 * `finally` is what makes this correct: a failed request must release the
 * guard too, or one network error would block updates forever.
 */
export async function withMutationGuard<T>(fn: () => Promise<T>): Promise<T> {
  beginMutation()
  try {
    return await fn()
  } finally {
    endMutation()
  }
}

/** Test-only: reset module state between cases. */
export function resetMutationGuard(): void {
  inFlight = 0
  listeners.clear()
}
