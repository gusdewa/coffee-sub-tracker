import { useEffect, useState } from 'react'
import { TimeoutError, api, type BalanceRow } from '../api/client'

/**
 * Team balances for the post-Drink share recap.
 *
 * Enrichment only: the success UI never waits on it, and a slow or failed read
 * must leave an honest self-only share rather than a spinner. So the read is
 * bounded, and the answer says *why* it is missing (timeout vs error) so the
 * caption can tell the person what the message will and will not include.
 */
export const TEAM_BALANCES_TIMEOUT_MS = 5_000

export type TeamBalances =
  | { status: 'loading' }
  | { status: 'ready'; rows: BalanceRow[] }
  | { status: 'unavailable'; reason: 'timeout' | 'error' }

const LOADING: TeamBalances = { status: 'loading' }

/**
 * Fetches while `enabled`, and again whenever `key` changes (compared with
 * Object.is, like a hook dependency, so pass a primitive such as the receipt's
 * opId). Disabling, a new key, or unmounting aborts the read in flight.
 */
export function useTeamBalances(enabled: boolean, key?: unknown): TeamBalances {
  // Tagged with the key it answers, so a new key reads as loading at once
  // instead of showing the previous key's rows for a frame.
  const [settled, setSettled] = useState<{ key: unknown; value: TeamBalances } | null>(null)

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    api.balances({ timeoutMs: TEAM_BALANCES_TIMEOUT_MS, signal: controller.signal }).then(
      ({ balances }) => {
        if (!controller.signal.aborted) setSettled({ key, value: { status: 'ready', rows: balances } })
      },
      (error: unknown) => {
        // Our own abort (unmount, disable, newer key) is not a failure: nobody
        // is waiting for this answer any more.
        if (controller.signal.aborted) return
        const reason = error instanceof TimeoutError ? 'timeout' : 'error'
        setSettled({ key, value: { status: 'unavailable', reason } })
      },
    )
    return () => controller.abort()
  }, [enabled, key])

  if (!enabled || settled === null || !Object.is(settled.key, key)) return LOADING
  return settled.value
}
