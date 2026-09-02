import { useEffect, useRef, useState } from 'react'

/**
 * Service-worker lifecycle.
 *
 * Registration is `prompt`, not `autoUpdate`: a balance app must not swap its
 * bundle underneath someone mid-tap. When a new worker is waiting we surface a
 * banner and only activate it when the person asks.
 *
 * Everything here degrades to a no-op. A browser with no service-worker
 * support, a worker evicted by the OS, or a registration that simply fails
 * must all leave a working online app rather than a broken shell.
 */
export interface ServiceWorkerState {
  needsRefresh: boolean
  offlineReady: boolean
  /** Activates the waiting worker and reloads. No-op when nothing is waiting. */
  update: () => void
}

export function useServiceWorker(): ServiceWorkerState {
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [offlineReady, setOfflineReady] = useState(false)
  const updateRef = useRef<(reload?: boolean) => Promise<void>>(async () => {})

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
          onRegisterError(err: unknown) {
            // A failed registration is survivable — the app still works online.
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

  return {
    needsRefresh,
    offlineReady,
    update: () => {
      void updateRef.current(true)
    },
  }
}
