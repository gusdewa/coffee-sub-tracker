import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

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
const { ApiError } = await import('../../src/api/client')

const balance = (totalRemaining: number) => ({
  member: { memberId: 'M1', displayName: 'Dewa', role: 'member' as const, isQa: false },
  totalRemaining,
  allocations: [],
})

/** The action on its own: anything a Drink does beyond the store shows up here. */
const mount = () => render(<DrinkFab />)
/** The action with the summary it opens, as the shell mounts them. */
const mountWithSummary = () =>
  render(
    <>
      <DrinkFab />
      <DrinkSummarySheet />
    </>,
  )

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(window, 'open').mockReturnValue(null)
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  store.resetCoffeeStore()
  resetHistoryStore()
  me.mockResolvedValue(balance(5))
  historyCall.mockResolvedValue({ items: [] })
  balancesCall.mockResolvedValue({
    balances: [
      { memberId: 'M1', displayName: 'Dewa', remaining: 4 },
      { memberId: 'M2', displayName: 'Ayu', remaining: 2 },
    ],
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the Drink action', () => {
  const successfulDrink = {
    opId: 'op1',
    allocRowKey: 'A|SEPTEMBER',
    batchLabel: 'September beans',
    remainingTotal: 4,
    // 09:12 in Jakarta.
    createdAt: '2026-09-25T02:12:00.000Z',
    undoExpiresAt: '2099-09-04T10:01:30.000Z',
  }

  test('Drink never calls window.open, clicks an anchor, or fetches balances', async () => {
    drinkCall.mockResolvedValue(successfulDrink)
    await act(async () => void (await store.loadMe()))
    const user = userEvent.setup()
    mount()

    await user.click(screen.getByRole('button', { name: 'Drink' }))
    await waitFor(() => expect(store.getCoffeeState().receipt?.opId).toBe('op1'))
    // Past the moment the old handoff would have fired.
    await waitFor(() => expect(me).toHaveBeenCalledTimes(2))

    expect(drinkCall).toHaveBeenCalledTimes(1)
    expect(window.open).not.toHaveBeenCalled()
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
    // Team balances are the summary's business, fetched only once it is open.
    expect(balancesCall).not.toHaveBeenCalled()
  })

  test('success opens Drink 1 with focus on it', async () => {
    drinkCall.mockResolvedValue(successfulDrink)
    await act(async () => void (await store.loadMe()))
    const user = userEvent.setup()
    mountWithSummary()

    await user.click(screen.getByRole('button', { name: 'Drink' }))

    const summary = await screen.findByRole('dialog', { name: 'Drink 1' })
    expect(summary).toHaveAttribute('open')
    expect(screen.getByRole('heading', { name: 'Drink 1' })).toHaveFocus()
    expect(drinkCall).toHaveBeenCalledTimes(1)
    expect(window.open).not.toHaveBeenCalled()
  })

  test('warns with the time and card of the cup already counted, and makes no key until confirmed', async () => {
    // Date only, so user-event and waitFor keep their real timers.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-25T03:00:00.000Z'))
    drinkCall
      .mockResolvedValueOnce(successfulDrink)
      .mockResolvedValueOnce({ ...successfulDrink, opId: 'op2', remainingTotal: 3 })
    await act(async () => void (await store.loadMe()))
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByRole('button', { name: 'Drink' }))
    await waitFor(() => expect(store.getCoffeeState().undo?.opId).toBe('op1'))
    const uuid = vi.spyOn(crypto, 'randomUUID')

    await user.click(screen.getByRole('button', { name: 'Drink' }))
    const warning = screen.getByRole('alertdialog', { name: 'Drink another?' })
    // "You just counted a drink" stayed on screen all day; the time says which cup.
    expect(warning).toHaveAccessibleDescription(
      'You counted a cup at 09:12 from September beans. Count one more?',
    )
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    expect(drinkCall).toHaveBeenCalledTimes(1)
    expect(uuid).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(uuid).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Drink' }))
    await user.dblClick(screen.getByRole('button', { name: 'Drink another' }))
    await waitFor(() => expect(drinkCall).toHaveBeenCalledTimes(2))
    expect(uuid).toHaveBeenCalledTimes(1)
    expect(window.open).not.toHaveBeenCalled()
  })

  test.each([
    ['no time', { createdAt: 'not a time' }, 'You already counted a cup today. Count one more?'],
    ['no card', { batchLabel: '' }, 'You counted a cup at 09:12. Count one more?'],
  ])('the warning still reads truthfully with %s', async (_label, overrides, copy) => {
    drinkCall.mockResolvedValue({ ...successfulDrink, ...overrides })
    await act(async () => void (await store.loadMe()))
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByRole('button', { name: 'Drink' }))
    await waitFor(() => expect(store.getCoffeeState().undo?.opId).toBe('op1'))

    await user.click(screen.getByRole('button', { name: 'Drink' }))

    expect(screen.getByRole('alertdialog', { name: 'Drink another?' })).toHaveAccessibleDescription(copy)
  })

  test('Cancel and Escape return focus to Drink', async () => {
    drinkCall.mockResolvedValue(successfulDrink)
    await act(async () => void (await store.loadMe()))
    const user = userEvent.setup()
    mount()
    const fab = screen.getByRole('button', { name: 'Drink' })
    await user.click(fab)
    await waitFor(() => expect(store.getCoffeeState().undo?.opId).toBe('op1'))

    await user.click(fab)
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(fab).toHaveFocus()

    await user.click(fab)
    expect(screen.getByRole('alertdialog', { name: 'Drink another?' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(fab).toHaveFocus()

    expect(drinkCall).toHaveBeenCalledTimes(1)
  })

  test('a failure opens nothing and fetches nothing', async () => {
    drinkCall.mockRejectedValue(new ApiError('NO_BALANCE', 'none', 409))
    await act(async () => void (await store.loadMe()))
    const user = userEvent.setup()
    mountWithSummary()

    await user.click(screen.getByRole('button', { name: 'Drink' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('No cups left on any card.')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(window.open).not.toHaveBeenCalled()
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
    expect(balancesCall).not.toHaveBeenCalled()
    expect(historyCall).not.toHaveBeenCalled()
  })

  test('after 8 seconds of counting, an always-present status says not to tap again', async () => {
    let release: (value: unknown) => void = () => {}
    drinkCall.mockImplementation(() => new Promise((resolve) => (release = resolve)))
    await act(async () => void (await store.loadMe()))
    mount()
    // Present and empty before anything happens, so the words are announced
    // when they arrive rather than the region itself.
    const status = screen.getByRole('status')
    expect(status).toBeEmptyDOMElement()

    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Drink' }))
    await act(async () => void (await vi.advanceTimersByTimeAsync(7_999)))
    expect(status).toBeEmptyDOMElement()
    await act(async () => void (await vi.advanceTimersByTimeAsync(1)))
    expect(status).toHaveTextContent('Still counting — no need to tap again.')
    expect(screen.getByRole('button', { name: 'Working…' })).toBeInTheDocument()
    expect(drinkCall).toHaveBeenCalledTimes(1)

    await act(async () => release(successfulDrink))
    expect(screen.getByRole('status')).toBe(status)
    expect(status).toBeEmptyDOMElement()
  })

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
    expect(working).toBeEnabled()
    expect(working).toHaveAttribute('aria-disabled', 'true')
    expect(working).toHaveAttribute('aria-busy', 'true')
    await user.click(working)
    expect(drinkCall).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert')).toHaveTextContent('Drink is already being counted.')

    await act(async () => release(successfulDrink))
    await waitFor(() => expect(store.getCoffeeState().receipt?.opId).toBe('op1'))
    expect(drinkCall).toHaveBeenCalledTimes(1)
    expect(window.open).not.toHaveBeenCalled()
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

  test('retrying a background balance error refreshes instead of drinking', async () => {
    await act(async () => void (await store.loadMe()))
    me.mockRejectedValueOnce(new Error('refresh failed'))
    await act(async () => void (await store.loadMe()))
    me.mockResolvedValue(balance(5))
    const user = userEvent.setup()
    mount()

    await user.click(screen.getByRole('button', { name: 'Try again' }))

    await waitFor(() => expect(me).toHaveBeenCalledTimes(3))
    expect(drinkCall).not.toHaveBeenCalled()
    expect(window.open).not.toHaveBeenCalled()
  })
})

describe('the summary it opens', () => {
  test('is absent until a cup is actually taken', async () => {
    await act(async () => void (await store.loadMe()))
    mountWithSummary()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    expect(historyCall).not.toHaveBeenCalled()
    expect(balancesCall).not.toHaveBeenCalled()
  })
})
