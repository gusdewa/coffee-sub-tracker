import { describe, test, expect } from 'vitest'
import { buildPwaOptions } from '../../pwa.config'

/**
 * The service worker must never cache a credential or an authenticated
 * response.
 *
 * Workbox only handles routes you configure, so today the API is uncached
 * simply because nothing matches it. That is a property of the current config,
 * not a guarantee — a future contributor adding a broad runtimeCaching rule
 * could start caching balances and audit history without noticing. These tests
 * assert the intent by *behaviour*, so a rule cannot drift from its label.
 */

const API = 'https://simo-digitalassets-svc-coffee-sub.azurewebsites.net'
const PAGES = 'https://gusdewa.github.io'
const BASE = '/coffee-sub-tracker/'

const options = buildPwaOptions({ base: BASE, apiBaseUrl: API })
const runtime = options.workbox?.runtimeCaching ?? []

type Rule = (typeof runtime)[number]

/** Does this rule match the given URL? */
function matches(rule: Rule, url: string): boolean {
  const pattern = rule.urlPattern
  if (pattern instanceof RegExp) return pattern.test(url)
  if (typeof pattern === 'string') return url === pattern
  if (typeof pattern === 'function') {
    return Boolean(
      (pattern as (o: { url: URL; request: Request; sameOrigin: boolean; event: unknown }) => unknown)({
        url: new URL(url),
        request: new Request(url),
        sameOrigin: new URL(url).origin === PAGES,
        event: {},
      }),
    )
  }
  return false
}

const API_URLS = [
  `${API}/api/me`,
  `${API}/api/me/drinks`,
  `${API}/api/me/history`,
  `${API}/api/balances`,
  `${API}/api/admin/members`,
  `${API}/api/admin/link-audit`,
  `${API}/api/qa/redeem`,
]

describe('service worker strategy', () => {
  test('uses generateSW — we need no custom runtime logic', () => {
    expect(options.strategies).toBe('generateSW')
  })

  test('prompts rather than auto-updating, so a bundle never swaps mid-tap', () => {
    expect(options.registerType).toBe('prompt')
    expect(options.workbox?.skipWaiting).toBe(false)
    expect(options.workbox?.clientsClaim).toBe(false)
  })

  test('cleans up outdated caches so a stale worker cannot pin old assets', () => {
    expect(options.workbox?.cleanupOutdatedCaches).toBe(true)
  })

  test('falls back to the app shell for navigations', () => {
    expect(options.workbox?.navigateFallback).toBe(`${BASE}index.html`)
  })
})

describe('the API is never cached', () => {
  test('every rule that matches an API request is NetworkOnly', () => {
    for (const url of API_URLS) {
      const hits = runtime.filter((r) => matches(r, url))
      expect(hits.length, `no rule governs ${url}`).toBeGreaterThan(0)
      for (const rule of hits) {
        expect(rule.handler, `${url} must never be cached`).toBe('NetworkOnly')
      }
    }
  })

  test('the never-cache rule does not swallow same-origin assets', () => {
    const apiRule = runtime.find((r) => matches(r, API_URLS[0]!))!
    expect(matches(apiRule, `${PAGES}${BASE}assets/index.js`)).toBe(false)
    expect(matches(apiRule, `${PAGES}${BASE}index.html`)).toBe(false)
  })

  test('precache globs cover assets only — never an API path or JSON', () => {
    const globs = options.workbox?.globPatterns ?? []
    expect(globs.length).toBeGreaterThan(0)
    for (const g of globs) expect(g).not.toContain('api')
    expect(globs.join(',')).not.toMatch(/\.json/)
  })

  test('a missing API base matches nothing rather than everything', () => {
    // The dangerous failure would be an empty origin matching all requests.
    const broken = buildPwaOptions({ base: BASE, apiBaseUrl: '' })
    const rules = broken.workbox?.runtimeCaching ?? []
    for (const rule of rules) {
      expect(matches(rule, `${PAGES}${BASE}assets/index.js`)).toBe(false)
    }
  })
})

describe('manifest meets Chrome installability criteria', () => {
  const m = options.manifest as {
    name?: string
    short_name?: string
    start_url?: string
    scope?: string
    display?: string
    prefer_related_applications?: boolean
    icons?: Array<{ src: string; sizes: string; purpose?: string }>
  }

  test('has the required identity and display fields', () => {
    expect(m.name).toBeTruthy()
    expect(m.short_name).toBeTruthy()
    expect(m.start_url).toBe(BASE)
    expect(m.scope).toBe(BASE)
    expect(['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay']).toContain(m.display)
    expect(m.prefer_related_applications ?? false).toBe(false)
  })

  test('ships 192 and 512 icons plus a maskable one', () => {
    const icons = m.icons ?? []
    expect(icons.some((i) => i.sizes === '192x192')).toBe(true)
    expect(icons.some((i) => i.sizes === '512x512')).toBe(true)
    expect(
      icons.some((i) => (i.purpose ?? '').includes('maskable')),
      'Android crops non-maskable icons into a circle',
    ).toBe(true)
  })

  test('icon paths are absolute under the project base', () => {
    for (const icon of m.icons ?? []) {
      expect(icon.src.startsWith(BASE), `${icon.src} must be base-absolute`).toBe(true)
    }
  })
})
