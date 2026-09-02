import { useCallback, useEffect, useRef, useState } from 'react'
import { isMutating, onMutationChange } from './mutationGuard'

/**
 * Service-worker lifecycle.
 *
 * Registration is `prompt`, not `autoUpdate`: this app is transactional, and a
 * bundle must not swap underneath someone mid-tap. A new build downloads
 * quietly; activating it is the person's decision.
 *
 * Everything degrades to a no-op. No service-worker support, a worker evicted
 * by the OS, or a registration that simply fails must all leave a working
 * online app rather than a broken shell.
 */

/** How long to wait for the new worker to take over before forcing a reload. */
const ACTIVATION_TIMEOUT_MS = 10_000
/** Periodic check while a tab stays open. */
const POLL_INTERVAL_MS = 30 * 60 * 1000

/** Module-level, so a controllerchange in any hook instance reloads only once. */
let reloading = false

export interface ServiceWorkerState {
  /** A new build is downloaded and waiting. */
  needsRefresh: boolean
  offlineReady: boolean
  /** Another tab activated the update; this tab is now running stale code. */
  updatedElsewhere: boolean
  /** True while a mutation is in flight — activation defers until it clears. */
  blockedByMutation: boolean
  /** Activate the waiting worker and reload. No-op when nothing is waiting. */
  update: () => void
}

export function useServiceWorker(): ServiceWorkerState {
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [offlineReady, setOfflineReady] = useState(false)
  const [updatedElsewhere, setUpdatedElsewhere] = useState(false)
  const [blockedByMutation, setBlockedByMutation] = useState(isMutating())

  const updateRef = useRef<(reload?: boolean) => Promise<void>>(async () => {})
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null)
  /** Set when *this* tab asked for the update, so only it reloads itself. */
  const initiatedRef = useRef(false)
  const pendingRef = useRef(false)

  // --- registration --------------------------------------------------------
  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const { registerSW } = await import('virtual:pwa-register')
        const update = registerSW({
          immediate: true,
          onNeedRefresh() {
            if (!cancelled) setNeedsRefresh(true)
          },
          onOfflineReady() {
            if (!cancelled) setOfflineReady(true)
          },
          onRegistered(registration: ServiceWorkerRegistration | undefined) {
            registrationRef.current = registration ?? null
          },
          onRegisterError(err: unknown) {
            // Survivable: the app still works online without a worker.
            console.warn('[pwa] registration failed', (err as Error)?.name)
          },
        })
        updateRef.current = update
      } catch {
        // No service-worker support, or the virtual module is absent in tests.
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  // --- update checks -------------------------------------------------------
  // Startup is covered by registration itself. These are the moments a phone
  // is most likely to have missed a deploy: coming back to the tab, coming
  // back online, and simply having been open a long time.
  useEffect(() => {
    const check = () => {
      void registrationRef.current?.update().catch(() => {
        // A failed check is not worth surfacing; the next trigger retries.
      })
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') check()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', check)
    const timer = window.setInterval(check, POLL_INTERVAL_MS)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', check)
      window.clearInterval(timer)
    }
  }, [])

  // --- controller changes --------------------------------------------------
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const onControllerChange = () => {
      if (reloading) return
      if (initiatedRef.current) {
        // This tab asked for it — complete the journey.
        reloading = true
        window.location.reload()
        return
      }
      // Another tab activated the update. Do not yank this one out from under
      // whatever the person is doing; offer the reload instead.
      setUpdatedElsewhere(true)
    }
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)
    return () =>
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
  }, [])

  // --- mutation guard ------------------------------------------------------
  useEffect(() => {
    const unsubscribe = onMutationChange((busy) => {
      setBlockedByMutation(busy)
      // An update requested mid-tap runs as soon as the tap settles.
      if (!busy && pendingRef.current) {
        pendingRef.current = false
        activate()
      }
    })
    return () => {
      unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const activate = useCallback(() => {
    initiatedRef.current = true
    void updateRef.current(true)
    // If the worker never takes over — a wedged waiting worker, a browser that
    // does not fire controllerchange — reload anyway rather than leave a
    // prompt that does nothing when tapped.
    window.setTimeout(() => {
      if (!reloading) {
        reloading = true
        window.location.reload()
      }
    }, ACTIVATION_TIMEOUT_MS)
  }, [])

  const update = useCallback(() => {
    if (isMutating()) {
      // Defer rather than refuse: the person asked, and it will happen.
      pendingRef.current = true
      setBlockedByMutation(true)
      return
    }
    activate()
  }, [activate])

  return { needsRefresh, offlineReady, updatedElsewhere, blockedByMutation, update }
}

/** Test-only: clear the module-level reload latch between cases. */
export function resetReloadLatch(): void {
  reloading = false
}
