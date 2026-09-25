import { describe, test, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import type { HistoryItem } from '../../src/api/client'

const me = vi.fn()
const historyCall = vi.fn()

vi.mock('../../src/api/client', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/api/client')>('../../src/api/client')
  return {
    ...actual,
    api: {
      me: (...a: unknown[]) => me(...a),
      history: (...a: unknown[]) => historyCall(...a),
    },
  }
})

const coffee = await import('../../src/state/coffee')
const { HISTORY_LIMIT, getHistorySnapshot, resetHistoryStore } = await import(
  '../../src/state/history'
)
const { PaceCard } = await import('../../src/components/PaceCard')

const DAY = 24 * 60 * 60 * 1000
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

const cup = (opId: string, age: number, overrides: Partial<HistoryItem> = {}): HistoryItem => ({
  opId,
  type: 'CONSUME',
  delta: -1,
  batchLabel: 'September beans',
  createdAt: ago(age),
  reversed: false,
  ...overrides,
})

const grant = (opId: string, age: number): HistoryItem => ({
  opId,
  type: 'GRANT',
  delta: 8,
  batchLabel: 'September beans',
  createdAt: ago(age),
  reversed: false,
})

const balance = (totalRemaining: number) => ({
  member: { memberId: 'M1', displayName: 'Dewa', role: 'member' as const, isQa: false },
  totalRemaining,
  allocations: [],
  undoOffer: null,
})

/** Five cups over the last ten days, three of them inside this week, newest first. */
const recentCups = (): HistoryItem[] => [
  cup('c1', 60_000),
  cup('c2', 1 * DAY),
  cup('c3', 2 * DAY),
  cup('c4', 9 * DAY),
  cup('c5', 10 * DAY),
]

/** Renders the card and lets /api/me and the history page it keys on settle. */
async function renderSettled() {
  const view = render(<PaceCard />)
  await act(async () => {
    await coffee.loadMe()
  })
  await waitFor(() => {
    const snap = getHistorySnapshot()
    expect(snap.loading).toBe(false)
    expect(snap.items !== null || snap.error !== null).toBe(true)
  })
  return view
}

beforeEach(() => {
  me.mockReset()
  historyCall.mockReset()
  coffee.resetCoffeeStore()
  resetHistoryStore()
  me.mockResolvedValue(balance(5))
})

describe('PaceCard hides what it cannot prove', () => {
  test('renders nothing while the history page is still loading', async () => {
    historyCall.mockReturnValue(new Promise(() => {}))
    const { container } = render(<PaceCard />)
    await act(async () => {
      await coffee.loadMe()
    })
    await waitFor(() => expect(historyCall).toHaveBeenCalled())

    expect(getHistorySnapshot().loading).toBe(true)
    expect(container).toBeEmptyDOMElement()
  })

  test('renders nothing when the history page failed', async () => {
    historyCall.mockRejectedValue(new Error('boom'))
    const { container } = await renderSettled()

    expect(getHistorySnapshot().error).not.toBeNull()
    expect(container).toBeEmptyDOMElement()
  })

  test('renders nothing when a full page cannot prove the week is complete', async () => {
    // A page cut off at the limit whose oldest row is still inside the week.
    const items = Array.from({ length: HISTORY_LIMIT }, (_, i) => cup(`c${i}`, 60_000 + i * 1000))
    historyCall.mockResolvedValue({ items })
    const { container } = await renderSettled()

    expect(container).toBeEmptyDOMElement()
  })

  test('renders nothing for an empty ledger', async () => {
    historyCall.mockResolvedValue({ items: [] })
    const { container } = await renderSettled()

    expect(container).toBeEmptyDOMElement()
  })

  test('renders nothing when the last 14 days hold no cups', async () => {
    // Tenure is proven, the week is known and zero, and the only cup is older than a fortnight.
    historyCall.mockResolvedValue({ items: [cup('old', 16 * DAY), grant('g', 20 * DAY)] })
    const { container } = await renderSettled()

    expect(container).toBeEmptyDOMElement()
  })

  test('a put-back drink is not a cup', async () => {
    historyCall.mockResolvedValue({
      items: [cup('c1', 60_000, { reversed: true }), grant('g', 20 * DAY)],
    })
    const { container } = await renderSettled()

    expect(container).toBeEmptyDOMElement()
  })
})

describe('PaceCard shows the week', () => {
  test('shows the heading, the 7-day count and the bars', async () => {
    historyCall.mockResolvedValue({ items: [...recentCups(), grant('g', 20 * DAY)] })
    await renderSettled()

    const card = screen.getByRole('region', { name: 'Your pace' })
    expect(within(card).getByRole('heading', { level: 2, name: 'Your pace' })).toBeInTheDocument()
    expect(within(card).getByText('3 cups in the last 7 days')).toBeInTheDocument()
    expect(card.querySelectorAll('path.recent-bars__bar')).toHaveLength(7)
    expect(card.querySelector('.visually-hidden')?.textContent).toMatch(/^Last 7 days: .* cups?\.$/)
  })

  test('shows a quiet week when the fortnight still had cups', async () => {
    historyCall.mockResolvedValue({ items: [cup('c1', 10 * DAY)] })
    await renderSettled()

    expect(screen.getByText('0 cups in the last 7 days')).toBeInTheDocument()
  })

  test('says "cup" for exactly one', async () => {
    historyCall.mockResolvedValue({ items: [cup('c1', 60_000)] })
    await renderSettled()

    expect(screen.getByText('1 cup in the last 7 days')).toBeInTheDocument()
  })
})

describe('PaceCard estimate', () => {
  test('sits inside the details, only once, and is labelled an Estimate when tenure is proven', async () => {
    // A GRANT 20 days old proves the member spans the whole fortnight.
    historyCall.mockResolvedValue({ items: [...recentCups(), grant('g', 20 * DAY)] })
    await renderSettled()

    const card = screen.getByRole('region', { name: 'Your pace' })
    const details = card.querySelector('details.pace__details') as HTMLDetailsElement
    expect(details).not.toBeNull()
    expect(within(details).getByText('How long will my cups last?').tagName).toBe('SUMMARY')

    // 5 remaining at 5 cups per 14 days is 14 days.
    expect(within(details).getByText('About 14 days left')).toBeInTheDocument()
    const detail = within(details).getByText(/Estimate/)
    expect(detail.textContent).toBe('At your 14-day pace (0.4 a day) · Estimate')

    // Nothing of the estimate leaks outside the disclosure.
    expect(screen.getAllByText(/Estimate/)).toHaveLength(1)
    expect(screen.getByText('About 14 days left').closest('details')).toBe(details)
  })

  test('is absent when every row is recent, though the bars still show', async () => {
    historyCall.mockResolvedValue({ items: recentCups() })
    await renderSettled()

    expect(screen.getByText('3 cups in the last 7 days')).toBeInTheDocument()
    expect(document.querySelector('details')).toBeNull()
    expect(screen.queryByText(/Estimate/)).toBeNull()
    expect(screen.queryByText('How long will my cups last?')).toBeNull()
  })

  test('is absent with nothing left to last', async () => {
    me.mockResolvedValue(balance(0))
    historyCall.mockResolvedValue({ items: [...recentCups(), grant('g', 20 * DAY)] })
    await renderSettled()

    expect(screen.getByText('3 cups in the last 7 days')).toBeInTheDocument()
    expect(document.querySelector('details')).toBeNull()
  })
})
