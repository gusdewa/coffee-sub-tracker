import { test, expect, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import { startServer, type SwappableServer } from './server'
import { signedInShell, loginScreen, API } from './fixtures'

/**
 * Login and Home, on real phone metrics.
 *
 * The questions a browser answers and jsdom cannot: does the call to action
 * survive 200% text in a 342px-tall landscape viewport, does the last card
 * clear the floating Drink action at the absolute end of the scroll, and is
 * anything clipped rather than scrolled.
 */

const WEB = fileURLToPath(new URL('..', import.meta.url))
const BUILD = resolve(WEB, '.e2e/shell')
const EVIDENCE = resolve(WEB, '../.qa-evidence')

let server: SwappableServer

test.beforeAll(async () => {
  execFileSync('npx', ['vite', 'build', '--outDir', BUILD, '--emptyOutDir'], {
    cwd: WEB,
    env: {
      ...process.env,
      GITHUB_SHA: 'shell000',
      VITEST: '',
      // The e2e server serves the GitHub Pages subpath, which is what
      // production is today. Root-base artifacts are covered in
      // tests/build/artifacts.test.ts.
      VITE_BASE_PATH: '/coffee-sub-tracker/',
      VITE_FIREBASE_API_KEY: 'AIzaSyTestOnlyNotARealKey0000000000000000',
      VITE_FIREBASE_AUTH_DOMAIN: 'e2e.firebaseapp.com',
      VITE_FIREBASE_PROJECT_ID: 'e2e-project',
      VITE_FIREBASE_APP_ID: '1:0:web:e2e',
      VITE_ALLOWED_EMAIL_DOMAIN: 'gmail.com',
      VITE_API_BASE_URL: API,
    },
    stdio: 'pipe',
  })
  mkdirSync(EVIDENCE, { recursive: true })
  server = await startServer(BUILD)
})

test.afterAll(async () => {
  await server?.close()
})

const shot = (page: Page, name: string, project: string) =>
  page.screenshot({ path: resolve(EVIDENCE, `${name}-${project}.png`), fullPage: false })

/** Axe failures name the element and the measured colours, not just the rule. */
const violations = async (page: Page) => {
  const results = await new AxeBuilder({ page }).analyze()
  return results.violations.flatMap((v) =>
    v.nodes.map((n) => `${v.id} @ ${n.target.join(' ')} :: ${(n.failureSummary ?? '').replace(/\s+/g, ' ').slice(0, 200)}`),
  )
}

/** Nothing may be wider than the viewport; a sideways scroll is always a bug here. */
const noSidewaysScroll = async (page: Page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
  )

/** Scroll the owner, not the document — that distinction is the point. */
const scrollToEnd = async (page: Page) => {
  await page.evaluate(() => {
    const main = document.querySelector('.app__main')!
    main.scrollTop = main.scrollHeight
  })
  await page.waitForTimeout(150)
}

/** True when the element's own centre is what a tap there would actually hit. */
const isReachable = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel)!
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return false
    if (r.top < 0 || r.bottom > window.innerHeight) return false
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return el === hit || el.contains(hit)
  }, selector)

test.describe('login', () => {
  test('is ready, with the call to action above the fold', async ({ page }, info) => {
    await loginScreen(page, server.url)

    const cta = page.locator('.login__cta')
    await expect(cta).toBeVisible()
    await expect(cta).toContainText('Continue with Google')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    // Decorative art must not push the button off the first screen.
    expect(await isReachable(page, '.login__cta')).toBe(true)
    expect(await noSidewaysScroll(page)).toBe(true)

    const box = (await cta.boundingBox())!
    expect(box.height).toBeGreaterThanOrEqual(48)
    await shot(page, '30-login-ready', info.project.name)
  })

  test('scrolls rather than clipping at 200% text', async ({ page }, info) => {
    await loginScreen(page, server.url)
    await page.addStyleTag({ content: 'html { font-size: 200% }' })

    // The heading must still be reachable from the top of the scroll…
    const title = page.locator('.login__title')
    await expect(title).toBeVisible()
    expect(await page.evaluate(() => document.querySelector('.login__title')!.getBoundingClientRect().top >= -1)).toBe(true)

    // …and the button reachable by scrolling, not cut off with nowhere to go.
    await page.locator('.login__cta').scrollIntoViewIfNeeded()
    expect(await isReachable(page, '.login__cta')).toBe(true)
    expect(await noSidewaysScroll(page)).toBe(true)
    await shot(page, '31-login-200pct-text', info.project.name)
  })

  test('states that it is offline, and refuses rather than failing later', async ({
    page,
    context,
  }, info) => {
    await loginScreen(page, server.url)
    await context.setOffline(true)
    await page.evaluate(() => window.dispatchEvent(new Event('offline')))

    await expect(page.locator('.login__cta')).toBeDisabled()
    await expect(page.locator('.login__status')).toContainText(/offline/i)
    await shot(page, '32-login-offline', info.project.name)

    await context.setOffline(false)
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect(page.locator('.login__cta')).toBeEnabled()
  })

  test('reports a failure inline, in words, and stays retryable', async ({ page }, info) => {
    await loginScreen(page, server.url)
    // Cut Google off so the popup cannot complete. Deterministic, unlike
    // waiting for a real credential error.
    await page.route('**/identitytoolkit.googleapis.com/**', (r) => r.abort())
    await page.route('**/*.firebaseapp.com/**', (r) => r.abort())

    await page.locator('.login__cta').click()
    const alert = page.locator('.login__error')
    await expect(alert).toBeVisible({ timeout: 30_000 })
    // Never a raw SDK code, and never a toast that scrolls away.
    await expect(alert).not.toContainText('auth/')
    await expect(page.locator('.login__cta')).toBeEnabled()
    await shot(page, '33-login-error-inline', info.project.name)
  })

  test('has no accessibility violations', async ({ page }) => {
    await loginScreen(page, server.url)
    expect(await violations(page)).toEqual([])
  })
})

test.describe('home', () => {
  test('answers the balance first, then which card is next', async ({ page }, info) => {
    await signedInShell(page, server.url)

    const slip = page.locator('.slip')
    await expect(slip.locator('.slip__number')).toHaveText('5')
    await expect(slip).toContainText('cups left')
    await expect(slip).toContainText('Next cup from')
    await expect(slip).toContainText('September beans')
    expect(await noSidewaysScroll(page)).toBe(true)
    await shot(page, '34-home-slip', info.project.name)
  })

  test('a single card still clears the action at the end of the scroll', async ({ page }) => {
    // "Short" is relative: one card plus the slip already overflows a 320x568
    // screen, so this scrolls to the end like the long case and asserts the
    // same property.
    await signedInShell(page, server.url, { batches: 1 })
    await scrollToEnd(page)
    const card = (await page.locator('.card').last().boundingBox())!
    const fab = (await page.locator('.fab').boundingBox())!
    expect(card.y + card.height).toBeLessThanOrEqual(fab.y)
  })

  test('a long list scrolls to its true end with the last card fully visible', async ({
    page,
  }, info) => {
    await signedInShell(page, server.url, { batches: 9 })

    await scrollToEnd(page)

    const atEnd = await page.evaluate(() => {
      const main = document.querySelector('.app__main')!
      return main.scrollTop >= main.scrollHeight - main.clientHeight - 1
    })
    expect(atEnd, 'main is scrolled to its absolute end').toBe(true)

    const card = (await page.locator('.card').last().boundingBox())!
    const fab = (await page.locator('.fab').boundingBox())!
    const dock = (await page.locator('.dock').boundingBox())!
    // The last card clears the floating action and the dock, with its focus
    // ring's worth of room to spare.
    expect(card.y + card.height, 'last card above the Drink action').toBeLessThanOrEqual(fab.y)
    expect(card.y + card.height, 'last card above the dock').toBeLessThanOrEqual(dock.y)
    await shot(page, '35-home-scroll-end', info.project.name)
  })

  test('the document itself never scrolls — only the column does', async ({ page }) => {
    await signedInShell(page, server.url, { batches: 9 })
    const documentScrolls = await page.evaluate(
      () => document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
    )
    expect(documentScrolls).toBe(false)
  })

  test('header, dock, action, snackbar and tour coexist without covering each other', async ({
    page,
  }, info) => {
    await signedInShell(page, server.url, { batches: 4 })
    await page.locator('.fab').click()
    await expect(page.locator('.snackbar')).toBeVisible()

    for (const sel of ['.app-header__title', '.profile__trigger', '.fab', '.snackbar__action']) {
      expect(await isReachable(page, sel), `${sel} is reachable`).toBe(true)
    }
    for (const link of await page.locator('.dock a').all()) {
      const box = (await link.boundingBox())!
      expect(box.height).toBeGreaterThanOrEqual(44)
    }
    await shot(page, '36-home-all-layers', info.project.name)
  })

  test('every dock destination and the profile control stay reachable', async ({ page }) => {
    await signedInShell(page, server.url, { batches: 9 })
    for (let i = 0; i < 4; i += 1) {
      expect(await isReachable(page, `.dock a:nth-child(${i + 1})`)).toBe(true)
    }
    expect(await isReachable(page, '.profile__trigger')).toBe(true)
  })

  test('has no accessibility violations', async ({ page }) => {
    await signedInShell(page, server.url, { batches: 3 })
    // Wait for the action to settle out of its loading state first; measuring
    // a control mid-change tells you about the change, not about the design.
    await expect(page.locator('.fab')).toBeEnabled()
    expect(await violations(page)).toEqual([])
  })
})
