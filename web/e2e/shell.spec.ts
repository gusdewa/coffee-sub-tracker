import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer, type SwappableServer } from './server'
import { signedInShell, API } from './fixtures'

/**
 * The shell, on real phone metrics.
 *
 * These assertions are geometric rather than pixel-exact on purpose. A stored
 * screenshot baseline renders differently on macOS and on the Linux runner, so
 * it would churn on every push and teach everyone to ignore it. What actually
 * matters here survives that difference: four labels that do not clip at 320px,
 * targets that clear 44px, nothing scrolling sideways, and the Drink action and
 * the update prompt never occupying the same space.
 *
 * Screenshots are still captured, as evidence rather than as assertions.
 */

const WEB = fileURLToPath(new URL('..', import.meta.url))
const BUILD = resolve(WEB, '.e2e/shell')
const EVIDENCE = resolve(WEB, '../.qa-evidence')

let server: SwappableServer

test.beforeAll(async () => {
  // Always rebuild. Guarding on existence let a stale or misconfigured build
  // survive between runs, which fails as "the shell never rendered" a long way
  // from the cause. It takes under two seconds.
  {
    execFileSync('npx', ['vite', 'build', '--outDir', BUILD, '--emptyOutDir'], {
      cwd: WEB,
      env: {
        ...process.env,
        GITHUB_SHA: 'shell000',
        VITEST: '',
        VITE_FIREBASE_API_KEY: 'AIzaSyTestOnlyNotARealKey0000000000000000',
        VITE_FIREBASE_AUTH_DOMAIN: 'e2e.firebaseapp.com',
        VITE_FIREBASE_PROJECT_ID: 'e2e-project',
        VITE_FIREBASE_APP_ID: '1:0:web:e2e',
        VITE_ALLOWED_EMAIL_DOMAIN: 'gmail.com',
        VITE_API_BASE_URL: API,
      },
      stdio: 'pipe',
    })
  }
  mkdirSync(EVIDENCE, { recursive: true })
  server = await startServer(BUILD)
})

test.afterAll(async () => {
  await server?.close()
})

const shot = async (page: import('@playwright/test').Page, name: string, project: string) => {
  await page.screenshot({ path: resolve(EVIDENCE, `${name}-${project}.png`) })
}

test('the dock shows four labelled destinations and nothing else', async ({ page }, info) => {
  await signedInShell(page, server.url)

  const links = page.locator('.dock a')
  await expect(links).toHaveCount(4)
  await expect(links.nth(0)).toContainText('Mine')
  await expect(links.nth(1)).toContainText('Team')
  await expect(links.nth(2)).toContainText('Cards')
  await expect(links.nth(3)).toContainText('History')

  // Sign out is not a destination.
  await expect(page.locator('.dock')).not.toContainText(/sign out/i)
  await expect(page.locator('.fab')).toContainText('Drink')
  await shot(page, '20-shell-mine', info.project.name)
})

test('every dock target and the Drink action clear 44px', async ({ page }) => {
  await signedInShell(page, server.url)

  for (const handle of await page.locator('.dock a').all()) {
    const box = (await handle.boundingBox())!
    expect(box.width, 'dock target width').toBeGreaterThanOrEqual(44)
    expect(box.height, 'dock target height').toBeGreaterThanOrEqual(44)
  }
  const fab = (await page.locator('.fab').boundingBox())!
  expect(fab.height).toBeGreaterThanOrEqual(44)
  expect(fab.width).toBeGreaterThanOrEqual(44)
})

test('labels are not clipped and the page never scrolls sideways', async ({ page }) => {
  await signedInShell(page, server.url)

  const overflowing = await page.evaluate(() =>
    [...document.querySelectorAll('.dock__label')].filter(
      (el) => el.scrollWidth > el.clientWidth + 1,
    ).length,
  )
  expect(overflowing, 'clipped dock labels').toBe(0)

  const scrolls = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  )
  expect(scrolls, 'horizontal page scroll').toBe(false)
})

test('the active destination changes as you move, and is not colour alone', async ({ page }, info) => {
  await signedInShell(page, server.url)
  await expect(page.locator('.dock a.active')).toContainText('Mine')

  await page.locator('.dock a', { hasText: 'History' }).click()
  await expect(page.locator('.dock a.active')).toContainText('History')
  await expect(page.locator('.dock a[aria-current="page"]')).toContainText('History')

  // The punched pill is a real background, not just a text colour. Polled
  // rather than read once: the fill transitions over 140ms, and WebKit samples
  // it at t=0 often enough that a single read is a coin toss.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const pill = document.querySelector('.dock a.active .dock__pill')!
          return getComputedStyle(pill).backgroundColor
        }),
      { message: 'active pill never became filled' },
    )
    .not.toBe('rgba(0, 0, 0, 0)')
  await shot(page, '21-shell-history-active', info.project.name)
})

test('a cup can be taken from any screen, and put back', async ({ page }, info) => {
  const api = await signedInShell(page, server.url)
  await page.locator('.dock a', { hasText: 'History' }).click()
  await expect(page.locator('.dock a.active')).toContainText('History')

  await page.locator('.fab').click()
  await expect(page.locator('.snackbar')).toContainText('One cup from September beans.')
  expect(api.drinks()).toBe(1)
  await shot(page, '22-shell-undo-offered', info.project.name)

  await page.locator('.snackbar__action').click()
  await expect(page.locator('.snackbar')).toHaveCount(0)
})

test('the snackbar and the Drink action never overlap', async ({ page }) => {
  await signedInShell(page, server.url)
  await page.locator('.fab').click()
  await expect(page.locator('.snackbar')).toBeVisible()

  const fab = (await page.locator('.fab').boundingBox())!
  const bar = (await page.locator('.snackbar').boundingBox())!
  // The snackbar takes its own line above the action rather than sharing it.
  expect(bar.y + bar.height).toBeLessThanOrEqual(fab.y + 1)
})

test('the Drink action rides above the update prompt when one appears', async ({ page }) => {
  await signedInShell(page, server.url)
  const before = (await page.locator('.fab').boundingBox())!

  // The prompt publishes its height as --update-h; this is that channel.
  await page.evaluate(() => document.documentElement.style.setProperty('--update-h', '80px'))
  const after = (await page.locator('.fab').boundingBox())!

  expect(before.y - after.y).toBeGreaterThan(70)
})

test('the profile menu holds identity, Manage and a separated Sign out', async ({ page }, info) => {
  await signedInShell(page, server.url, { role: 'admin' })

  await page.locator('.profile__trigger').click()
  const menu = page.getByRole('menu')
  await expect(menu).toContainText('Dewa Wijaya')
  await expect(menu).toContainText('Admin')
  await expect(menu.getByRole('menuitem', { name: /manage members/i })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /sign out/i })).toBeVisible()
  await shot(page, '23-shell-profile-admin', info.project.name)

  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(page.locator('.profile__trigger')).toBeFocused()
})

test('a member sees no Manage entry', async ({ page }) => {
  await signedInShell(page, server.url, { role: 'member' })
  await page.locator('.profile__trigger').click()
  await expect(page.getByRole('menu')).toContainText('Member')
  await expect(page.getByRole('menuitem', { name: /manage members/i })).toHaveCount(0)
})

test('an empty balance disables the action and says so', async ({ page }, info) => {
  await signedInShell(page, server.url, { remaining: 0 })
  await expect(page.locator('.fab')).toBeDisabled()
  await expect(page.locator('#fab-help')).toHaveText('You have no cups remaining.')
  await shot(page, '24-shell-zero-balance', info.project.name)
})

test('going offline disables the action rather than failing the tap', async ({ page, context }, info) => {
  await signedInShell(page, server.url)
  await expect(page.locator('.fab')).toBeEnabled()

  await context.setOffline(true)
  await page.evaluate(() => window.dispatchEvent(new Event('offline')))

  await expect(page.locator('.fab')).toBeDisabled()
  await expect(page.locator('.offline')).toBeVisible()
  await shot(page, '25-shell-offline', info.project.name)

  await context.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(page.locator('.fab')).toBeEnabled()
})

test('the walkthrough runs, can be stepped through, and does not come back', async ({ page }, info) => {
  await signedInShell(page, server.url, { tourSeen: false })

  const popover = page.locator('.driver-popover')
  await expect(popover).toBeVisible({ timeout: 20_000 })
  await expect(popover).toContainText("You're signed in")
  await expect(popover).toContainText('1 of 5')
  await shot(page, '26-shell-tour-step1', info.project.name)

  await page.locator('.driver-popover-next-btn').click()
  await expect(popover).toContainText('Your cups')
  await page.locator('.driver-popover-prev-btn').click()
  await expect(popover).toContainText("You're signed in")

  // Skip is on every step, not only the first.
  await expect(page.locator('.coffee-tour__skip')).toBeVisible()
  await page.locator('.coffee-tour__skip').click()
  await expect(popover).toHaveCount(0)

  const remembered = await page.evaluate(() =>
    localStorage.getItem('onboarding.coffee-sub.v1.skipped'),
  )
  expect(remembered).not.toBeNull()

  // Coming back must not reopen it. Re-entering through the QA link rather
  // than reloading, because a QA session is held in memory by design — a
  // reload signs you out, which would prove nothing about the tour.
  await page.goto(`${server.url}#/qa?code=TESTCODE`)
  await page.waitForSelector('.dock', { state: 'visible' })
  await expect(page.locator('.driver-popover')).toHaveCount(0)
})

test('the walkthrough can be replayed from the profile menu', async ({ page }) => {
  await signedInShell(page, server.url)
  await page.locator('.profile__trigger').click()
  await page.getByRole('menuitem', { name: /show me around/i }).click()
  await expect(page.locator('.driver-popover')).toBeVisible({ timeout: 20_000 })
})
