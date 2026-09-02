import { describe, test, expect, beforeAll } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Assertions against the **built service worker**, not the config that
 * produced it.
 *
 * This file exists because a config-level test is not sufficient. `generateSW`
 * stringifies the runtimeCaching config into the worker, so a `urlPattern`
 * written as a function closing over a build-time variable ships as a bare
 * identifier that does not exist in the service-worker scope. It type-checks,
 * the config test passes because Node still has the closure, and the deployed
 * worker throws on every request.
 *
 * That happened. These tests read the artifact instead.
 *
 * Skipped when `dist/sw.js` is absent so `npm test` works without a prior
 * build; CI runs the build first, so the guard is live where it matters.
 */

const SW = resolve(__dirname, '../../dist/sw.js')

// Only assert against a *real* generated worker. A stale dev stub would
// otherwise be mistaken for the artifact and produce misleading failures.
const isRealWorker = existsSync(SW) && readFileSync(SW, 'utf8').includes('precacheAndRoute')
const suite = isRealWorker ? describe : describe.skip

let sw = ''
beforeAll(() => {
  if (isRealWorker) sw = readFileSync(SW, 'utf8')
})

suite('generated service worker', () => {
  test('references the real API origin, not a build-time identifier', () => {
    // Match the host label, not "azurewebsites.net": the origin is embedded as
    // an escaped RegExp source, so the dots appear as "\." in the artifact.
    expect(sw).toContain('simo-digitalassets-svc-coffee-sub')
    expect(sw).toContain('azurewebsites')
    // The exact failure we shipped once: a closure variable name surviving
    // into the worker, where it is undefined at runtime.
    expect(sw).not.toMatch(/\bapiOrigin\b/)
    expect(sw).not.toMatch(/\bapiBaseUrl\b/)
  })

  test('the only handler bound to the API is NetworkOnly', () => {
    // Find every registerRoute call and check none pairs a caching strategy
    // with a pattern mentioning the API host.
    const routes = sw.match(/registerRoute\([^;]*/g) ?? []
    const apiRoutes = routes.filter((r) => r.includes('azurewebsites'))
    expect(apiRoutes.length, 'expected a route governing the API').toBeGreaterThan(0)
    for (const route of apiRoutes) {
      expect(route).toContain('NetworkOnly')
      for (const caching of ['CacheFirst', 'StaleWhileRevalidate', 'NetworkFirst', 'CacheOnly']) {
        expect(route, `API route must not use ${caching}`).not.toContain(caching)
      }
    }
  })

  test('precaches assets only — no API path, no JSON payload', () => {
    const precached = sw.match(/"[^"]*\.(?:js|css|html|png|svg|woff2|json)"/g) ?? []
    expect(precached.length).toBeGreaterThan(3)
    for (const entry of precached) {
      expect(entry).not.toContain('/api/')
      expect(entry, 'a precached .json could hold rendered private data').not.toMatch(/\.json"$/)
    }
  })

  test('activates only when the page asks — never unprompted', () => {
    // `prompt` mode is *supposed* to contain skipWaiting: the page posts
    // SKIP_WAITING when the person taps Reload. What must not exist is an
    // unconditional call, which would swap the bundle mid-tap.
    expect(sw).toMatch(/SKIP_WAITING[\s\S]{0,60}skipWaiting\(\)/)
    expect(sw).not.toContain('clientsClaim()')
  })

  test('cleans up outdated caches', () => {
    expect(sw).toMatch(/cleanupOutdatedCaches/)
  })
})
