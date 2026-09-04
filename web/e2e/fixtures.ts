import type { Page } from '@playwright/test'

/**
 * A signed-in shell in a real browser, without Firebase.
 *
 * The QA redemption path already exists for exactly this: a code in the URL
 * fragment is exchanged for an in-memory bearer, and `App` treats that session
 * as signed in. Every API response is fulfilled by the test, so nothing here
 * depends on a project, a roster or a network.
 */

export const API = 'https://api.invalid.e2e'

export interface Fixture {
  role?: 'member' | 'admin'
  remaining?: number
  /** How many batches the member holds — a short list and a long one scroll differently. */
  batches?: number
  /** Seed the tour as already seen, so it does not open over other assertions. */
  tourSeen?: boolean
  /** Server-backed latest-today drink, as returned after a reload. */
  undoOffer?: boolean
}

/** The login screen, with no session and no API reachable. */
export async function loginScreen(page: Page, url: string): Promise<void> {
  await page.route(`${API}/**`, (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }),
  )
  await page.goto(url)

  /*
   * Wait for the screen to be *ready*, not merely rendered.
   *
   * `.login__status` is the "checking your session" state, so accepting it here
   * let a test proceed while Firebase was still restoring persistence — and
   * every assertion about the button then failed fifteen seconds later with
   * "element not found", which reads as a broken login screen rather than as a
   * slow one. Firebase initialisation is the slowest thing on this page and it
   * competes with whatever else the run is doing, so it gets a wait of its own.
   */
  await page.waitForSelector('.login__cta', { state: 'visible', timeout: 60_000 })
}

export async function signedInShell(
  page: Page,
  url: string,
  { role = 'member', remaining = 5, batches = 1, tourSeen = true, undoOffer = false }: Fixture = {},
): Promise<{
  drinks: () => number
  undos: () => number
  whatsappHandoffs: () => string[]
  handoffSuccessText: () => string[]
}> {
  let drinkCount = 0
  let undoCount = 0
  let total = remaining
  let offerActive = undoOffer
  let offerOpId = undoOffer ? 'morning-op' : ''
  let offerCreatedAt = '2026-09-04T01:00:00.000Z'
  let offerExpiresAt = '2099-01-01T00:00:00.000Z'
  const whatsappHandoffs: string[] = []
  const handoffSuccessText: string[] = []

  // A real browser proves the post-success jump is an actual wa.me navigation.
  // The jump happens in the reserved secondary context — a popup — so the
  // interception has to live on the browser context: page-level routing never
  // sees requests made from other pages. Abort at that boundary so the rest of
  // the shell suite can keep asserting local undo and layout state in the PWA
  // window, which never navigates away.
  await page.context().route('https://wa.me/**', async (route) => {
    whatsappHandoffs.push(route.request().url())
    handoffSuccessText.push((await page.locator('.snackbar').textContent().catch(() => '')) ?? '')
    return route.abort()
  })

  const allocations = (left: number) => [
    {
      allocRowKey: 'A|SEPTEMBER',
      batchId: 'B1',
      batchLabel: 'September beans',
      granted: 8,
      consumed: 8 - left,
      remaining: left,
      effectiveAt: '2026-09-01T00:00:00.000Z',
    },
    // Spent batches, oldest first, to give the list real length.
    ...Array.from({ length: Math.max(0, batches - 1) }, (_, i) => ({
      allocRowKey: `A|BATCH-${i + 2}`,
      batchId: `B${i + 2}`,
      batchLabel: `Batch ${i + 2}`,
      granted: 8,
      consumed: 8,
      remaining: 0,
      effectiveAt: `2026-0${(i % 8) + 1}-01T00:00:00.000Z`,
    })),
  ]

  await page.route(`${API}/**`, async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

    if (path === '/api/qa/redeem') {
      return json({ sessionToken: 'qa-token', qaMemberId: 'M1', expiresAt: '2099-01-01T00:00:00Z' })
    }
    if (path === '/api/me') {
      return json({
        member: { memberId: 'M1', displayName: 'Dewa Wijaya', role, isQa: true },
        totalRemaining: total,
        allocations: allocations(total),
        undoOffer: offerActive ? {
          opId: offerOpId,
          allocRowKey: 'A|SEPTEMBER',
          batchId: 'B1',
          batchLabel: 'September beans',
          createdAt: offerCreatedAt,
          undoExpiresAt: offerExpiresAt,
        } : null,
      })
    }
    if (path === '/api/me/drinks' && request.method() === 'POST') {
      drinkCount += 1
      total -= 1
      offerActive = true
      offerOpId = `op-${drinkCount}`
      offerCreatedAt = new Date().toISOString()
      offerExpiresAt = new Date(Date.now() + 90_000).toISOString()
      return json({
        opId: offerOpId,
        txnRowKey: 'T',
        allocRowKey: 'A|SEPTEMBER',
        batchId: 'B1',
        batchLabel: 'September beans',
        remainingTotal: total,
        replayed: false,
        createdAt: offerCreatedAt,
        undoExpiresAt: offerExpiresAt,
      })
    }
    if (path.endsWith('/undo') && request.method() === 'POST') {
      undoCount += 1
      total += 1
      offerActive = false
      return json({ remainingTotal: total })
    }
    if (path === '/api/me/history') {
      return json({ items: [] })
    }
    if (path === '/api/balances') {
      return json({ balances: [{ memberId: 'M1', displayName: 'Dewa Wijaya', remaining: total }] })
    }
    if (path === '/api/batches') {
      return json({
        batches: [
          {
            batchId: 'B1',
            label: 'September beans',
            effectiveAt: '2026-09-01T00:00:00.000Z',
            totalUnits: 8,
            status: 'active',
          },
        ],
      })
    }
    return json({ error: { code: 'NOT_FOUND', message: 'unmapped' } }, 404)
  })

  if (tourSeen) {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('onboarding.coffee-sub.v1', 'finished')
      } catch {
        /* private mode */
      }
    })
  }

  await page.goto(`${url}#/qa?code=TESTCODE`)
  await page.waitForSelector('.dock', { state: 'visible' })
  return {
    drinks: () => drinkCount,
    undos: () => undoCount,
    whatsappHandoffs: () => [...whatsappHandoffs],
    handoffSuccessText: () => [...handoffSuccessText],
  }
}
