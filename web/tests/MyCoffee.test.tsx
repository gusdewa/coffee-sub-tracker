import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const drink = vi.fn()
const me = vi.fn()
const undo = vi.fn()

vi.mock('../src/api/client', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client')>('../src/api/client')
  return {
    ...actual,
    api: {
      me: (...a: unknown[]) => me(...a),
      drink: (...a: unknown[]) => drink(...a),
      undo: (...a: unknown[]) => undo(...a),
    },
  }
})

const { MyCoffee } = await import('../src/screens/MyCoffee')
const { ApiError } = await import('../src/api/client')

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
})

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

  test('a double tap sends exactly one request, with one idempotency key', async () => {
    me.mockResolvedValue(withBalance(5))
    let release: (v: unknown) => void = () => {}
    drink.mockImplementation(
      () =>
        new Promise((res) => {
          release = res
        }),
    )

    const user = userEvent.setup()
    render(<MyCoffee />)
    const button = await screen.findByRole('button', { name: 'Drink 1' })

    await user.click(button)
    // The button disables while in flight, so the second tap cannot fire.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Working…' })).toBeDisabled())
    await user.click(screen.getByRole('button', { name: 'Working…' }))

    expect(drink).toHaveBeenCalledTimes(1)
    release({ opId: 'op1', batchLabel: 'September beans', remainingTotal: 4 })
  })

  test('zero balance disables the action and explains what to do', async () => {
    me.mockResolvedValue(withBalance(0))
    render(<MyCoffee />)
    const button = await screen.findByRole('button', { name: 'Drink 1' })
    expect(button).toBeDisabled()
    expect(screen.getByText(/Ask an admin to add a subscription/)).toBeInTheDocument()
    expect(drink).not.toHaveBeenCalled()
  })

  test('offers Undo after a drink, then puts the cup back', async () => {
    me.mockResolvedValue(withBalance(5))
    drink.mockResolvedValue({ opId: 'op1', batchLabel: 'September beans', remainingTotal: 4 })
    undo.mockResolvedValue({ remainingTotal: 5 })

    const user = userEvent.setup()
    render(<MyCoffee />)
    await user.click(await screen.findByRole('button', { name: 'Drink 1' }))

    const undoButton = await screen.findByRole('button', { name: 'Put it back' })
    await user.click(undoButton)

    await waitFor(() => expect(undo).toHaveBeenCalledWith('op1', expect.any(String)))
  })

  test('a server refusal is explained in the interface’s own words', async () => {
    me.mockResolvedValue(withBalance(2))
    drink.mockRejectedValue(new ApiError('NO_BALANCE', 'No drinks remaining', 409))

    const user = userEvent.setup()
    render(<MyCoffee />)
    await user.click(await screen.findByRole('button', { name: 'Drink 1' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('No cups left on any card.')
  })

  test('marks the card the next drink will come from', async () => {
    me.mockResolvedValue(withBalance(3))
    render(<MyCoffee />)
    expect(await screen.findByText('next')).toBeInTheDocument()
  })
})
