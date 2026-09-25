import { expect, type Locator, type Page } from '@playwright/test'

/**
 * A signed-in shell in a real browser, without Firebase.
 *
 * The QA redemption path already exists for exactly this: a code in the URL
 * fragment is exchanged for an in-memory bearer, and `App` treats that session
 * as signed in. Every API response is fulfilled by the test, so nothing here
 * depends on a project, a roster or a network.
 */

export const API = 'https://api.invalid.e2e'

/**
 * How a mocked endpoint answers.
 * - `'ok'`: at once.
 * - `'hang'`: never, until the matching `release*()` is called. Releasing
 *   answers every request held so far *and* switches the endpoint to `'ok'`
 *   for the rest of the test.
 * - `500`: an API error body with status 500.
 */
export type Mode = 'ok' | 'hang' | 500

/**
 * Where `/api/me/history` rows come from.
 * - `'derived'` (default): the fixture's own ledger — one CONSUME per answered
 *   Drink (opId `op-N`, createdAt = the Drink's time), `reversed: true` once it
 *   is put back, plus the REVERSAL row the undo wrote. Newest first.
 * - `'empty'`: always `{ items: [] }`, whatever happened.
 * - `{ seed }`: the derived ledger plus rows made relative to `Date.now()` *at
 *   request time*, so the figures do not rot as the calendar moves:
 *   - `'pace'`: a GRANT 20 days ago and 5 cups over the last 10 days, all in
 *     Jakarta daytime (1, 3, 5, 7 and 9 days ago — 3 of them in the last 7).
 *   - `'recent-only'`: the same 5 cups and nothing older, so nothing proves the
 *     member spans the 14-day pace window.
 */
export type HistoryOption = 'derived' | 'empty' | { seed: 'pace' | 'recent-only' }

export interface Fixture {
  role?: 'member' | 'admin'
  remaining?: number
  /** How many batches the member holds — a short list and a long one scroll differently. */
  batches?: number
  /** Seed the tour as already seen, so it does not open over other assertions. */
  tourSeen?: boolean
  /** Server-backed latest-today drink, as returned after a reload. */
  undoOffer?: boolean
  /** POST /api/me/drinks. */
  drink?: Mode
  /** GET /api/balances. */
  balances?: Mode
  history?: HistoryOption
}

export interface ShellApi {
  /** POST /api/me/drinks requests received — counted on arrival, answered or not. */
  drinks: () => number
  /** POST …/undo requests received. */
  undos: () => number
  /** Requests to wa.me from any page in the context (favicon probes excluded). */
  whatsappRequests: () => number
  /** The decoded `text` of each wa.me request, in order. */
  whatsappTexts: () => string[]
  balanceRequests: () => number
  historyRequests: () => number
  /** Every page open in the browser context, the app's own included. */
  pageCount: () => number
  /** Answer every held Drink and stop holding new ones. */
  releaseDrink: () => void
  /** Answer every held balances read and stop holding new ones. */
  releaseBalances: () => void
}

/** The second member on the team, so a full recap names two people. */
export const TEAMMATE = { memberId: 'M2', displayName: 'Ayu Pratiwi', remaining: 3 } as const

/** A harmless landing page for the Share link; never a real WhatsApp request. */
const WHATSAPP_STUB =
  '<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,">' +
  '<title>WhatsApp (stub)</title></head><body><p>WhatsApp stub</p></body></html>'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const JAKARTA = 7 * HOUR

/** `daysAgo` Jakarta days before today, at `hour`:00 Jakarta time, as an ISO string. */
function jakartaDaytime(now: number, daysAgo: number, hour: number): string {
  const todayStart = Math.floor((now + JAKARTA) / DAY) * DAY - JAKARTA
  return new Date(todayStart - daysAgo * DAY + hour * HOUR).toISOString()
}

interface LedgerRow {
  opId: string
  type: 'CONSUME' | 'REVERSAL' | 'GRANT'
  delta: number
  batchLabel: string
  createdAt: string
  reversesOpId?: string
}

function seedRows(seed: 'pace' | 'recent-only', now: number): LedgerRow[] {
  const cups: LedgerRow[] = [
    [1, 9],
    [3, 10],
    [5, 14],
    [7, 9],
    [9, 11],
  ].map(([daysAgo, hour], i) => ({
    opId: `seed-cup-${i + 1}`,
    type: 'CONSUME',
    delta: -1,
    batchLabel: 'September beans',
    createdAt: jakartaDaytime(now, daysAgo!, hour!),
  }))
  if (seed === 'recent-only') return cups
  return [
    ...cups,
    {
      opId: 'seed-grant',
      type: 'GRANT',
      delta: 8,
      batchLabel: 'September beans',
      createdAt: jakartaDaytime(now, 20, 8),
    },
  ]
}

/** A promise gate that `release` opens for everyone already waiting. */
function holdable(initial: Mode) {
  let mode: Mode = initial
  const waiting: Array<() => void> = []
  return {
    mode: () => mode,
    /** Resolves when released; at once when not holding. */
    hold: () =>
      mode === 'hang' ? new Promise<void>((resolve) => waiting.push(resolve)) : Promise.resolve(),
    release: () => {
      if (mode === 'hang') mode = 'ok'
      for (const open of waiting.splice(0)) open()
    },
  }
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
  {
    role = 'member',
    remaining = 5,
    batches = 1,
    tourSeen = true,
    undoOffer = false,
    drink = 'ok',
    balances = 'ok',
    history = 'derived',
  }: Fixture = {},
): Promise<ShellApi> {
  let drinkCount = 0
  let undoCount = 0
  let balanceCount = 0
  let historyCount = 0
  let total = remaining
  let offerActive = undoOffer
  let offerOpId = undoOffer ? 'morning-op' : ''
  let offerCreatedAt = '2026-09-04T01:00:00.000Z'
  let offerExpiresAt = '2099-01-01T00:00:00.000Z'
  const whatsappUrls: string[] = []
  const drinkGate = holdable(drink)
  const balancesGate = holdable(balances)

  /** Every transaction this fixture's server has written, oldest first. */
  const ledger: LedgerRow[] = undoOffer
    ? [
        {
          opId: 'morning-op',
          type: 'CONSUME',
          delta: -1,
          batchLabel: 'September beans',
          createdAt: offerCreatedAt,
        },
      ]
    : []

  /*
   * Share to WhatsApp is a real target=_blank link, so its navigation happens
   * in a new page: the interception has to live on the browser context, since
   * page-level routing never sees requests made from other pages. It is
   * *fulfilled* with a harmless page rather than aborted — aborting an external
   * top-level navigation behaves differently across WebKit and Chromium, and a
   * stub lets a test assert where the popup landed. Nothing is inspected from
   * inside this handler: querying a page while its navigation is paused can
   * deadlock Chromium.
   */
  await page.context().route('https://wa.me/**', async (route) => {
    const target = new URL(route.request().url())
    if (target.pathname === '/favicon.ico') {
      return route.fulfill({ status: 404, body: '' }).catch(() => undefined)
    }
    whatsappUrls.push(target.href)
    return route
      .fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: WHATSAPP_STUB })
      .catch(() => undefined)
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

  const historyItems = (limit: number) => {
    const rows = [...ledger]
    if (typeof history === 'object') rows.push(...seedRows(history.seed, Date.now()))
    const reversed = new Set(
      rows.filter((r) => r.type === 'REVERSAL').map((r) => r.reversesOpId ?? ''),
    )
    // Newest first, as the API returns it. Stable, and a later write wins a
    // tie, which is what the API's inverted-clock row keys give.
    return rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => Date.parse(b.row.createdAt) - Date.parse(a.row.createdAt) || b.index - a.index)
      .slice(0, limit)
      .map(({ row }) => ({
        opId: row.opId,
        type: row.type,
        delta: row.delta,
        batchLabel: row.batchLabel,
        createdAt: row.createdAt,
        reversed: reversed.has(row.opId),
        ...(row.reversesOpId ? { reversesOpId: row.reversesOpId } : {}),
      }))
  }

  await page.route(`${API}/**`, async (route) => {
    const request = route.request()
    const requestUrl = new URL(request.url())
    const path = requestUrl.pathname
    // A held request can be abandoned by the page (a read's timeout aborts
    // it), and a late answer to it must not fail the test.
    const json = (body: unknown, status = 200) =>
      route
        .fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
        .catch(() => undefined)
    const serverError = () =>
      json({ error: { code: 'INTERNAL', message: 'Simulated server error' } }, 500)

    if (path === '/api/qa/redeem') {
      // Any number of redemptions: a QA session is memory-only, so a test that
      // reloads has to redeem again (see reenterAfterReload).
      return json({ sessionToken: 'qa-token', qaMemberId: 'M1', expiresAt: '2099-01-01T00:00:00Z' })
    }
    if (path === '/api/me') {
      return json({
        member: { memberId: 'M1', displayName: 'Dewa Wijaya', role, isQa: true },
        totalRemaining: total,
        allocations: allocations(total),
        undoOffer: offerActive
          ? {
              opId: offerOpId,
              allocRowKey: 'A|SEPTEMBER',
              batchId: 'B1',
              batchLabel: 'September beans',
              createdAt: offerCreatedAt,
              undoExpiresAt: offerExpiresAt,
            }
          : null,
      })
    }
    if (path === '/api/me/drinks' && request.method() === 'POST') {
      drinkCount += 1
      const opId = `op-${drinkCount}`
      await drinkGate.hold()
      if (drinkGate.mode() === 500) return serverError()
      total -= 1
      offerActive = true
      offerOpId = opId
      offerCreatedAt = new Date().toISOString()
      offerExpiresAt = new Date(Date.now() + 90_000).toISOString()
      ledger.push({
        opId,
        type: 'CONSUME',
        delta: -1,
        batchLabel: 'September beans',
        createdAt: offerCreatedAt,
      })
      return json({
        opId,
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
    const undo = /^\/api\/me\/drinks\/([^/]+)\/undo$/.exec(path)
    if (undo && request.method() === 'POST') {
      undoCount += 1
      const opId = decodeURIComponent(undo[1]!)
      if (!offerActive || opId !== offerOpId) {
        const alreadyUndone = ledger.some((r) => r.type === 'REVERSAL' && r.reversesOpId === opId)
        return json(
          alreadyUndone
            ? { error: { code: 'ALREADY_UNDONE', message: 'Already put back' } }
            : { error: { code: 'NOT_LATEST_CONSUME', message: 'Not the latest cup' } },
          409,
        )
      }
      total += 1
      offerActive = false
      ledger.push({
        opId: `undo-${opId}`,
        type: 'REVERSAL',
        delta: 1,
        batchLabel: 'September beans',
        createdAt: new Date().toISOString(),
        reversesOpId: opId,
      })
      return json({ remainingTotal: total })
    }
    if (path === '/api/me/history') {
      historyCount += 1
      if (history === 'empty') return json({ items: [] })
      // The API's own rule: default 50, capped at 200.
      const limit = Math.min(Number(requestUrl.searchParams.get('limit') ?? 50) || 50, 200)
      return json({ items: historyItems(limit) })
    }
    if (path === '/api/balances') {
      balanceCount += 1
      await balancesGate.hold()
      if (balancesGate.mode() === 500) return serverError()
      return json({
        balances: [
          { memberId: 'M1', displayName: 'Dewa Wijaya', remaining: total },
          { ...TEAMMATE },
        ],
      })
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
    whatsappRequests: () => whatsappUrls.length,
    whatsappTexts: () =>
      whatsappUrls.map((href) => new URL(href).searchParams.get('text') ?? ''),
    balanceRequests: () => balanceCount,
    historyRequests: () => historyCount,
    pageCount: () => page.context().pages().length,
    releaseDrink: () => drinkGate.release(),
    releaseBalances: () => balancesGate.release(),
  }
}

/**
 * Sign back in after a real `page.reload()`.
 *
 * A QA session lives in memory only, so a reload lands on the sign-in screen by
 * design. The mock redeems any number of times, so re-entering through the QA
 * link restores the session; everything else the app shows then comes from
 * `/api/me`, which is exactly what a reload is meant to prove. The reload
 * itself is the caller's, so a test reads as "reload, then re-enter".
 */
export async function reenterAfterReload(page: Page, url: string): Promise<void> {
  await page.goto(`${url}#/qa?code=TESTCODE`)
  await page.waitForSelector('.dock', { state: 'visible' })
}

/** The post-Drink summary sheet (the confirm is an alertdialog, so never this). */
export const summarySheet = (page: Page): Locator => page.getByRole('dialog')

/** Wait until every finite animation inside `dialog` has finished. */
export async function settleAnimations(dialog: Locator): Promise<void> {
  await dialog.evaluate(async (el) => {
    const finite = el.getAnimations({ subtree: true }).filter((animation) => {
      const end = animation.effect?.getComputedTiming().endTime
      return typeof end === 'number' && Number.isFinite(end)
    })
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)))
  })
}

/**
 * The open summary sheet, at rest: its finite animations have finished, and
 * Recent activity has settled — either shown, or its loading placeholder gone
 * (the section is omitted when history can't vouch for the cup).
 *
 * The placeholder is recognised by `aria-busy="true"` or a class containing
 * `placeholder`; the sheet must mark its loading state one of those ways.
 * "Omitted" is only believed once the sheet has stayed free of a placeholder
 * for a few polls, because the history read may not have started on the very
 * first frame. Polled from Node, never with page timers, so a test that has
 * installed `page.clock` can still settle.
 */
export async function settleSheet(page: Page): Promise<Locator> {
  const sheet = summarySheet(page)
  await expect(sheet).toBeVisible()
  await settleAnimations(sheet)
  let quietPolls = 0
  await expect
    .poll(
      async () => {
        const state = await sheet.evaluate((el) => ({
          loading: el.querySelector('[aria-busy="true"], [class*="placeholder"]') !== null,
          shown: /Recent activity/i.test(el.textContent ?? ''),
        }))
        if (state.loading) {
          quietPolls = 0
          return false
        }
        if (state.shown) return true
        quietPolls += 1
        return quietPolls >= 3
      },
      { message: 'Recent activity never settled', intervals: [150], timeout: 15_000 },
    )
    .toBe(true)
  // Whatever just rendered may have its own entry animation.
  await settleAnimations(sheet)
  return sheet
}
