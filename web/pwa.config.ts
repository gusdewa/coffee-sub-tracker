import type { VitePWAOptions } from 'vite-plugin-pwa'

/**
 * PWA configuration, kept in its own module so it can be asserted in tests.
 *
 * The security-critical property here is that **no authenticated response is
 * ever cached**. Workbox only handles routes you configure, so the API would
 * be uncached today even with no rule at all — but that is an accident of the
 * current config rather than a guarantee. The explicit `NetworkOnly` rule below
 * states the intent, and `tests/pwa/workbox-config.test.ts` fails if anyone
 * later adds a rule that would swallow API traffic.
 */

export interface PwaInputs {
  /** Vite `base`, e.g. `/coffee-sub-tracker/`. */
  base: string
  /** Origin of the trusted API, e.g. `https://…azurewebsites.net`. */
  apiBaseUrl: string
}

export function buildPwaOptions(inputs: PwaInputs): Partial<VitePWAOptions> {
  const { base } = inputs
  const apiOrigin = safeOrigin(inputs.apiBaseUrl)

  return {
    strategies: 'generateSW',
    // Never swap the bundle underneath someone mid-tap; the app asks first.
    registerType: 'prompt',
    injectRegister: null, // registration is explicit, in src/pwa/useServiceWorker.ts
    base,
    scope: base,
    includeAssets: ['icons/apple-touch-icon-180.png'],

    manifest: {
      id: base,
      name: 'Office Coffee',
      short_name: 'Coffee',
      description: 'Your coffee subscription balance, without the group chat.',
      start_url: base,
      scope: base,
      display: 'standalone',
      orientation: 'portrait',
      background_color: '#f2f4f1',
      theme_color: '#f2f4f1',
      icons: [
        { src: `${base}icons/icon-192.png`, sizes: '192x192', type: 'image/png' },
        { src: `${base}icons/icon-512.png`, sizes: '512x512', type: 'image/png' },
        {
          // Android crops a normal icon into a circle; a maskable variant keeps
          // the artwork inside the safe area instead of clipping it.
          src: `${base}icons/maskable-512.png`,
          sizes: '512x512',
          type: 'image/png',
          purpose: 'maskable',
        },
      ],
    },

    workbox: {
      // Assets only. No JSON, and nothing that could hold rendered private data.
      globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
      navigateFallback: `${base}index.html`,
      // The recovery page must never be served by the worker it exists to
      // remove, so it is always fetched from the network.
      navigateFallbackDenylist: [/unregister\.html$/],
      cleanupOutdatedCaches: true,
      // A stale worker must never keep serving an old shell indefinitely.
      clientsClaim: false,
      skipWaiting: false,
      runtimeCaching: [
        {
          // Balances, history, audit rows and the QA redemption all live here.
          // None of it may touch the Cache API.
          //
          // This MUST be a RegExp, not a function. generateSW stringifies the
          // config into the worker, so a function closing over a build-time
          // variable ships as a reference to an identifier that does not exist
          // in the service-worker scope — it type-checks, unit-tests green, and
          // throws in production. `tests/pwa/generated-sw.test.ts` asserts the
          // built artifact for exactly this reason.
          urlPattern: new RegExp(`^${escapeRegExp(apiOrigin)}/`),
          handler: 'NetworkOnly',
        },
      ],
    },

    devOptions: { enabled: false },
  }
}

function safeOrigin(value: string): string {
  try {
    return new URL(value).origin
  } catch {
    // An empty VITE_API_BASE_URL means same-origin dev. Return a sentinel that
    // cannot appear in a real URL: the dangerous failure would be an empty
    // string, which anchors a pattern that matches every request.
    return 'https://api.invalid.never-matches'
  }
}

const REGEXP_SPECIALS = new Set(['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\', '/'])

/** Escape a literal string for embedding in a RegExp source. */
function escapeRegExp(value: string): string {
  let out = ''
  for (const ch of value) out += REGEXP_SPECIALS.has(ch) ? '\\' + ch : ch
  return out
}
