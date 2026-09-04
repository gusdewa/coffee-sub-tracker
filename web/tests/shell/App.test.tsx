import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

const me = vi.fn()
const drinkCall = vi.fn()
const historyCall = vi.fn()
const signOutCall = vi.fn()
const setQaSessionCall = vi.fn()

// A stable reference, as the real hook returns: it holds state across renders.
const authState = { user: { uid: 'u1' }, loading: false }
vi.mock('../../src/auth/useAuth', () => ({ useAuth: () => authState }))

vi.mock('../../src/auth/firebase', () => ({
  signInWithGoogle: vi.fn(),
  signOut: (...a: unknown[]) => signOutCall(...a),
}))

vi.mock('../../src/api/client', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/api/client')>('../../src/api/client')
  return {
    ...actual,
    hasQaSession: () => false,
    setQaSession: (...a: unknown[]) => setQaSessionCall(...a),
    api: {
      me: (...a: unknown[]) => me(...a),
      drink: (...a: unknown[]) => drinkCall(...a),
      undo: vi.fn(),
      history: (...a: unknown[]) => historyCall(...a),
      balances: vi.fn().mockResolvedValue({ balances: [] }),
      batches: vi.fn().mockResolvedValue({ batches: [] }),
    },
  }
})

const store = await import('../../src/state/coffee')
const { App } = await import('../../src/App')

const member = (role: 'member' | 'admin', totalRemaining = 5) => ({
  member: { memberId: 'M1', displayName: 'Dewa Wijaya', role, isQa: false },
  totalRemaining,
  allocations: [
    {
      batchId: 'B1',
      batchLabel: 'September beans',
      granted: 5,
      consumed: 5 - totalRemaining,
      remaining: totalRemaining,
      effectiveAt: '2026-09-01T00:00:00.000Z',
    },
  ],
})

const at = (path = '/') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  )

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(window, 'open').mockReturnValue(null)
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  store.resetCoffeeStore()
  localStorage.clear()
  // Finished, so the walkthrough does not open over these assertions.
  localStorage.setItem('onboarding.coffee-sub.v1', 'finished')
  me.mockResolvedValue(member('member'))
  historyCall.mockResolvedValue({ items: [] })
})

afterEach(() => vi.useRealTimers())

describe('the signed-in shell', () => {
  test('polls visible authenticated sessions every 60 seconds and cleans the timer up', async () => {
    vi.useFakeTimers()
    let visibility: DocumentVisibilityState = 'visible'
    const visibilitySpy = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockImplementation(() => visibility)
    const view = at()
    await act(async () => {})
    expect(me).toHaveBeenCalledTimes(1)

    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(me).toHaveBeenCalledTimes(2)

    visibility = 'hidden'
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(me).toHaveBeenCalledTimes(2)

    view.unmount()
    visibility = 'visible'
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(me).toHaveBeenCalledTimes(2)
    visibilitySpy.mockRestore()
    vi.useRealTimers()
  })

  test.each([
    ['becomes visible', () => document.dispatchEvent(new Event('visibilitychange'))],
    ['comes online', () => window.dispatchEvent(new Event('online'))],
  ])('refreshes a stale zero balance when the app %s', async (_label, resume) => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    me.mockResolvedValue(member('member', 0))
    const view = at()
    const fab = await screen.findByRole('button', { name: 'Drink' })
    expect(fab).toBeDisabled()

    me.mockResolvedValue(member('member', 3))
    resume()

    await waitFor(() => expect(fab).toBeEnabled())
    expect(me).toHaveBeenCalledTimes(2)
    view.unmount()
    visibility.mockRestore()
  })

  test('a member and an admin see the same four destinations', async () => {
    at()
    const nav = await screen.findByRole('navigation', { name: /sections/i })
    expect(within(nav).getAllByRole('link')).toHaveLength(4)

    store.resetCoffeeStore()
    me.mockResolvedValue(member('admin'))
    const admin = at()
    await waitFor(() => expect(admin.container.querySelector('.dock')).not.toBeNull())
    const adminNav = admin.container.querySelector('.dock')!
    expect(adminNav.querySelectorAll('a')).toHaveLength(4)
  })

  test('sign out is not in the dock at all', async () => {
    at()
    const nav = await screen.findByRole('navigation', { name: /sections/i })
    expect(within(nav).queryByText(/sign out/i)).toBeNull()
  })

  test('Manage is behind the profile menu for an admin, and absent for a member', async () => {
    me.mockResolvedValue(member('admin'))
    const user = userEvent.setup()
    at()
    await user.click(await screen.findByRole('button', { name: /dewa wijaya/i }))
    expect(screen.getByRole('menuitem', { name: /manage members/i })).toBeInTheDocument()
  })

  test('signing out clears the QA session as well as Firebase', async () => {
    const user = userEvent.setup()
    at()
    await user.click(await screen.findByRole('button', { name: /dewa wijaya/i }))
    await user.click(screen.getByRole('menuitem', { name: /sign out/i }))

    expect(signOutCall).toHaveBeenCalledTimes(1)
    // A QA bearer used to outlive "Sign out" entirely.
    expect(setQaSessionCall).toHaveBeenCalledWith(null)
  })

  test('the header names the screen you are on', async () => {
    at('/history')
    expect(await screen.findByRole('heading', { name: 'History' })).toBeInTheDocument()
  })

  test('a cup taken from History reloads History', async () => {
    drinkCall.mockResolvedValue({ opId: 'op1', batchLabel: 'September beans', remainingTotal: 4 })
    const user = userEvent.setup()
    at('/history')

    await waitFor(() => expect(historyCall).toHaveBeenCalledTimes(1))
    const fab = await screen.findByRole('button', { name: 'Drink' })
    await waitFor(() => expect(fab).toBeEnabled())
    await user.click(fab)

    // Without the revision subscription this screen keeps showing a ledger the
    // FAB has already added to.
    await waitFor(() => expect(historyCall).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('status')).toHaveTextContent('Drink 1')
  })

  test('the Drink action is reachable from every destination', async () => {
    for (const path of ['/', '/everyone', '/subscriptions', '/history']) {
      store.resetCoffeeStore()
      const view = at(path)
      expect(await screen.findByRole('button', { name: 'Drink' })).toBeInTheDocument()
      view.unmount()
    }
  })
})
