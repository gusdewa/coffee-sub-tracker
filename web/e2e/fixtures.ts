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
}

/** The login screen, with no session and no API reachable. */
export async function loginScreen(page: Page, url: string): Promise<void> {
  await page.route(`${API}/**`, (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }),
  )
  await page.goto(url)
  await page.waitForSelector('.login__cta, .login__status', { state: 'visible' })
}

export async function signedInShell(
  page: Page,
  url: string,
  { role = 'member', remaining = 5, batches = 1, tourSeen = true }: Fixture = {},
): Promise<{ drinks: () => number }> {
  let drinkCount = 0
  let total = remaining

  const allocations = (left: number) => [
    {
      batchId: 'B1',
      batchLabel: 'September beans',
      granted: 8,
      consumed: 8 - left,
      remaining: left,
      effectiveAt: '2026-09-01T00:00:00.000Z',
    },
    // Spent batches, oldest first, to give the list real length.
    ...Array.from({ length: Math.max(0, batches - 1) }, (_, i) => ({
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
      })
    }
    if (path === '/api/me/drinks' && request.method() === 'POST') {
      drinkCount += 1
      total -= 1
      return json({
        opId: `op-${drinkCount}`,
        txnRowKey: 'T',
        allocRowKey: 'A',
        batchId: 'B1',
        batchLabel: 'September beans',
        remainingTotal: total,
        replayed: false,
      })
    }
    if (path.endsWith('/undo') && request.method() === 'POST') {
      total += 1
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
  return { drinks: () => drinkCount }
}
