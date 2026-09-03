import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const me = vi.fn()
const drinkCall = vi.fn()
const undoCall = vi.fn()

vi.mock('../../src/api/client', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/api/client')>('../../src/api/client')
  return {
    ...actual,
    api: {
      me: (...a: unknown[]) => me(...a),
      drink: (...a: unknown[]) => drinkCall(...a),
      undo: (...a: unknown[]) => undoCall(...a),
    },
  }
})

const store = await import('../../src/state/coffee')
const { DrinkFab } = await import('../../src/shell/DrinkFab')
const { UndoSnackbar } = await import('../../src/shell/UndoSnackbar')
const { ApiError } = await import('../../src/api/client')

const balance = (totalRemaining: number) => ({
  member: { memberId: 'M1', displayName: 'Dewa', role: 'member' as const, isQa: false },
  totalRemaining,
  allocations: [],
})

const mount = () =>
  render(
    <>
      <UndoSnackbar />
      <DrinkFab />
    </>,
  )

beforeEach(() => {
  vi.clearAllMocks()
  store.resetCoffeeStore()
  me.mockResolvedValue(balance(5))
})
afterEach(() => vi.useRealTimers())

describe('the Drink action', () => {
  test('always shows its label — never an icon on its own', async () => {
    await act(async () => void (await store.loadMe()))
    mount()
    expect(screen.getByRole('button', { name: 'Drink' })).toBeVisible()
    expect(screen.getByText('Drink')).toBeVisible()
  })

  test('is disabled until the balance has loaded', () => {
    mount()
    const fab = screen.getByRole('button', { name: 'Drink' })
    expect(fab).toBeDisabled()
    expect(screen.getByText('Loading your balance.')).toBeInTheDocument()
  })

  test('is enabled once there are cups', async () => {
    await act(async () => void (await store.loadMe()))
    mount()
    expect(screen.getByRole('button', { name: 'Drink' })).toBeEnabled()
  })

  test('a double tap sends exactly one request', async () => {
    let release: (v: unknown) => void = () => {}
    drinkCall.mockImplementation(() => new Promise((res) => (release = res)))
    await act(async () => void (await store.loadMe()))
    const user = userEvent.setup()
    mount()

    await user.click(screen.getByRole('button', { name: 'Drink' }))
    const working = await screen.findByRole('button', { name: 'Working…' })
    expect(working).toBeDisabled()
    expect(working).toHaveAttribute('aria-busy', 'true')
    await user.click(working)
    expect(drinkCall).toHaveBeenCalledTimes(1)

    await act(async () => {
      release({ opId: 'op1', batchLabel: 'B', remainingTotal: 4 })
    })
  })

  test('zero balance disables it and says why', async () => {
    me.mockResolvedValue(balance(0))
    await act(async () => void (await store.loadMe()))
    mount()
    expect(screen.getByRole('button', { name: 'Drink' })).toBeDisabled()
    expect(screen.getByText('You have no cups remaining.')).toBeInTheDocument()
  })

  test('offline disables it rather than letting the tap fail after the fact', async () => {
    // README claimed this behaviour; the button never actually checked.
    await act(async () => void (await store.loadMe()))
    mount()
    act(() => void window.dispatchEvent(new Event('offline')))

    expect(screen.getByRole('button', { name: 'Drink' })).toBeDisabled()
    expect(screen.getByText("You're offline. Cups can't be counted right now.")).toBeInTheDocument()
    act(() => void window.dispatchEvent(new Event('online')))
  })

  test('a server refusal is explained in the interface’s own words', async () => {
    drinkCall.mockRejectedValue(new ApiError('NO_BALANCE', 'none', 409))
    await act(async () => void (await store.loadMe()))
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByRole('button', { name: 'Drink' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('No cups left on any card.')
  })
})

describe('the undo snackbar', () => {
  test('offers the undo wherever you happen to be, naming the card', async () => {
    drinkCall.mockResolvedValue({ opId: 'op1', batchLabel: 'September beans', remainingTotal: 4 })
    await act(async () => void (await store.loadMe()))
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByRole('button', { name: 'Drink' }))

    const bar = await screen.findByRole('status')
    expect(bar).toHaveTextContent('One cup from September beans.')
    expect(bar).toHaveAttribute('aria-live', 'polite')
  })

  test('puts the cup back', async () => {
    drinkCall.mockResolvedValue({ opId: 'op1', batchLabel: 'B', remainingTotal: 4 })
    undoCall.mockResolvedValue({ remainingTotal: 5 })
    await act(async () => void (await store.loadMe()))
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByRole('button', { name: 'Drink' }))
    await user.click(await screen.findByRole('button', { name: 'Put it back' }))

    await waitFor(() => expect(undoCall).toHaveBeenCalledWith('op1', expect.any(String)))
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
  })

  test('is absent until a cup is actually taken', async () => {
    await act(async () => void (await store.loadMe()))
    mount()
    expect(screen.queryByRole('status')).toBeNull()
  })
})
