import { test, expect, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import { startServer, type SwappableServer } from './server'
import {
  API,
  TEAMMATE,
  reenterAfterReload,
  settleAnimations,
  settleSheet,
  signedInShell,
} from './fixtures'

/**
 * The post-Drink contract, in a real browser on real phone metrics.
 *
 * A successful Drink shows `Drink 1` in a modal summary sheet and does nothing
 * else: no page is opened, reserved or navigated, and wa.me is never asked for
 * anything until the person taps Share to WhatsApp — a plain target=_blank
 * link the browser navigates from that tap. That is the fix for the blank
 * white tab, so E1 holds team balances forever and proves nothing opens.
 *
 * Everything the sheet shows is live state, Put Back works on exactly the cup
 * it came from (and survives a reload through /api/me), and the figures only
 * appear when the fetched history can vouch for them.
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
  }
  mkdirSync(EVIDENCE, { recursive: true })
  server = await startServer(BUILD)
})

test.afterAll(async () => {
  await server?.close()
})

const shot = async (page: Page, name: string, project: string) => {
  await page.screenshot({ path: resolve(EVIDENCE, `${name}-${project}.png`) })
}

/** Axe failures name the element and the measured colours, not just the rule. */
const violations = async (page: Page) => {
  const results = await new AxeBuilder({ page }).analyze()
  return results.violations.flatMap((v) =>
    v.nodes.map((n) => `${v.id} @ ${n.target.join(' ')} :: ${(n.failureSummary ?? '').replace(/\s+/g, ' ').slice(0, 200)}`),
  )
}

/** True when the element's own centre, on screen, is what a tap there would hit. */
const isReachable = (locator: Locator) =>
  locator.evaluate((el) => {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return false
    if (r.top < 0 || r.bottom > window.innerHeight || r.left < 0 || r.right > window.innerWidth) return false
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return el === hit || el.contains(hit)
  })

/** Counts every page the context opens from here on, even one that closes again. */
const countOpenedPages = (page: Page) => {
  let opened = 0
  page.context().on('page', () => {
    opened += 1
  })
  return () => opened
}

const SHARE = 'Share to WhatsApp'
const CARD_PUT_BACK = 'Put back cup from September beans'
const INCLUDES_TEAM = 'Includes team balances for 2 people'
const STILL_LOADING = 'Shares your balance only (team balances still loading)'
const UNAVAILABLE = 'Team balances unavailable — shares your balance only'
const STILL_COUNTING = 'Still counting — no need to tap again.'

const drinkSheet = (page: Page) => page.getByRole('dialog', { name: 'Drink 1' })
const putBackSheet = (page: Page) => page.getByRole('dialog', { name: 'Cup put back' })
const anySheet = (page: Page) => page.getByRole('dialog')
const confirmSheet = (page: Page) => page.getByRole('alertdialog', { name: 'Drink another?' })

/** Tap Drink and wait for the success sheet. */
async function drinkAndOpen(page: Page): Promise<Locator> {
  await page.locator('.fab').click()
  const sheet = drinkSheet(page)
  await expect(sheet).toBeVisible()
  return sheet
}

/** Open "Preview message" (if closed) and return the exact text it shows. */
async function readPreview(sheet: Locator): Promise<string> {
  const details = sheet.locator('details', { hasText: 'Preview message' })
  if ((await details.getAttribute('open')) === null) {
    await details.locator('summary').click()
  }
  const pre = details.locator('pre')
  await expect(pre).toBeVisible()
  return (await pre.textContent()) ?? ''
}

/** The `text` a Share link would send, decoded. */
async function shareText(sheet: Locator): Promise<string> {
  const href = (await sheet.getByRole('link', { name: SHARE }).getAttribute('href')) ?? ''
  return new URL(href).searchParams.get('text') ?? ''
}

test.describe('post-Drink summary sheet', () => {
  test('E1 a Drink opens the sheet and nothing else, even while team balances never answer', async ({
    page,
  }, info) => {
    const api = await signedInShell(page, server.url, { balances: 'hang' })
    const opened = countOpenedPages(page)

    const sheet = await drinkAndOpen(page)
    await expect(sheet.getByRole('heading', { name: 'Drink 1' })).toBeVisible()
    await expect(sheet.getByText(/Cup counted · (\d{2}[:.]\d{2}|just now) · September beans/)).toBeVisible()
    await expect(sheet).toContainText('left now')
    await expect(sheet.getByText(STILL_LOADING)).toBeVisible()

    // The blank-tab bug waited on exactly this read. Give it every chance.
    await page.waitForTimeout(5_000)
    expect(api.pageCount(), 'no page besides the app').toBe(1)
    expect(opened(), 'no page was ever opened').toBe(0)
    expect(api.whatsappRequests(), 'Drink never asks wa.me for anything').toBe(0)
    expect(api.drinks()).toBe(1)
    await shot(page, '40-sheet-balances-hanging', info.project.name)

    await sheet.getByRole('button', { name: 'Done' }).click()
    await expect(anySheet(page)).toHaveCount(0)
    await page.waitForTimeout(500)
    expect(api.whatsappRequests(), 'dismissing never shares').toBe(0)
    expect(api.pageCount()).toBe(1)
    expect(opened()).toBe(0)
    expect(api.drinks()).toBe(1)
    api.releaseBalances()
  })

  test('E2 a Drink that never answers opens nothing, says Working…, and reassures at 8s', async ({
    page,
  }) => {
    await page.clock.install()
    const api = await signedInShell(page, server.url, { drink: 'hang' })
    const opened = countOpenedPages(page)
    const fab = page.locator('.fab')

    await fab.click()
    await expect.poll(() => api.drinks()).toBe(1)
    await expect(fab).toContainText('Working…')
    const still = page.getByRole('status').filter({ hasText: STILL_COUNTING })
    await expect(still).toHaveCount(0)

    await page.clock.fastForward(7_000)
    await expect(still).toHaveCount(0)
    await page.clock.fastForward(1_100)
    await expect(still).toHaveCount(1)

    await expect(anySheet(page)).toHaveCount(0)
    expect(api.pageCount()).toBe(1)
    expect(opened()).toBe(0)
    expect(api.whatsappRequests()).toBe(0)
    expect(api.drinks()).toBe(1)

    // When the answer does arrive, success is the sheet — still one Drink.
    api.releaseDrink()
    await expect(drinkSheet(page)).toBeVisible()
    expect(api.drinks()).toBe(1)
    expect(api.whatsappRequests()).toBe(0)
    expect(opened()).toBe(0)
  })

  test('E3 a Drink the server rejects opens no sheet and no page', async ({ page }) => {
    const api = await signedInShell(page, server.url, { drink: 500 })
    const opened = countOpenedPages(page)
    const fab = page.locator('.fab')

    await fab.click()
    await expect.poll(() => api.drinks()).toBe(1)
    await expect(fab).not.toContainText('Working…')
    await page.waitForTimeout(500)

    await expect(anySheet(page)).toHaveCount(0)
    expect(api.pageCount()).toBe(1)
    expect(opened()).toBe(0)
    expect(api.whatsappRequests()).toBe(0)
    await expect(page.locator('.slip__number')).toHaveText('5')
  })

  test('E4 Share is one explicit tap: a noopener wa.me page carrying exactly the preview', async ({
    page,
    context,
  }, info) => {
    const api = await signedInShell(page, server.url)
    const sheet = await drinkAndOpen(page)
    await settleSheet(page)
    await expect(sheet.getByText(INCLUDES_TEAM)).toBeVisible()

    // What the person can read first is what will be sent.
    const preview = await readPreview(sheet)
    expect(preview).toContain('Cart Coffee')
    expect(preview).toContain('Dewa Wijaya drank 1 cup from September beans.')
    expect(preview).toContain('Dewa Wijaya: 4 cups')
    expect(preview).toContain(`${TEAMMATE.displayName}: 3 cups`)
    expect(preview).toContain('Total remaining: 7 cups')

    const share = sheet.getByRole('link', { name: SHARE })
    await expect(share).toHaveAttribute('target', '_blank')
    await expect(share).toHaveAttribute('rel', 'noopener noreferrer')
    await expect(share).toHaveAttribute('href', /^https:\/\/wa\.me\/\?text=/)
    expect(await shareText(sheet)).toBe(preview)
    expect(api.whatsappRequests(), 'nothing is shared before the tap').toBe(0)
    expect(api.pageCount()).toBe(1)

    const [popup] = await Promise.all([context.waitForEvent('page'), share.click()])
    await popup.waitForURL(/^https:\/\/wa\.me\/\?text=/)
    expect(popup.url()).toMatch(/^https:\/\/wa\.me\/\?text=/)
    expect(await popup.opener(), 'the WhatsApp page cannot reach back into the app').toBeNull()
    await expect.poll(() => api.whatsappRequests()).toBe(1)
    expect(api.whatsappTexts()).toEqual([preview])
    expect(api.drinks(), 'sharing never counts a cup').toBe(1)

    // The app stays where it was, sheet and all.
    expect(page.url()).toContain(server.url)
    await expect(sheet).toBeVisible()
    await shot(popup, '41-share-wa-stub', info.project.name)
    await popup.close()
    expect(api.whatsappRequests()).toBe(1)
    expect(api.drinks()).toBe(1)
  })

  test('E5 when team balances time out, the share is self-only and says so', async ({ page }, info) => {
    await page.clock.install()
    const api = await signedInShell(page, server.url, { balances: 'hang' })
    const sheet = await drinkAndOpen(page)

    await expect(sheet.getByText(STILL_LOADING)).toBeVisible()
    await expect.poll(() => api.balanceRequests()).toBeGreaterThan(0)
    await page.clock.fastForward(5_100)
    await expect(sheet.getByText(UNAVAILABLE)).toBeVisible()

    const preview = await readPreview(sheet)
    expect(preview).toContain('Team balances not included.')
    expect(preview).toContain('Dewa Wijaya: 4 cups')
    expect(preview).not.toContain(TEAMMATE.displayName)
    expect(preview).not.toContain('Total remaining')
    expect(await shareText(sheet), 'the link sends what the caption describes').toBe(preview)
    expect(api.whatsappRequests()).toBe(0)
    expect(api.pageCount()).toBe(1)
    await shot(page, '42-sheet-self-only', info.project.name)

    // A late answer to the abandoned read changes nothing.
    api.releaseBalances()
    await page.waitForTimeout(300)
    await expect(sheet.getByText(UNAVAILABLE)).toBeVisible()
    expect(await shareText(sheet)).toBe(preview)
  })

  test('E6 one tap is one Drink, however it is tapped or closed', async ({ page }) => {
    const api = await signedInShell(page, server.url, { drink: 'hang' })
    const fab = page.locator('.fab')
    const confirm = confirmSheet(page)

    // A double tap while the first is still in flight sends one request.
    await fab.dblclick()
    await expect.poll(() => api.drinks()).toBe(1)
    await page.waitForTimeout(300)
    expect(api.drinks()).toBe(1)
    api.releaseDrink()
    let sheet = drinkSheet(page)
    await expect(sheet).toBeVisible()
    await expect(sheet).toContainText(/\b4\s*cups left now/)

    // Done adds nothing.
    await sheet.getByRole('button', { name: 'Done' }).click()
    await expect(anySheet(page)).toHaveCount(0)
    expect(api.drinks()).toBe(1)

    // A second intent asks first, with Cancel focused; Cancel adds nothing.
    await fab.click()
    await expect(confirm).toBeVisible()
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await confirm.getByRole('button', { name: 'Cancel' }).click()
    await expect(confirm).toHaveCount(0)
    expect(api.drinks()).toBe(1)

    // Confirming counts exactly one more, with a receipt of its own.
    await fab.click()
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await confirm.getByRole('button', { name: 'Drink another', exact: true }).click()
    await expect.poll(() => api.drinks()).toBe(2)
    sheet = drinkSheet(page)
    await expect(sheet).toBeVisible()
    await expect(sheet).toContainText(/\b3\s*cups left now/)

    // Escape adds nothing.
    await page.keyboard.press('Escape')
    await expect(anySheet(page)).toHaveCount(0)
    expect(api.drinks()).toBe(2)

    // A third cup: a double-tapped Put Back sends one undo, then the backdrop adds nothing.
    await fab.click()
    await confirm.getByRole('button', { name: 'Drink another', exact: true }).click()
    await expect.poll(() => api.drinks()).toBe(3)
    sheet = drinkSheet(page)
    await expect(sheet).toBeVisible()
    await sheet.getByRole('button', { name: /put back/i }).dblclick()
    await expect.poll(() => api.undos()).toBe(1)
    await expect(putBackSheet(page)).toBeVisible()
    await page.waitForTimeout(300)
    expect(api.undos()).toBe(1)

    const open = anySheet(page)
    const box = (await open.boundingBox())!
    if (box.y > 8) {
      // Above the panel is backdrop; a press that starts and ends there dismisses.
      await page.mouse.click(box.x + box.width / 2, box.y / 2)
    } else {
      test.info().annotations.push({
        type: 'note',
        description: 'The sheet fills the viewport here, so there is no backdrop to tap; closed with Escape.',
      })
      await page.keyboard.press('Escape')
    }
    await expect(anySheet(page)).toHaveCount(0)
    expect(api.drinks()).toBe(3)
    expect(api.undos()).toBe(1)
    expect(api.whatsappRequests()).toBe(0)
  })

  test('E7 Put Back from the sheet restores the balance, hides Share, and clears the card', async ({
    page,
  }, info) => {
    const api = await signedInShell(page, server.url)
    const sheet = await drinkAndOpen(page)
    await settleSheet(page)
    await expect(sheet).toContainText(/\b4\s*cups left now/)
    await expect(sheet.getByRole('link', { name: SHARE })).toBeVisible()

    await sheet.getByRole('button', { name: /put back/i }).click()
    await expect.poll(() => api.undos()).toBe(1)
    const after = putBackSheet(page)
    await expect(after).toBeVisible()
    await expect(after.getByRole('heading', { name: 'Cup put back' })).toBeFocused()
    await expect(after).toContainText(/\b5\s*cups left/)
    await expect(after.getByRole('link', { name: SHARE })).toHaveCount(0)
    await expect(after.getByRole('button', { name: /put back/i })).toHaveCount(0)
    expect(page.url()).toContain(server.url)
    expect(api.pageCount()).toBe(1)
    expect(api.whatsappRequests()).toBe(0)
    await settleSheet(page)
    await shot(page, '44-sheet-put-back', info.project.name)

    await after.getByRole('button', { name: 'Done' }).click()
    await expect(anySheet(page)).toHaveCount(0)
    await expect(page.getByRole('button', { name: CARD_PUT_BACK })).toHaveCount(0)
    await expect(page.locator('.slip__number')).toHaveText('5')
    expect(api.drinks()).toBe(1)
    expect(api.undos()).toBe(1)
  })

  test('E8 after a real reload the card keeps its Put Back, the sheet stays gone, and one undo restores', async ({
    page,
  }) => {
    const api = await signedInShell(page, server.url)
    await drinkAndOpen(page)
    await expect(page.locator('.slip__number')).toHaveText('4')

    // Reload with the sheet still open: the receipt is memory, the offer is the server's.
    await page.reload()
    await reenterAfterReload(page, server.url)
    const putBack = page.getByRole('button', { name: CARD_PUT_BACK })
    await expect(putBack).toBeVisible()
    await expect(page.locator('.slip__number')).toHaveText('4')
    await page.waitForTimeout(500)
    await expect(anySheet(page), 'the sheet does not come back after a reload').toHaveCount(0)

    await putBack.click()
    await expect.poll(() => api.undos()).toBe(1)
    await expect(page.locator('.slip__number')).toHaveText('5')
    await expect(putBack).toHaveCount(0)
    await expect(anySheet(page)).toHaveCount(0)
    expect(api.drinks()).toBe(1)
    expect(api.whatsappRequests()).toBe(0)
  })

  test('E9 focus: the heading on open, and back to Drink after Escape', async ({ page }) => {
    await signedInShell(page, server.url)
    const sheet = await drinkAndOpen(page)
    await expect(sheet.getByRole('heading', { name: 'Drink 1' })).toBeFocused()

    await page.keyboard.press('Escape')
    await expect(anySheet(page)).toHaveCount(0)
    await expect(page.locator('.fab')).toBeFocused()
  })

  test('E9 focus: after the last cup, with Drink disabled, focus lands on main', async ({ page }) => {
    await signedInShell(page, server.url, { remaining: 1 })
    const sheet = await drinkAndOpen(page)
    await expect(sheet.getByRole('heading', { name: 'Drink 1' })).toBeFocused()
    await expect(sheet).toContainText('That was your last cup')
    await expect(page.locator('.fab')).toBeDisabled()

    await sheet.getByRole('button', { name: 'Done' }).click()
    await expect(anySheet(page)).toHaveCount(0)
    await expect(page.getByRole('main')).toBeFocused()
  })

  test('E10 the sheet fits the phone, keeps 44px targets, and leaves the page behind inert', async ({
    page,
  }, info) => {
    const project = info.project.name
    await signedInShell(page, server.url)
    await page.locator('.fab').click()
    const sheet = await settleSheet(page)
    await expect(sheet.getByText(INCLUDES_TEAM)).toBeVisible()

    const geometry = () =>
      sheet.evaluate((dialog) => {
        // --column resolved to pixels by the browser, not re-parsed here.
        const probe = document.createElement('div')
        probe.style.cssText = 'position:absolute;visibility:hidden;width:var(--column)'
        document.body.appendChild(probe)
        const column = probe.getBoundingClientRect().width
        probe.remove()

        const rect = dialog.getBoundingClientRect()
        const body = dialog.querySelector('.sheet__body')
        const overflowing = [...dialog.querySelectorAll('*')].flatMap((el) => {
          const r = el.getBoundingClientRect()
          // Unrendered and visually-hidden (1px) elements have no footprint.
          if (r.width <= 1 || r.height <= 1) return []
          return r.left < -1 || r.right > window.innerWidth + 1
            ? [`${el.tagName.toLowerCase()}.${el.getAttribute('class') ?? ''} [${Math.round(r.left)}, ${Math.round(r.right)}]`]
            : []
        })
        const small = [...dialog.querySelectorAll('button, a[href], summary, textarea')].flatMap((el) => {
          const r = el.getBoundingClientRect()
          if (r.width <= 1 || r.height <= 1) return []
          return r.width < 43.5 || r.height < 43.5
            ? [`${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 40)}" ${Math.round(r.width)}x${Math.round(r.height)}`]
            : []
        })
        return {
          width: rect.width,
          bottom: rect.bottom,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          column,
          bodyOverflow: body ? body.scrollWidth - body.clientWidth : null,
          overflowing,
          small,
        }
      })

    const check = async (label: string) => {
      const g = await geometry()
      if (project === 'narrow') {
        expect(Math.abs(g.width - g.innerWidth), `${label}: full width at 320px`).toBeLessThanOrEqual(1)
      } else {
        expect(g.width, `${label}: no wider than the column`).toBeLessThanOrEqual(Math.min(g.column, g.innerWidth) + 1)
      }
      expect(Math.abs(g.bottom - g.innerHeight), `${label}: sits on the bottom edge`).toBeLessThanOrEqual(1)
      expect(g.bodyOverflow, `${label}: .sheet__body exists and never scrolls sideways`).not.toBeNull()
      expect(g.bodyOverflow!, `${label}: .sheet__body scrollWidth`).toBeLessThanOrEqual(1)
      expect(g.overflowing, `${label}: nothing extends past the viewport`).toEqual([])
      expect(g.small, `${label}: targets under 44px`).toEqual([])
    }

    await check('at rest')
    await shot(page, '45-sheet-geometry', project)

    // The preview opens inside the body, and must not widen it or bring small targets.
    await sheet.locator('details', { hasText: 'Preview message' }).locator('summary').click()
    await expect(sheet.locator('details', { hasText: 'Preview message' }).locator('pre')).toBeVisible()
    await check('with the preview open')

    // The page behind is inert: a tap where Drink sits lands on the dialog.
    const fabCovered = await page.evaluate(() => {
      const dialog = document.querySelector('dialog[open]')
      const fab = document.querySelector('.fab')
      if (!dialog || !fab) return false
      const r = fab.getBoundingClientRect()
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return hit !== null && (hit === dialog || dialog.contains(hit))
    })
    expect(fabCovered, 'a tap on Drink reaches the dialog, not the page').toBe(true)

    const done = sheet.getByRole('button', { name: 'Done' })
    const share = sheet.getByRole('link', { name: SHARE })
    if (project === 'landscape') {
      // 200% text in a 342px-tall viewport: the footer still has to be tappable.
      await page.addStyleTag({ content: 'html { font-size: 200% }' })
      await settleAnimations(sheet)
      expect(await isReachable(done), 'Done at 200% text').toBe(true)
      expect(await isReachable(share), 'Share at 200% text').toBe(true)
      const g = await geometry()
      expect(g.bodyOverflow!, '.sheet__body at 200% text').toBeLessThanOrEqual(1)
      await shot(page, '46-sheet-landscape-200pct', project)
    }

    await done.click()
    await expect(anySheet(page)).toHaveCount(0)

    if (project === 'narrow') {
      // At rest, unscrolled, the first card's Put Back is not under the Drink button.
      await page.evaluate(() => {
        const main = document.querySelector('.app__main')
        if (main) main.scrollTop = 0
      })
      const putBack = page.getByRole('button', { name: CARD_PUT_BACK }).first()
      await expect(putBack).toBeVisible()
      expect(await isReachable(putBack), 'the first card Put Back is tappable at rest').toBe(true)
      await shot(page, '47-narrow-card-put-back', project)
    }
  })

  test('E11 reduced motion shows the final frame with no animation at all', async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const api = await signedInShell(page, server.url)
    const sheet = await drinkAndOpen(page)

    const count = () => sheet.evaluate((el) => el.getAnimations({ subtree: true }).length)
    expect(await count(), 'animations on open').toBe(0)
    // The final frame is the base style: the cup is simply there.
    const cup = sheet.locator('.success-cup').first()
    await expect(cup).toBeVisible()
    expect(await cup.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')

    await settleSheet(page)
    expect(await count(), 'animations once everything has loaded').toBe(0)
    await shot(page, '48-sheet-reduced-motion', info.project.name)
    expect(api.drinks()).toBe(1)
  })

  test('E11 with motion on, sheet animations are finite, end within 1s, and never block Done', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const api = await signedInShell(page, server.url)
    const sheet = await drinkAndOpen(page)

    // Read at once: a finished animation with fill-mode both is still listed.
    const ends = await sheet.evaluate((el) =>
      el.getAnimations({ subtree: true }).map((a) => Number(a.effect?.getComputedTiming().endTime)),
    )
    expect(ends.length, 'the success moment animates').toBeGreaterThan(0)
    for (const end of ends) {
      expect(Number.isFinite(end), 'no infinite animation in the sheet').toBe(true)
      expect(end, 'every animation ends within 1000ms').toBeLessThanOrEqual(1000)
    }

    // Done works straight away. The 900ms cup outlasts the 240ms slide-in, so
    // this lands while the celebration is still playing.
    await sheet.getByRole('button', { name: 'Done' }).click()
    await expect(anySheet(page)).toHaveCount(0)
    expect(api.drinks()).toBe(1)
  })

  for (const scheme of ['light', 'dark'] as const) {
    test(`E12 no axe violations: the sheet in both states and the confirm (${scheme})`, async ({
      page,
    }, info) => {
      await page.emulateMedia({ colorScheme: scheme })
      await signedInShell(page, server.url)

      await page.locator('.fab').click()
      await expect(drinkSheet(page)).toBeVisible()
      let sheet = await settleSheet(page)
      await expect(sheet.getByText(INCLUDES_TEAM)).toBeVisible()
      expect(await violations(page), 'sheet, counted').toEqual([])
      await shot(page, `49-axe-sheet-counted-${scheme}`, info.project.name)

      await sheet.getByRole('button', { name: /put back/i }).click()
      await expect(putBackSheet(page)).toBeVisible()
      sheet = await settleSheet(page)
      expect(await violations(page), 'sheet, put back').toEqual([])
      await shot(page, `49-axe-sheet-put-back-${scheme}`, info.project.name)
      await sheet.getByRole('button', { name: 'Done' }).click()
      await expect(anySheet(page)).toHaveCount(0)

      // A fresh cup, then a second intent: the confirm.
      await drinkAndOpen(page)
      sheet = await settleSheet(page)
      await sheet.getByRole('button', { name: 'Done' }).click()
      await expect(anySheet(page)).toHaveCount(0)
      await page.locator('.fab').click()
      const confirm = confirmSheet(page)
      await expect(confirm).toBeVisible()
      await settleAnimations(confirm)
      expect(await violations(page), 'confirm').toEqual([])
      await shot(page, `49-axe-confirm-${scheme}`, info.project.name)
      await confirm.getByRole('button', { name: 'Cancel' }).click()
    })

    test(`E12 no axe violations on Home with no cups left (${scheme})`, async ({ page }, info) => {
      await page.emulateMedia({ colorScheme: scheme })
      await signedInShell(page, server.url, { remaining: 0 })
      await expect(page.locator('.fab')).toBeDisabled()
      expect(await violations(page)).toEqual([])
      await shot(page, `49-axe-home-empty-${scheme}`, info.project.name)
    })
  }

  test('E13 a member with a fortnight of history sees bars and an estimate', async ({ page }, info) => {
    await signedInShell(page, server.url, { history: { seed: 'pace' } })
    const pace = page.getByRole('region', { name: 'Your pace' })
    await expect(pace).toBeAttached()
    await pace.scrollIntoViewIfNeeded()
    await expect(pace).toBeVisible()

    // Cups 1, 3 and 5 days ago fall in the last seven; 7 and 9 days ago do not.
    await expect(pace).toContainText('3 cups in the last 7 days')
    await expect(pace.getByText(/Last 7 days:/)).toHaveCount(1)
    await expect(pace.locator('svg').first()).toBeVisible()

    const summary = pace.locator('summary', { hasText: 'How long will my cups last?' })
    const box = (await summary.boundingBox())!
    expect(box.height, 'the disclosure is a 44px target').toBeGreaterThanOrEqual(44)
    // Closed <details> content is still in textContent, so ask for it visible.
    const estimate = pace.getByText(/About \d+ days left|More than 2 months left/)
    await expect(estimate).toBeHidden()
    await summary.click()
    await expect(pace.locator('details')).toHaveAttribute('open', '')
    await expect(estimate).toBeVisible()
    await expect(pace.getByText(/Estimate/)).toBeVisible()
    await shot(page, '50-home-pace', info.project.name)
  })

  test('E13 without proof of a full fortnight, the bars show but no estimate', async ({ page }) => {
    await signedInShell(page, server.url, { history: { seed: 'recent-only' } })
    const pace = page.getByRole('region', { name: 'Your pace' })
    await expect(pace).toBeAttached()
    await expect(pace.getByText(/Last 7 days:/)).toHaveCount(1)
    await expect(pace).toContainText('3 cups in the last 7 days')
    await expect(pace.locator('summary')).toHaveCount(0)
    await expect(pace).not.toContainText('Estimate')
    await expect(pace).not.toContainText(/days left|months left/)
  })

  test('E13 with no history, the pace card is not shown at all', async ({ page }) => {
    const api = await signedInShell(page, server.url, { history: 'empty' })
    await expect.poll(() => api.historyRequests()).toBeGreaterThan(0)
    // Let the answer render; hidden-while-loading must not pass for hidden-when-empty.
    await page.waitForTimeout(500)
    await expect(page.getByRole('region', { name: 'Your pace' })).toHaveCount(0)
    await expect(page.getByText(/Last 7 days:/)).toHaveCount(0)
  })
})
