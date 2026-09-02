/**
 * Stand-in for `virtual:pwa-register`, which only exists when the PWA plugin
 * runs — and the plugin is deliberately excluded under test so it cannot
 * regenerate a dev stub over the built service worker.
 *
 * Aliased in vite.config.ts for the test environment only. Suites that care
 * about registration behaviour override this with `vi.mock`.
 */
export function registerSW(_options?: {
  immediate?: boolean
  onNeedRefresh?: () => void
  onOfflineReady?: () => void
  onRegistered?: (registration: ServiceWorkerRegistration | undefined) => void
  onRegisterError?: (error: unknown) => void
}): (reloadPage?: boolean) => Promise<void> {
  return async () => {}
}
