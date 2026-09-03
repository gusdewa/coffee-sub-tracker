import { useCallback, useEffect } from 'react'
import { shouldAutoStart, startTour } from './tour'

/**
 * Decides when the walkthrough runs, and hands back a way to replay it.
 *
 * The update check is a DOM query rather than the service-worker hook on
 * purpose: tests/pwa/update-reachability.test.ts forbids App.tsx from importing
 * anything update-shaped, and calling registerSW a second time to find out would
 * be a worse cure than the disease. The prompt renders `.update` when a build is
 * waiting, so that is the signal — the same one-way channel the CSS uses.
 */
export function useOnboarding(ready: boolean): () => void {
  useEffect(() => {
    if (!ready) return
    const updatePending = document.querySelector('.update') !== null
    if (!shouldAutoStart({ ready, updatePending })) return

    // A beat for the shell to settle before anything is measured and spotlit.
    const timer = setTimeout(() => void startTour(), 350)
    return () => clearTimeout(timer)
  }, [ready])

  return useCallback(() => void startTour(), [])
}
