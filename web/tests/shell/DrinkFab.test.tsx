import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const me = vi.fn()
const drinkCall = vi.fn()
const undoCall = vi.fn()
const balancesCall = vi.fn()

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
  vi.spyOn(window, 'open').mockReturnValue(null)
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  store.resetCoffeeStore()
  me.mockResolvedValue(balance(5))
  balancesCall.mockResolvedValue({
    balances: [
      { memberId: 'M1', displayName: 'Dewa', remaining: 4 },
      { memberId: 'M2', displayName: 'Ayu', remaining: 2 },
    ],
  })
})
afterEach(() => vi.useRealTimers())

describe('the Drink action', () => {
  const successfulDrink = {
    opId: 'op1',
    batchLabel: 'September beans',
    remainingTotal: 4,
  }

  /*
   * The handoff target is a secondary context reserved during the trusted
   * click, so the auto-jump after the async mutation cannot be popup-blocked
   * and the PWA document never navigates away from under the snackbar.
   */
  const reservedWindow = () => {
    const win = {
      opener: window,
      location: { assign: vi.fn() },
      close: vi.fn(),
    }
    vi.mocked(window.open).mockReturnValue(win as unknown as Window & typeof globalThis)
    return win
  }
  const jumpUrl = (win: { location: { assign: { mock: { calls: unknown[][] } } } }) =>
    String(win.location.assign.mock.calls.at(-1)?.[0] ?? '')

  const handoff = (): HTMLAnchorElement | undefined =>
    vi.mocked(HTMLAnchorElement.prototype.click).mock.instances.at(-1) as unknown as
      | HTMLAnchorElement
      | undefined
  const handoffUrl = () => handoff()?.href ?? ''

  test('reserves the handoff context inside the click and jumps it only after success', async () => {
    const win = reservedWindow()
    let release: (value: typeof successfulDrink) => void = () => {}
    drinkCall.mockImplementation(() => new Promise((resolve) => (release = resolve)))
    await act(async () => void (await store.loadMe()))
    mount()

    act(() => screen.getByRole('button', { name: 'Drink' }).click())

    // The reservation is synchronous with the trusted gesture; the mutation
    // has not even started, so nothing has navigated anywhere yet.
    expect(window.open).toHaveBeenCalledTimes(1)
    expect(window.open).toHaveBeenCalledWith('', 'coffee-sub-wa-handoff')
    expect(win.opener).toBeNull()
    expect(win.location.assign).not.toHaveBeenCalled()
    expect(win.close).not.toHaveBeenCalled()
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()

    await act(async () => release(successfulDrink))
    await waitFor(() => expect(balancesCall).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(win.location.assign).toHaveBeenCalledTimes(1))

    expect(win.close).not.toHaveBeenCalled()
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
    expect(jumpUrl(win)).toMatch(/^https:\/\/wa\.me\/\?text=/)
    const message = decodeURIComponent(jumpUrl(win).split('=')[1]!)
    expect(message.startsWith('Cart Coffee\n')).toBe(true)
    expect(message).toContain('Dewa drank 1 cup')
    expect(message).toContain('September beans')
    expect(message).toContain('Dewa: 4 cups')
    expect(message).toContain('Ayu: 2 cups')
    expect(message.indexOf('Dewa:')).toBeLessThan(message.indexOf('Ayu:'))
    expect(message).toContain('Total remaining: 6 cups')
  })

  test('jumps with a truthful self-only recap when balances fail', async () => {
    const win = reservedWindow()
    drinkCall.mockResolvedValue(successfulDrink)
    balancesCall.mockRejectedValue(new Error('balances unavailable'))
    await act(async () => void (await store.loadMe()))
    const user = userEvent.setup()
    mount()

    await user.click(screen.getByRole('button', { name: 'Drink' }))

    await waitFor(() => expect(win.location.assign).toHaveBeenCalledTimes(1))
    const message = decodeURIComponent(jumpUrl(win).split('=')[1]!)
    expect(message).toContain('Dewa drank 1 cup')
    expect(message).toContain('September beans')
    expect(message).toContain('Dewa: 4 cups')
    expect(message).not.toContain('Ayu')
    expect(message).toContain('Full balance list unavailable.')
    expect(message).not.toContain('Current balances:')
    expect(message).not.toContain('Total remaining:')
  })

  test('falls back to a same-context jump when the reservation is blocked', async () => {
    // beforeEach leaves window.open returning null, the blocked case.
    drinkCall.mockResolvedValue(successfulDrink)
    await act(async () => void (await store.loadMe()))
    const user = userEvent.setup()
    mount()

    await user.click(screen.getByRole('button', { name: 'Drink' }))

    await waitFor(() => expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1))
    const navigated = handoff()
    expect(navigated?.target).toBe('_self')
    expect(navigated?.href).toMatch(/^https:\/\/wa\.me\/\?text=/)
    const message = decodeURIComponent(handoffUrl().split('=')[1]!)
    expect(message).toContain('Dewa drank 1 cup')
    expect(drinkCall).toHaveBeenCalledTimes(1)
  })

  test('keeps an accessible WhatsApp fallback if every automatic route fails', async () => {
    drinkCall.mockResolvedValue(successfulDrink)
    vi.mocked(HTMLAnchorElement.prototype.click).mockImplementationOnce(() => {
      throw new Error('navigation unavailable')
    })
    await act(async () => void (await store.loadMe()))
    const user = userEvent.setup()
    mount()

    await user.click(screen.getByRole('button', { name: 'Drink' }))

    const fallback = await screen.findByRole('link', { name: 'Open WhatsApp' })
    expect(fallback).toHaveAttribute('href', expect.stringMatching(/^https:\/\/wa\.me\/\?text=/))
    const message = decodeURIComponent(fallback.getAttribute('href')!.split('=')[1]!)
    expect(message).toContain('Dewa drank 1 cup')
    expect(drinkCall).toHaveBeenCalledTimes(1)
  })

  test('closes the reserved context and fetches nothing when Drink fails', async () => {
    const win = reservedWindow()
    drinkCall.mockRejectedValue(new ApiError('NO_BALANCE', 'none', 409))
    await act(async () => void (await store.loadMe()))
    const user = userEvent.setup()
    mount()

    await user.click(screen.getByRole('button', { name: 'Drink' }))

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    await waitFor(() => expect(win.close).toHaveBeenCalledTimes(1))
    expect(win.location.assign).not.toHaveBeenCalled()
    expect(balancesCall).not.toHaveBeenCalled()
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
  })

  test('closes the reserved context instead of jumping when the cup is put back first', async () => {
    const win = reservedWindow()
    drinkCall.mockResolvedValue(successfulDrink)
    undoCall.mockResolvedValue({ remainingTotal: 5 })
    let releaseBalances: (value: unknown) => void = () => {}
    balancesCall.mockImplementation(() => new Promise((resolve) => (releaseBalances = resolve)))
    await act(async () => void (await store.loadMe()))
    const user = userEvent.setup()
    mount()

    await user.click(screen.getByRole('button', { name: 'Drink' }))
    await user.click(await screen.findByRole('button', { name: 'Put it back' }))
    await waitFor(() => expect(undoCall).toHaveBeenCalledTimes(1))
    await act(async () =>
      releaseBalances({ balances: [{ memberId: 'M1', displayName: 'Dewa', remaining: 4 }] }),
    )

    await waitFor(() => expect(win.close).toHaveBeenCalledTimes(1))
    expect(win.location.assign).not.toHaveBeenCalled()
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
    expect(screen.queryByRole('link', { name: 'Open WhatsApp' })).toBeNull()
    expect(drinkCall).toHaveBeenCalledTimes(1)
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

  test('a double tap sends exactly one request and reserves exactly one context', async () => {
    const win = reservedWindow()
    let release: (v: unknown) => void = () => {}
    drinkCall.mockImplementation(() => new Promise((res) => (release = res)))
    await act(async () => void (await store.loadMe()))
    const user = userEvent.setup()
    mount()

    await user.click(screen.getByRole('button', { name: 'Drink' }))
    const working = await screen.findByRole('button', { name: 'Working…' })
    expect(working).toBeDisabled()
    expect(working).toHaveAttribute('aria-busy', 'true')
    expect(window.open).toHaveBeenCalledTimes(1)
    await user.click(working)
    expect(drinkCall).toHaveBeenCalledTimes(1)

    await act(async () => {
      release({ opId: 'op1', batchLabel: 'B', remainingTotal: 4 })
    })
    await waitFor(() => expect(win.location.assign).toHaveBeenCalledTimes(1))
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

  test('automatically removes Put it back after 10 seconds', async () => {
    vi.useFakeTimers()
    drinkCall.mockResolvedValue({ opId: 'op1', batchLabel: 'B', remainingTotal: 4 })
    await act(async () => void (await store.loadMe()))
    mount()
    await act(async () => void store.drink())

    expect(screen.getByRole('button', { name: 'Put it back' })).toBeInTheDocument()
    await act(async () => vi.advanceTimersByTimeAsync(9_999))
    expect(screen.getByRole('button', { name: 'Put it back' })).toBeInTheDocument()
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(screen.queryByRole('button', { name: 'Put it back' })).toBeNull()
  })

  test('is absent until a cup is actually taken', async () => {
    await act(async () => void (await store.loadMe()))
    mount()
    expect(screen.queryByRole('status')).toBeNull()
  })
})
