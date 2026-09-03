import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const me = vi.fn()

vi.mock('../src/api/client', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client')>('../src/api/client')
  return { ...actual, api: { me: (...a: unknown[]) => me(...a) } }
})

const store = await import('../src/state/coffee')
const { MyCoffee } = await import('../src/screens/MyCoffee')

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
        },
      ]
    : [],
})

beforeEach(() => {
  vi.clearAllMocks()
  store.resetCoffeeStore()
})

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

  test('the next marker counts over the cards actually rendered', async () => {
    // A granted:0 batch ahead of the FIFO head used to slide the index and the
    // rendered list apart, putting the badge on the wrong card.
    me.mockResolvedValue({
      member: { memberId: 'M1', displayName: 'Dewa', role: 'member' as const, isQa: false },
      totalRemaining: 2,
      allocations: [
        {
          batchId: 'B0',
          batchLabel: 'Empty batch',
          granted: 0,
          consumed: 0,
          remaining: 0,
          effectiveAt: '2026-08-01T00:00:00.000Z',
        },
        {
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

