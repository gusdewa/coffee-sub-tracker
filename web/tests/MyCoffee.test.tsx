import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const me = vi.fn()
const drinkCall = vi.fn()
const undoCall = vi.fn()
const historyCall = vi.fn()

// Lets one test make the pace card throw, as an insight bug would.
const paceFault = vi.hoisted(() => ({ throws: false }))
vi.mock('../src/components/PaceCard', async () => {
  const actual = await vi.importActual<typeof import('../src/components/PaceCard')>(
    '../src/components/PaceCard',
  )
  const { createElement } = await import('react')
  return {
    ...actual,
    PaceCard: () => {
      if (paceFault.throws) throw new Error('an insight bug')
      return createElement(actual.PaceCard)
    },
  }
})

vi.mock('../src/api/client', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client')>('../src/api/client')
  return {
    ...actual,
    api: {
      me: (...a: unknown[]) => me(...a),
      drink: (...a: unknown[]) => drinkCall(...a),
      undo: (...a: unknown[]) => undoCall(...a),
      history: (...a: unknown[]) => historyCall(...a),
    },
  }
})

const store = await import('../src/state/coffee')
const { resetHistoryStore } = await import('../src/state/history')
const { MyCoffee } = await import('../src/screens/MyCoffee')
const { ApiError, OfflineError } = await import('../src/api/client')

const withBalance = (totalRemaining: number) => ({
  member: { memberId: 'M1', displayName: 'Dewa', role: 'member' as const, isQa: false },
  totalRemaining,
  allocations: totalRemaining
    ? [
        {
          batchId: 'B1',
          batchLabel: 'September beans',
          granted: 5,
          consumed: 5 - totalRemaining,
          remaining: totalRemaining,
          effectiveAt: '2026-09-01T00:00:00.000Z',
          allocRowKey: 'A|SEPTEMBER',
        },
      ]
    : [],
})

beforeEach(() => {
  vi.clearAllMocks()
  store.resetCoffeeStore()
  resetHistoryStore()
  paceFault.throws = false
  historyCall.mockResolvedValue({ items: [] })
})

const DAY = 24 * 60 * 60 * 1000
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const historyRow = (opId: string, type: 'CONSUME' | 'GRANT', age: number) => ({
  opId,
  type,
  delta: type === 'GRANT' ? 8 : -1,
  batchLabel: 'September beans',
  createdAt: ago(age),
  reversed: false,
})
/** Three cups this week, on a ledger that began three weeks ago: enough to prove a pace. */
const provenPace = () => ({
  items: [
    historyRow('c1', 'CONSUME', 60_000),
    historyRow('c2', 'CONSUME', 1 * DAY),
    historyRow('c3', 'CONSUME', 2 * DAY),
    historyRow('g1', 'GRANT', 20 * DAY),
  ],
})

afterEach(() => vi.useRealTimers())

/*
 * Drinking, undo and the double-tap guard moved to the shell with the action
 * itself; they are covered in tests/state/coffee.test.ts and
 * tests/shell/DrinkFab.test.tsx. What is left here is the picture of the
 * balance, which is what this screen is now for.
 */
describe('My Coffee', () => {
  test('shows the remaining total as the hero', async () => {
    me.mockResolvedValue(withBalance(3))
    render(<MyCoffee />)
    expect(await screen.findByText('3')).toBeInTheDocument()
    expect(screen.getByText('cups left')).toBeInTheDocument()
  })

  test('uses the singular when one cup is left', async () => {
    me.mockResolvedValue(withBalance(1))
    render(<MyCoffee />)
    expect(await screen.findByText('cup left')).toBeInTheDocument()
  })

  test('an empty balance says what to do about it', async () => {
    me.mockResolvedValue(withBalance(0))
    render(<MyCoffee />)
    expect(await screen.findByText(/Ask an admin to add a subscription/)).toBeInTheDocument()
  })

  test('marks the card the next drink will come from', async () => {
    me.mockResolvedValue(withBalance(3))
    render(<MyCoffee />)
    expect(await screen.findByText('next')).toBeInTheDocument()
  })

  test('keeps the final spent card visible and puts undo only on the consumed allocation', async () => {
    const data = withBalance(1)
    me.mockResolvedValue(data)
    render(<MyCoffee />)
    await screen.findByText('1')
    drinkCall.mockResolvedValue({
      opId: 'op-final', allocRowKey: 'A|SEPTEMBER', batchLabel: 'September beans',
      remainingTotal: 0, createdAt: new Date().toISOString(),
      undoExpiresAt: new Date(Date.now() + 90_000).toISOString(),
    })
    me.mockResolvedValue({
      ...data,
      totalRemaining: 0,
      allocations: [{ ...data.allocations[0], consumed: 5, remaining: 0 }],
    })
    await act(async () => void (await store.drink()))
    expect(await screen.findByRole('button', { name: 'Put back cup from September beans' })).toBeInTheDocument()
    expect(screen.getByText('September beans').closest('article')).toBeInTheDocument()
  })

  test('keeps Put Back on the card after the summary is dismissed, and puts back exactly that cup once', async () => {
    const data = withBalance(2)
    me.mockResolvedValue(data)
    render(<MyCoffee />)
    await screen.findByText('2')
    vi.useFakeTimers()
    drinkCall.mockResolvedValue({
      opId: 'op1', allocRowKey: 'A|SEPTEMBER', batchLabel: 'September beans',
      remainingTotal: 1, createdAt: new Date().toISOString(),
      undoExpiresAt: new Date(Date.now() + 90_000).toISOString(),
    })
    undoCall.mockResolvedValue({ remainingTotal: 2 })
    await act(async () => void (await store.drink()))

    // The summary goes, and time passes; the offer is the server's, not the summary's.
    act(() => store.dismissReceipt())
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    const putBack = screen.getByRole('button', { name: 'Put back cup from September beans' })
    expect(putBack).toHaveAttribute('title', 'Put back cup from September beans')
    expect(putBack).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(putBack)
      await Promise.resolve()
    })
    expect(undoCall).toHaveBeenCalledTimes(1)
    // undoDrink(opId): the button names its own cup, never whichever is latest.
    expect(undoCall).toHaveBeenCalledWith('op1', expect.any(String))
    expect(screen.queryByRole('button', { name: /put back cup/i })).toBeNull()
  })

  test.each([
    [
      'the server says it is too late',
      new ApiError('UNDO_WINDOW_EXPIRED', 'expired', 409),
      'Too late to put this one back — it stays counted.',
      false,
    ],
    [
      'no answer comes back',
      new OfflineError(),
      "Couldn't reach the server — check your balance before trying again.",
      true,
    ],
  ])('when %s, the reason shows on that card', async (_label, failure, copy, offerKept) => {
    const data = withBalance(2)
    data.allocations = [
      { ...data.allocations[0]!, remaining: 1, consumed: 4 },
      {
        allocRowKey: 'A|OCTOBER', batchId: 'B2', batchLabel: 'October beans',
        granted: 1, consumed: 0, remaining: 1, effectiveAt: '2026-10-01T00:00:00.000Z',
      },
    ]
    me.mockResolvedValue(data)
    render(<MyCoffee />)
    await screen.findByText('2')
    drinkCall.mockResolvedValue({
      opId: 'op1', allocRowKey: 'A|SEPTEMBER', batchLabel: 'September beans',
      remainingTotal: 1, createdAt: new Date().toISOString(),
      undoExpiresAt: new Date(Date.now() + 90_000).toISOString(),
    })
    me.mockResolvedValue({
      ...data,
      totalRemaining: 1,
      allocations: [{ ...data.allocations[0]!, remaining: 0, consumed: 5 }, data.allocations[1]!],
    })
    await act(async () => void (await store.drink()))
    act(() => store.dismissReceipt())
    undoCall.mockRejectedValue(failure)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Put back cup from September beans' }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(undoCall).toHaveBeenCalledWith('op1', expect.any(String))
    const september = screen.getByRole('heading', { name: 'September beans' }).closest('article')!
    const october = screen.getByRole('heading', { name: 'October beans' }).closest('article')!
    expect(within(september).getByRole('alert')).toHaveTextContent(copy)
    expect(within(october).queryByRole('alert')).toBeNull()
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(within(september).queryByRole('button', { name: /put back cup/i }) !== null).toBe(offerKept)
  })

  test('shows Put Back only on the exact consumed allocation, not the new FIFO card', async () => {
    const data = withBalance(2)
    data.allocations = [
      { ...data.allocations[0]!, remaining: 1, consumed: 4 },
      {
        allocRowKey: 'A|OCTOBER', batchId: 'B2', batchLabel: 'October beans',
        granted: 1, consumed: 0, remaining: 1, effectiveAt: '2026-10-01T00:00:00.000Z',
      },
    ]
    me.mockResolvedValue(data)
    render(<MyCoffee />)
    await screen.findByText('2')
    drinkCall.mockResolvedValue({
      opId: 'op1', allocRowKey: 'A|SEPTEMBER', batchLabel: 'September beans',
      remainingTotal: 1, createdAt: new Date().toISOString(),
      undoExpiresAt: new Date(Date.now() + 90_000).toISOString(),
    })
    me.mockResolvedValue({
      ...data,
      totalRemaining: 1,
      allocations: [
        { ...data.allocations[0]!, remaining: 0, consumed: 5 },
        data.allocations[1]!,
      ],
    })
    await act(async () => void (await store.drink()))

    const september = screen.getByRole('heading', { name: 'September beans' }).closest('article')!
    const october = screen.getByRole('heading', { name: 'October beans' }).closest('article')!
    expect(within(september).getByRole('button', { name: /put back cup/i })).toBeInTheDocument()
    expect(within(october).queryByRole('button', { name: /put back cup/i })).toBeNull()
    expect(within(october).getByText('next')).toBeInTheDocument()
  })

  test('Put Back sits at the card’s top-right, with the date moved to the meta line', async () => {
    const data = withBalance(2)
    me.mockResolvedValue(data)
    render(<MyCoffee />)
    await screen.findByText('2')
    drinkCall.mockResolvedValue({
      opId: 'op1', allocRowKey: 'A|SEPTEMBER', batchLabel: 'September beans',
      remainingTotal: 1, createdAt: new Date().toISOString(),
      undoExpiresAt: new Date(Date.now() + 90_000).toISOString(),
    })
    me.mockReturnValue(new Promise(() => {}))
    await act(async () => void (await store.drink()))

    const card = screen.getByRole('heading', { name: 'September beans' }).closest('article')!
    const head = card.querySelector('.card__head')!
    // In the header beside the title, so it reads right after the card's name.
    expect(within(head as HTMLElement).getByRole('button', { name: 'Put back cup from September beans' })).toBeInTheDocument()
    expect(head.querySelector('.card__date')).toBeNull()
    const meta = card.querySelector('.card__count')!
    const date = new Date('2026-09-01T00:00:00.000Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    expect(meta.textContent).toContain(`${date} · 1/5`)
  })

  test('after a card’s Put Back, focus lands on that card’s title rather than being lost', async () => {
    const data = withBalance(2)
    me.mockResolvedValue(data)
    render(<MyCoffee />)
    await screen.findByText('2')
    drinkCall.mockResolvedValue({
      opId: 'op1', allocRowKey: 'A|SEPTEMBER', batchLabel: 'September beans',
      remainingTotal: 1, createdAt: new Date().toISOString(),
      undoExpiresAt: new Date(Date.now() + 90_000).toISOString(),
    })
    undoCall.mockResolvedValue({ remainingTotal: 2 })
    me.mockReturnValue(new Promise(() => {}))
    await act(async () => void (await store.drink()))
    act(() => store.dismissReceipt())

    const putBack = screen.getByRole('button', { name: 'Put back cup from September beans' })
    putBack.focus()
    await act(async () => {
      fireEvent.click(putBack)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(screen.queryByRole('button', { name: /put back cup/i })).toBeNull()
    const title = screen.getByRole('heading', { name: 'September beans' })
    expect(title).toHaveAttribute('tabindex', '-1')
    expect(title).toHaveFocus()
  })

  test('the next marker counts over the cards actually rendered', async () => {
    // A granted:0 batch ahead of the FIFO head used to slide the index and the
    // rendered list apart, putting the badge on the wrong card.
    me.mockResolvedValue({
      member: { memberId: 'M1', displayName: 'Dewa', role: 'member' as const, isQa: false },
      totalRemaining: 2,
      allocations: [
        {
          allocRowKey: 'A|EMPTY',
          batchId: 'B0',
          batchLabel: 'Empty batch',
          granted: 0,
          consumed: 0,
          remaining: 0,
          effectiveAt: '2026-08-01T00:00:00.000Z',
        },
        {
          allocRowKey: 'A|SEPTEMBER',
          batchId: 'B1',
          batchLabel: 'September beans',
          granted: 4,
          consumed: 2,
          remaining: 2,
          effectiveAt: '2026-09-01T00:00:00.000Z',
        },
      ],
    })
    render(<MyCoffee />)
    const badge = await screen.findByText('next')
    expect(badge.closest('article')).toHaveTextContent('September beans')
  })

  test('the balance is the tour target, so the walkthrough can point at it', async () => {
    me.mockResolvedValue(withBalance(3))
    const { container } = render(<MyCoffee />)
    await screen.findByText('3')
    expect(container.querySelector('[data-tour="balance"]')).not.toBeNull()
  })
})

/*
 * The page answers three questions in order: how many are left, which card the
 * next one comes off, and what you can do now. The third is the floating
 * action in the shell, so this page must not grow a second big Drink button.
 */
describe('Home reads in the right order', () => {
  test('the balance comes before the card list in the document', async () => {
    me.mockResolvedValue(withBalance(3))
    const { container } = render(<MyCoffee />)
    await screen.findByText('3')

    const hero = container.querySelector('[data-tour="balance"]')!
    const cards = container.querySelector('.home__cards')!
    expect(hero.compareDocumentPosition(cards) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test('names the card the next cup will come off', async () => {
    me.mockResolvedValue(withBalance(3))
    render(<MyCoffee />)
    expect(await screen.findByText(/next cup from/i)).toBeInTheDocument()
    expect(screen.getAllByText(/September beans/).length).toBeGreaterThan(0)
  })

  test('does not repeat the Drink action inside the page', async () => {
    me.mockResolvedValue(withBalance(3))
    render(<MyCoffee />)
    await screen.findByText('3')
    // The shell owns the repeat action; two of them would compete.
    expect(screen.queryByRole('button', { name: /drink/i })).toBeNull()
  })

  test('an empty balance says what to do instead of naming a next card', async () => {
    me.mockResolvedValue(withBalance(0))
    render(<MyCoffee />)
    expect(await screen.findByText(/Ask an admin to add a subscription/)).toBeInTheDocument()
    expect(screen.queryByText(/next cup from/i)).toBeNull()
  })

  test('the card list is a labelled section, so the headings step by one', async () => {
    me.mockResolvedValue(withBalance(3))
    render(<MyCoffee />)
    expect(await screen.findByRole('heading', { name: /your cards/i })).toBeInTheDocument()
  })
})

describe('the pace card on Home', () => {
  test('sits under Your cards once history proves the week', async () => {
    me.mockResolvedValue(withBalance(3))
    historyCall.mockResolvedValue(provenPace())
    const { container } = render(<MyCoffee />)

    expect(await screen.findByRole('heading', { name: 'Your pace' })).toBeInTheDocument()
    expect(screen.getByText('3 cups in the last 7 days')).toBeInTheDocument()
    const cards = container.querySelector('.home__cards')!
    const pace = container.querySelector('.pace')!
    expect(cards.compareDocumentPosition(pace) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The estimate is a guess, so it waits behind a question.
    const details = screen.getByText('How long will my cups last?').closest('details')!
    expect(within(details).getByText(/Estimate/)).toBeInTheDocument()
  })

  test('is left out when history has nothing to show', async () => {
    me.mockResolvedValue(withBalance(3))
    render(<MyCoffee />)
    await screen.findByText('3')
    await waitFor(() => expect(historyCall).toHaveBeenCalled())
    await act(async () => {})
    expect(screen.queryByRole('heading', { name: 'Your pace' })).toBeNull()
  })

  test('a pace card that throws is dropped on its own; the balance and cards stay', async () => {
    paceFault.throws = true
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      me.mockResolvedValue(withBalance(3))
      historyCall.mockResolvedValue(provenPace())
      render(<MyCoffee />)
      expect(await screen.findByText('cups left')).toBeInTheDocument()
      expect(screen.getByRole('heading', { name: 'September beans' })).toBeInTheDocument()
      expect(screen.queryByRole('heading', { name: 'Your pace' })).toBeNull()
    } finally {
      consoleError.mockRestore()
    }
  })
})

