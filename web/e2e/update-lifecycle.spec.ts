import { test, expect, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { rmSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer, type SwappableServer } from './server'

/**
 * The update lifecycle, end to end:
 *
 *   old tab → new build deployed → downloaded in the background →
 *   prompt visible **while signed out** → activate → new build id
 *
 * The signed-out step is the one that matters. `App.tsx` returns early for
 * auth-loading, signed-out and claim-binding, so an update control rendered
 * inside it is invisible to precisely the person whose build is broken. If the
 * broken build is what prevents sign-in, that update can never be applied.
 *
 * Two builds are produced with different injected build ids, and "deploying"
 * is pointing the server at the second one.
 */

// The web workspace is ESM, so there is no __dirname.
const WEB = fileURLToPath(new URL('..', import.meta.url))
const OUT = resolve(WEB, '.e2e')
const BUILD_A = resolve(OUT, 'a')
const BUILD_B = resolve(OUT, 'b')
const ID_A = 'aaaaaaa'
const ID_B = 'bbbbbbb'

let server: SwappableServer

function build(into: string, buildId: string): void {
  execFileSync('npx', ['vite', 'build', '--outDir', into, '--emptyOutDir'], {
    cwd: WEB,
    env: {
      ...process.env,
      GITHUB_SHA: buildId,
      VITEST: '',
      // Syntactically valid but non-functional config. Without it
      // initializeApp throws and the app never leaves its loading state, so
      // the test would be asserting against a screen no real user sees. These
      // values authenticate nothing — sign-in is never attempted here.
      VITE_FIREBASE_API_KEY: 'AIzaSyTestOnlyNotARealKey0000000000000000',
      VITE_FIREBASE_AUTH_DOMAIN: 'e2e.firebaseapp.com',
      VITE_FIREBASE_PROJECT_ID: 'e2e-project',
      VITE_FIREBASE_APP_ID: '1:0:web:e2e',
      VITE_ALLOWED_EMAIL_DOMAIN: 'gmail.com',
      VITE_API_BASE_URL: 'https://api.invalid.e2e',
    },
    stdio: 'pipe',
  })
}

test.beforeAll(async () => {
  if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })
  build(BUILD_A, ID_A)
  // Build B is A rebuilt with a different id, so every asset hash moves — the
  // same thing a real deploy does.
  build(BUILD_B, ID_B)
  server = await startServer(BUILD_A)
})

test.afterAll(async () => {
  await server?.close()
})

/**
 * Register the worker and become controlled by it.
 *
 * `clientsClaim` is deliberately false, so the very first load registers the
 * worker but is never controlled by it — control arrives on the next
 * navigation. That is the real user flow (first visit, then a later one), and
 * the test has to walk it rather than wait for something that cannot happen.
 *
 * Returns false when the browser did not activate a worker at all, so a spec
 * can skip instead of failing on an environment quirk.
 */
async function becomeControlled(page: Page, url: string): Promise<boolean> {
  // Distinguish "this browser has no service workers" from "our app failed to
  // register one". Only the former may skip; the latter is the regression this
  // suite exists to catch, and skipping it would hide exactly that.
  const supported = await page.evaluate(() => 'serviceWorker' in navigator)
  if (!supported) return false

  const activated = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return false
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const reg = await navigator.serviceWorker.getRegistration()
      if (reg?.active) return true
      await new Promise((r) => setTimeout(r, 250))
    }
    return false
  })
  if (!activated) {
    throw new Error(
      'the app registered no service worker while signed out — the update path ' +
        'is unreachable before sign-in',
    )
  }

  // Second navigation: now the worker controls the page.
  await page.goto(url)
  return page.evaluate(async () => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (navigator.serviceWorker.controller) return true
      await new Promise((r) => setTimeout(r, 250))
    }
    return false
  })
}

test.describe('update lifecycle', () => {
  test('an old signed-out tab is offered a new build and lands on it', async ({
    page,
    browserName,
  }) => {
    test.slow()
    server.serve(BUILD_A)

    await page.goto(server.url)
    // Signed out: no Firebase config is supplied, so this is the sign-in screen.
    await expect(page.getByRole('button', { name: /sign in with google/i })).toBeVisible()

    const controlled = await becomeControlled(page, server.url)
    test.skip(
      !controlled,
      `${browserName} did not activate a service worker in this environment`,
    )
    // Controlled now, and still signed out.
    await expect(page.getByRole('button', { name: /sign in with google/i })).toBeVisible()

    // Nothing to update yet.
    await expect(page.locator('.update')).toHaveCount(0)

    // --- the deploy -------------------------------------------------------
    server.serve(BUILD_B)

    // Background download: ask the worker to check, as the app does on
    // visibility regain, and wait for the new build to finish installing.
    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration()
      await reg?.update()
    })

    // --- the prompt, while still signed out --------------------------------
    const prompt = page.locator('.update')
    await expect(prompt).toBeVisible({ timeout: 30_000 })
    await expect(prompt).toContainText('A new version is ready')
    // Still on the sign-in screen — this is the whole point.
    await expect(page.getByRole('button', { name: /sign in with google/i })).toBeVisible()
    // Running the OLD build at this moment.
    await expect(prompt).toContainText(ID_A)

    // --- activate ----------------------------------------------------------
    await page.getByRole('button', { name: /^reload$/i }).click()

    // --- the new build -----------------------------------------------------
    // Activation reloads the tab, so anything evaluated here races a destroyed
    // execution context. Locator assertions retry across navigation; a raw
    // page.evaluate does not.
    await page.waitForLoadState('load')
    await expect(page.getByRole('button', { name: /sign in with google/i })).toBeVisible()

    const servedBuild = await page.evaluate(async () => {
      const html = await (await fetch('./index.html', { cache: 'no-store' })).text()
      const src = html.match(/assets\/index-[^"]+\.js/)?.[0] ?? ''
      if (!src) return ''
      return (await (await fetch('./' + src, { cache: 'no-store' })).text()).includes('bbbbbbb')
        ? 'B'
        : 'A'
    })
    expect(servedBuild, 'the activated worker still serves the old build').toBe('B')

    // The prompt clears itself once there is nothing left to apply.
    await expect(page.locator('.update')).toHaveCount(0)
  })

  test('the worker never caches the API and queues no mutation', async ({ page, browserName }) => {
    server.serve(BUILD_A)
    await page.goto(server.url)
    const controlled = await becomeControlled(page, server.url)
    test.skip(!controlled, `${browserName} did not activate a service worker`)

    const sw = await page.evaluate(async () => {
      const res = await fetch('./sw.js', { cache: 'no-store' })
      return res.text()
    })

    // NetworkOnly for the API origin, and no caching strategy anywhere near it.
    expect(sw).toContain('NetworkOnly')
    for (const caching of ['CacheFirst', 'StaleWhileRevalidate', 'NetworkFirst', 'CacheOnly']) {
      expect(sw, `${caching} must not appear`).not.toContain(caching)
    }
    // No background sync: a coffee mutation is never queued or replayed.
    for (const queue of ['BackgroundSync', 'workbox-background-sync', 'Queue(']) {
      expect(sw, `${queue} would replay a mutation`).not.toContain(queue)
    }

    // Nothing under /api/ was precached.
    const precachedApi = await page.evaluate(async () => {
      const keys = await caches.keys()
      for (const key of keys) {
        const cache = await caches.open(key)
        const reqs = await cache.keys()
        if (reqs.some((r) => r.url.includes('/api/'))) return true
      }
      return false
    })
    expect(precachedApi, 'an API response reached the cache').toBe(false)
  })

  test('the reset page is never served by the worker', async ({ page, browserName }) => {
    server.serve(BUILD_A)
    await page.goto(server.url)
    const controlled = await becomeControlled(page, server.url)
    test.skip(!controlled, `${browserName} did not activate a service worker`)

    // navigateFallback would otherwise hand back the app shell, making the one
    // escape hatch from a wedged worker unreachable.
    await page.goto(`${server.url}unregister.html`)
    await expect(page.getByRole('heading', { name: /resetting/i })).toBeVisible()
  })
})
