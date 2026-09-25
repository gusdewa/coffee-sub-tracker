import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/**
 * The summary that follows a Drink: `Drink 1`, the live state, Put Back for
 * this exact cup, a few provable figures, and a Share link the person chooses
 * to tap. Mounted beside the real Drink action, because focus has to come back
 * to it and the receipt is only ever made by a tap.
 */

const me = vi.fn()
const drinkCall = vi.fn()
const undoCall = vi.fn()
const balancesCall = vi.fn()
const historyCall = vi.fn()

vi.mock('../../src/api/client', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/api/client')>('../../src/api/client')
  return {
    ...actual,
    api: {
      me: (...a: unknown[]) => me(...a),
      drink: (...a: unknown[]) => drinkCall(...a),
      undo: (...a: unknown[]) => undoCall(...a),
      balances: (...a: unknown[]) => balancesCall(...a),
      history: (...a: unknown[]) => historyCall(...a),
    },
  }
})

const store = await import('../../src/state/coffee')
const { resetHistoryStore } = await import('../../src/state/history')
const { DrinkFab } = await import('../../src/shell/DrinkFab')
const { DrinkSummarySheet } = await import('../../src/shell/DrinkSummarySheet')
const { ApiError, OfflineError, TimeoutError } = await import('../../src/api/client')

/** 09:12 in Jakarta, on a Friday. */
const NOW = '2026-09-25T02:12:00.000Z'
/** 23:59:59.999 in Jakarta that same day, the server's Put Back deadline. */
const END_OF_DAY = '2026-09-25T16:59:59.999Z'

interface Card {
  allocRowKey: string
  batchId: string
  batchLabel: string
  granted: number
  consumed: number
  remaining: number
  effectiveAt: string
}

const card = (label: string, key: string, granted: number, remaining: number): Card => ({
  allocRowKey: `A|${key}`,
  batchId: `B-${key}`,
  batchLabel: label,
  granted,
  consumed: granted - remaining,
  remaining,
  effectiveAt: '2026-09-01T00:00:00.000Z',
})

const account = (cards: Card[], extra: Record<string, unknown> = {}) => ({
  member: { memberId: 'M1', displayName: 'Dewa', role: 'member' as const, isQa: false },
  totalRemaining: cards.reduce((sum, c) => sum + c.remaining, 0),
  allocations: cards,
  ...extra,
})

const offer = {
  opId: 'op1',
  allocRowKey: 'A|SEP',
  batchId: 'B-SEP',
  batchLabel: 'September beans',
  createdAt: NOW,
  undoExpiresAt: END_OF_DAY,
}

const counted = (overrides: Record<string, unknown> = {}) => ({
  opId: 'op1',
  txnRowKey: 'T1',
  allocRowKey: 'A|SEP',
  batchId: 'B-SEP',
  batchLabel: 'September beans',
  remainingTotal: 4,
  createdAt: NOW,
  undoExpiresAt: END_OF_DAY,
  replayed: false,
  ...overrides,
})

const row = (opId: string, type: string, createdAt: string, reversed = false) => ({
  opId,
  type,
  delta: type === 'CONSUME' ? -1 : 8,
  batchLabel: 'September beans',
  createdAt,
  reversed,
})
/** This Drink, an earlier cup the same morning, and the grant that started it all. */
const pageWithThisCup = () => ({
  items: [
    row('op1', 'CONSUME', NOW),
    row('op0', 'CONSUME', '2026-09-25T00:30:00.000Z'),
    row('g1', 'GRANT', '2026-09-01T00:00:00.000Z'),
  ],
})

/** Lets settled promises and their follow-ups land. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

/**
 * Loads `before`, taps Drink and waits for the summary. `after` is what /api/me
 * says once the cup is in — the Drink's own refresh reads it.
 */
async function drinkAndOpen({
  before = account([card('September beans', 'SEP', 8, 5)]),
  after = account([card('September beans', 'SEP', 8, 4)], { undoOffer: offer }),
  result = counted(),
  clipboard = true,
}: {
  before?: ReturnType<typeof account>
  /** An Error makes that refresh fail. */
  after?: ReturnType<typeof account> | Error
  result?: Record<string, unknown>
  clipboard?: boolean
} = {}) {
  me.mockResolvedValue(before)
  await act(async () => void (await store.loadMe()))
  if (after instanceof Error) me.mockRejectedValue(after)
  else me.mockResolvedValue(after)
  drinkCall.mockResolvedValue(result)
  const user = userEvent.setup()
  // user-event installs a clipboard stub on setup; take it away again to be a
  // browser without one.
  if (!clipboard) Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
  render(
    <>
      <DrinkFab />
      <DrinkSummarySheet />
    </>,
  )
  const fab = screen.getByRole('button', { name: 'Drink' })
  await user.click(fab)
  const dialog = await screen.findByRole('dialog', { name: 'Drink 1' })
  // The Drink's own /api/me refresh has landed.
  await waitFor(() => expect(me).toHaveBeenCalledTimes(2))
  await settle()
  return { user, dialog, fab }
}

const shareLink = (dialog: HTMLElement) => within(dialog).getByRole('link', { name: 'Share to WhatsApp' })
const sharedMessage = (link: HTMLElement) =>
  decodeURIComponent(link.getAttribute('href')!.slice('https://wa.me/?text='.length))

beforeEach(() => {
  vi.clearAllMocks()
  // Date only: user-event, waitFor and the store's timers keep real time.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  vi.spyOn(window, 'open').mockReturnValue(null)
  store.resetCoffeeStore()
  resetHistoryStore()
  historyCall.mockResolvedValue(pageWithThisCup())
  balancesCall.mockResolvedValue({
    balances: [
      // The drinker's row predates the Drink; the live number replaces it.
      { memberId: 'M1', displayName: 'Dewa', remaining: 5 },
      { memberId: 'M2', displayName: 'Ayu', remaining: 2 },
    ],
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('what the summary shows', () => {
  test('opens on Drink 1, focused, with the live balance and the card the cup came off', async () => {
    const { dialog } = await drinkAndOpen()

    const heading = within(dialog).getByRole('heading', { name: 'Drink 1' })
    expect(heading).toHaveFocus()
    expect(dialog).toHaveAccessibleDescription('4 cups left now')
    expect(within(dialog).getByText('Cup counted · 09:12 · September beans')).toBeInTheDocument()
    expect(within(dialog).getByText('September beans · 4 of 8 left')).toBeInTheDocument()
  })

  test('the balance follows /api/me, not the number the Drink answered with', async () => {
    // Someone else's cup came off the same account while this one was counted.
    const { dialog } = await drinkAndOpen({
      after: account([card('September beans', 'SEP', 8, 3)], { undoOffer: offer }),
    })

    expect(dialog).toHaveAccessibleDescription('3 cups left now')
    expect(within(dialog).getByText('September beans · 3 of 8 left')).toBeInTheDocument()
  })

  test('the last cup on a card says so, and names the card the next one comes from', async () => {
    const { dialog } = await drinkAndOpen({
      before: account([card('September beans', 'SEP', 8, 1), card('October beans', 'OCT', 8, 8)]),
      after: account([card('September beans', 'SEP', 8, 0), card('October beans', 'OCT', 8, 8)], {
        undoOffer: offer,
      }),
      result: counted({ remainingTotal: 8 }),
    })

    expect(
      within(dialog).getByText(
        'That was the last cup on September beans. Next cup comes from October beans.',
      ),
    ).toBeInTheDocument()
  })

  test('the last cup of all says what to do next', async () => {
    const { dialog } = await drinkAndOpen({
      before: account([card('September beans', 'SEP', 8, 1)]),
      after: account([card('September beans', 'SEP', 8, 0)], { undoOffer: offer }),
      result: counted({ remainingTotal: 0 }),
    })

    expect(dialog).toHaveAccessibleDescription('0 cups left now')
    expect(
      within(dialog).getByText('That was your last cup. Ask an admin to add a subscription.'),
    ).toBeInTheDocument()
  })

  test('an older API’s bare response still renders, leaving out what it did not say', async () => {
    const { dialog } = await drinkAndOpen({
      after: account([card('September beans', 'SEP', 8, 4)]),
      result: { opId: 'op1', batchLabel: '', remainingTotal: 4 },
    })

    expect(within(dialog).getByRole('heading', { name: 'Drink 1' })).toHaveFocus()
    expect(within(dialog).getByText('Cup counted · just now')).toBeInTheDocument()
    expect(dialog).toHaveAccessibleDescription('4 cups left now')
    // No allocation to match, so no card line rather than a guess.
    expect(within(dialog).queryByText(/of 8 left/)).toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Put back this cup' })).toHaveAccessibleDescription(
      'Available today',
    )
    expect(sharedMessage(shareLink(dialog))).toContain('\nDewa drank 1 cup.\n')
  })
})

describe('Put Back from the summary', () => {
  test('the caption gives the server’s Jakarta deadline', async () => {
    const { dialog } = await drinkAndOpen()

    expect(within(dialog).getByRole('button', { name: 'Put back this cup' })).toHaveAccessibleDescription(
      'Available until 23:59 today',
    )
  })

  test('a double-tapped Put Back sends one undo, then reads “Cup put back” with focus on the heading', async () => {
    let release: (value: unknown) => void = () => {}
    undoCall.mockImplementation(() => new Promise((resolve) => (release = resolve)))
    const { user, dialog } = await drinkAndOpen()
    me.mockResolvedValue(account([card('September beans', 'SEP', 8, 5)], { undoOffer: null }))

    await user.dblClick(within(dialog).getByRole('button', { name: 'Put back this cup' }))
    expect(undoCall).toHaveBeenCalledTimes(1)
    expect(undoCall).toHaveBeenCalledWith('op1', expect.any(String))
    await act(async () => release({ remainingTotal: 5 }))

    const heading = await within(dialog).findByRole('heading', { name: 'Cup put back' })
    expect(heading).toHaveFocus()
    expect(dialog).toHaveAccessibleDescription('5 cups left now')
    expect(within(dialog).queryByRole('button', { name: 'Put back this cup' })).toBeNull()
    expect(within(dialog).queryByRole('link', { name: 'Share to WhatsApp' })).toBeNull()
    expect(undoCall).toHaveBeenCalledTimes(1)
    expect(drinkCall).toHaveBeenCalledTimes(1)
  })

  test('ALREADY_UNDONE reads as put back, and Share goes', async () => {
    undoCall.mockRejectedValue(new ApiError('ALREADY_UNDONE', 'already', 409))
    const { user, dialog } = await drinkAndOpen()

    await user.click(within(dialog).getByRole('button', { name: 'Put back this cup' }))

    expect(await within(dialog).findByRole('heading', { name: 'Cup put back' })).toHaveFocus()
    expect(within(dialog).queryByRole('link', { name: 'Share to WhatsApp' })).toBeNull()
    await waitFor(() => expect(me).toHaveBeenCalledTimes(3))
  })

  test('a Put Back that never answered never claims the cup was not counted', async () => {
    undoCall.mockRejectedValue(new OfflineError())
    const { user, dialog } = await drinkAndOpen()

    await user.click(within(dialog).getByRole('button', { name: 'Put back this cup' }))

    const alert = within(dialog).getByRole('alert')
    await waitFor(() =>
      expect(alert).toHaveTextContent("Couldn't reach the server — check your balance before trying again."),
    )
    expect(alert).not.toHaveTextContent(/not counted/i)
    // It may still be pending on the server, so the offer and the heading stay.
    expect(within(dialog).getByRole('heading', { name: 'Drink 1' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Put back this cup' })).toBeInTheDocument()
  })

  test.each([
    ['UNDO_WINDOW_EXPIRED', 'Too late to put this one back — it stays counted.', null],
    [
      'NOT_LATEST_CONSUME',
      'A newer cup was counted — put it back from its card.',
      { ...offer, opId: 'op9', createdAt: '2026-09-25T02:20:00.000Z' },
    ],
  ])('%s is explained in the sheet, and the cup stays counted', async (code, copy, offerAfter) => {
    undoCall.mockRejectedValue(new ApiError(code, 'refused', 409))
    const { user, dialog } = await drinkAndOpen()
    // What /api/me says once the server has refused: no offer, or a newer cup's.
    me.mockResolvedValue(account([card('September beans', 'SEP', 8, 4)], { undoOffer: offerAfter }))

    await user.click(within(dialog).getByRole('button', { name: 'Put back this cup' }))

    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent(copy))
    // Said once, by the alert, not twice.
    expect(within(dialog).getAllByText(copy)).toHaveLength(1)
    expect(within(dialog).queryByRole('button', { name: 'Put back this cup' })).toBeNull()
    // The button that had focus is gone; focus is picked up by the heading
    // rather than dropped on <body>, where a keyboard or screen reader loses it.
    expect(within(dialog).getByRole('heading', { name: 'Drink 1' })).toHaveFocus()
  })

  test('a newer cup holding the offer sends Put Back to its own card', async () => {
    const { dialog } = await drinkAndOpen({
      // Drunk on another device after this one.
      after: account([card('September beans', 'SEP', 8, 3)], {
        undoOffer: { ...offer, opId: 'op9', createdAt: '2026-09-25T02:20:00.000Z' },
      }),
    })

    expect(
      within(dialog).getByText('A newer cup was counted — put it back from its card.'),
    ).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Put back this cup' })).toBeNull()
    expect(within(dialog).getByRole('heading', { name: 'Drink 1' })).toBeInTheDocument()
  })

  test('offline, Put Back is disabled and says why', async () => {
    const { dialog } = await drinkAndOpen()

    act(() => void window.dispatchEvent(new Event('offline')))

    const putBack = within(dialog).getByRole('button', { name: 'Put back this cup' })
    expect(putBack).toBeDisabled()
    expect(putBack).toHaveAccessibleDescription(
      "Available until 23:59 today You're offline. Put Back needs a connection.",
    )
    act(() => void window.dispatchEvent(new Event('online')))
    expect(putBack).toBeEnabled()
  })

  test('when the offer ends and history shows the cup reversed, it reads “Cup put back”', async () => {
    const { dialog } = await drinkAndOpen()
    await waitFor(() => expect(historyCall).toHaveBeenCalled())
    const asked = historyCall.mock.calls.length

    // Put back on another device: the next /api/me has no offer and the full balance.
    historyCall.mockResolvedValue({
      items: [
        row('r1', 'REVERSAL', '2026-09-25T02:30:00.000Z'),
        row('op1', 'CONSUME', NOW, true),
        row('g1', 'GRANT', '2026-09-01T00:00:00.000Z'),
      ],
    })
    me.mockResolvedValue(account([card('September beans', 'SEP', 8, 5)], { undoOffer: null }))
    await act(async () => void (await store.loadMe()))

    expect(await within(dialog).findByRole('heading', { name: 'Cup put back' })).toHaveFocus()
    expect(historyCall.mock.calls.length).toBeGreaterThan(asked)
    expect(within(dialog).queryByRole('link', { name: 'Share to WhatsApp' })).toBeNull()
  })

  test('when the offer ends but history still counts the cup, it stays on Drink 1', async () => {
    const { dialog } = await drinkAndOpen()
    await waitFor(() => expect(historyCall).toHaveBeenCalled())
    const asked = historyCall.mock.calls.length

    // The deadline passed: no offer, same balance, and the ledger still has the cup.
    me.mockResolvedValue(account([card('September beans', 'SEP', 8, 4)], { undoOffer: null }))
    await act(async () => void (await store.loadMe()))
    await waitFor(() => expect(historyCall.mock.calls.length).toBeGreaterThan(asked))
    await settle()

    expect(within(dialog).getByRole('heading', { name: 'Drink 1' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Put back this cup' })).toBeNull()
    expect(within(dialog).getByRole('link', { name: 'Share to WhatsApp' })).toBeInTheDocument()
  })

  test('a failed /api/me after the Drink puts no alert inside the sheet', async () => {
    const { dialog } = await drinkAndOpen({ after: new Error('refresh failed') })
    await waitFor(() => expect(store.getCoffeeState().error).not.toBeNull())

    // The shell reports it, behind the sheet; the sheet never renders state.error.
    expect(screen.getAllByRole('alert').some((a) => a.textContent?.includes('Something went wrong.'))).toBe(true)
    for (const alert of within(dialog).queryAllByRole('alert')) expect(alert).toBeEmptyDOMElement()
    expect(within(dialog).queryByText(/went wrong|not counted/i)).toBeNull()
    expect(within(dialog).getByRole('heading', { name: 'Drink 1' })).toBeInTheDocument()
  })
})

describe('Share to WhatsApp', () => {
  test('is a real wa.me link carrying the full recap; tapping it neither drinks nor opens a window', async () => {
    const { user, dialog } = await drinkAndOpen()
    const link = shareLink(dialog)
    await waitFor(() =>
      expect(link).toHaveAccessibleDescription('Includes team balances for 2 people'),
    )

    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(link.getAttribute('href')).toMatch(/^https:\/\/wa\.me\/\?text=/)
    const message = sharedMessage(link)
    expect(message).toBe(
      'Cart Coffee\n' +
        'Dewa drank 1 cup from September beans.\n' +
        '\n' +
        'Current balances:\n' +
        'Dewa: 4 cups\n' +
        'Ayu: 2 cups\n' +
        'Total remaining: 6 cups',
    )
    // The preview is the exact text the link carries.
    expect(dialog.querySelector('pre')?.textContent).toBe(message)

    let prevented: boolean | null = null
    const observe = (event: Event) => {
      prevented = event.defaultPrevented
      // jsdom cannot follow a link out of the page; the browser would.
      event.preventDefault()
    }
    document.addEventListener('click', observe)
    try {
      await user.click(link)
    } finally {
      document.removeEventListener('click', observe)
    }

    expect(prevented).toBe(false)
    expect(window.open).not.toHaveBeenCalled()
    expect(drinkCall).toHaveBeenCalledTimes(1)
    // The sheet stays, with the fallback for a share that did not open.
    expect(screen.getByRole('dialog', { name: 'Drink 1' })).toBe(dialog)
    expect(within(dialog).getByText("Didn't open? Copy the message instead.")).toBeInTheDocument()
  })

  test('balances that fail leave a truthful self-only recap', async () => {
    balancesCall.mockRejectedValue(new Error('balances unavailable'))
    const { dialog } = await drinkAndOpen()
    const link = shareLink(dialog)

    await waitFor(() =>
      expect(link).toHaveAccessibleDescription('Team balances unavailable — shares your balance only'),
    )
    const message = sharedMessage(link)
    expect(message).toContain('Dewa drank 1 cup')
    expect(message).toContain('September beans')
    expect(message).toContain('Dewa: 4 cups')
    expect(message).not.toContain('Ayu')
    expect(message).toContain('Team balances not included.')
    expect(message).not.toContain('Current balances:')
    expect(message).not.toContain('Total remaining:')
  })

  test.each([
    ['still loading', () => new Promise(() => {}), 'Shares your balance only (team balances still loading)'],
    ['timed out', () => Promise.reject(new TimeoutError()), 'Team balances unavailable — shares your balance only'],
  ])('while team balances are %s the caption says what the message holds', async (_label, answer, caption) => {
    balancesCall.mockImplementation(answer)
    const { dialog } = await drinkAndOpen()
    const link = shareLink(dialog)

    await waitFor(() => expect(link).toHaveAccessibleDescription(caption))
    expect(sharedMessage(link)).toContain('Team balances not included.')
    expect(sharedMessage(link)).toContain('Dewa: 4 cups')
  })

  test('Copy message copies the exact text and says so', async () => {
    const { user, dialog } = await drinkAndOpen()
    const link = shareLink(dialog)
    await waitFor(() => expect(link).toHaveAccessibleDescription(/Includes team balances/))
    const writeText = vi.spyOn(navigator.clipboard, 'writeText')

    await user.click(within(dialog).getByText('Preview message'))
    await user.click(within(dialog).getByRole('button', { name: 'Copy message' }))

    expect(writeText).toHaveBeenCalledWith(sharedMessage(link))
    await waitFor(() =>
      expect(dialog.querySelector('.sheet__copy [role="status"]')).toHaveTextContent('Copied'),
    )
  })

  test('the preview opens in the scrolling body, so a long recap can never push Done out of reach', async () => {
    const { dialog } = await drinkAndOpen()
    const body = dialog.querySelector<HTMLElement>('.sheet__body')!
    const footer = dialog.querySelector<HTMLElement>('.sheet__footer')!

    // The footer never scrolls and the sheet clips at the viewport, so a
    // team-length message opened in it would push Done below the edge.
    const preview = within(dialog).getByText('Preview message').closest('details')!
    expect(body).toContainElement(preview)
    expect(body).toContainElement(within(dialog).getByRole('button', { name: 'Copy message', hidden: true }))
    expect(footer.querySelector('details, pre')).toBeNull()
    // The footer keeps the actions, and the caption that says what Share sends.
    expect(within(footer).getByRole('link', { name: 'Share to WhatsApp' })).toBe(shareLink(dialog))
    expect(within(footer).getByRole('button', { name: 'Done' })).toBeInTheDocument()
  })

  test('without a clipboard there is no Copy button, and the preview still shows the text', async () => {
    const { dialog } = await drinkAndOpen({ clipboard: false })

    expect(within(dialog).queryByRole('button', { name: 'Copy message', hidden: true })).toBeNull()
    expect(dialog.querySelector('pre')).toHaveTextContent('Dewa drank 1 cup from September beans.')
  })
})

describe('recent activity', () => {
  test('counts today’s cups, and draws the week as bars read out once as a sentence', async () => {
    const { dialog } = await drinkAndOpen()

    expect(await within(dialog).findByText('2 cups today')).toBeInTheDocument()
    const chart = dialog.querySelector('.sheet__recent .recent-bars svg')
    expect(chart).not.toBeNull()
    expect(chart).toHaveAttribute('aria-hidden', 'true')
    expect(chart!.querySelectorAll('.recent-bars__bar')).toHaveLength(7)
    // One sentence for the week, not one from the sheet and another from the bars.
    const week = within(dialog).getAllByText(/^Last 7 days:/)
    expect(week).toHaveLength(1)
    expect(week[0]).toHaveClass('visually-hidden')
    expect(week[0]!.textContent).toMatch(/^Last 7 days: (\S+ 0, ){6}today 2 cups\.$/)
  })

  test('is left out when the page does not hold this cup', async () => {
    historyCall.mockResolvedValue({ items: [row('op0', 'CONSUME', '2026-09-25T00:30:00.000Z')] })
    const { dialog } = await drinkAndOpen()
    await waitFor(() => expect(historyCall).toHaveBeenCalled())
    await settle()

    expect(within(dialog).queryByText(/cups? today/)).toBeNull()
    expect(within(dialog).queryByText(/^Last 7 days:/)).toBeNull()
    expect(dialog.querySelector('.sheet__recent')).toBeNull()
  })

  test('is left out when history cannot be read, rather than showing zeros', async () => {
    historyCall.mockRejectedValue(new TimeoutError())
    const { dialog } = await drinkAndOpen()
    await settle()

    expect(dialog.querySelector('.sheet__recent')).toBeNull()
    expect(within(dialog).queryByText(/cups? today/)).toBeNull()
  })

  test('holds a still, fixed placeholder while the page loads', async () => {
    historyCall.mockImplementation(() => new Promise(() => {}))
    const { dialog } = await drinkAndOpen()

    const placeholder = dialog.querySelector('.sheet__recent--pending')
    expect(placeholder).not.toBeNull()
    expect(placeholder).toHaveAttribute('aria-hidden', 'true')
    // What the e2e settle helper waits on before it measures the sheet.
    expect(placeholder).toHaveAttribute('aria-busy', 'true')
    expect(placeholder).not.toHaveClass('skeleton')
    expect(within(dialog).queryByText(/cups? today/)).toBeNull()
  })
})

describe('closing the summary', () => {
  test.each([
    ['Done', async (user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) =>
      user.click(within(dialog).getByRole('button', { name: 'Done' }))],
    ['Escape', async (user: ReturnType<typeof userEvent.setup>) => user.keyboard('{Escape}')],
    ['a backdrop tap', async (_user: unknown, dialog: HTMLElement) => {
      fireEvent.pointerDown(dialog)
      fireEvent.click(dialog)
    }],
  ])('%s closes it, hands focus back to Drink, and keeps the card’s Put Back', async (_label, close) => {
    const { user, dialog, fab } = await drinkAndOpen()

    await close(user, dialog)

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(fab).toHaveFocus()
    expect(store.getCoffeeState().receipt).toBeNull()
    expect(store.getCoffeeState().undo?.opId).toBe('op1')
    expect(drinkCall).toHaveBeenCalledTimes(1)
  })

  test('its live regions are in place, and empty, before anything happens', async () => {
    const { dialog } = await drinkAndOpen()

    expect(within(dialog).getByRole('alert')).toBeEmptyDOMElement()
    expect(dialog.querySelector('.sheet__copy [role="status"]')).toBeEmptyDOMElement()
  })
})
