import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import axe from 'axe-core'

/**
 * axe-core has been a devDependency since the PWA pass and was imported
 * nowhere. The shell is a good place to start using it: a dock, a floating
 * action, a menu and modal sheets are exactly the shapes where roles and names
 * quietly go wrong.
 *
 * Colour contrast is excluded because jsdom does not lay out or paint, so the
 * rule cannot reach a real answer here — that one is checked against the
 * rendered page in the Playwright pass instead.
 */

const me = vi.fn()
const drinkCall = vi.fn()
const undoCall = vi.fn()
const historyCall = vi.fn()
const balancesCall = vi.fn()
const authState = { user: { uid: 'u1' }, loading: false }
vi.mock('../../src/auth/useAuth', () => ({ useAuth: () => authState }))
vi.mock('../../src/auth/firebase', () => ({
  signInWithGoogle: vi.fn(),
  signOut: vi.fn(),
}))
vi.mock('../../src/api/client', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/api/client')>('../../src/api/client')
  return {
    ...actual,
    hasQaSession: () => false,
    api: {
      me: (...a: unknown[]) => me(...a),
      drink: (...a: unknown[]) => drinkCall(...a),
      undo: (...a: unknown[]) => undoCall(...a),
      history: (...a: unknown[]) => historyCall(...a),
      balances: (...a: unknown[]) => balancesCall(...a),
      batches: vi.fn().mockResolvedValue({ batches: [] }),
    },
  }
})

const store = await import('../../src/state/coffee')
const { resetHistoryStore } = await import('../../src/state/history')
const { App } = await import('../../src/App')

const RULES = { rules: { 'color-contrast': { enabled: false } } }

const check = async (container: HTMLElement) => {
  const results = await axe.run(container, RULES)
  return results.violations.map((v) => `${v.id}: ${v.help}`)
}

beforeEach(() => {
  vi.clearAllMocks()
  store.resetCoffeeStore()
  resetHistoryStore()
  balancesCall.mockResolvedValue({
    balances: [{ memberId: 'M2', displayName: 'Ayu', remaining: 2 }],
  })
  localStorage.clear()
  localStorage.setItem('onboarding.coffee-sub.v1', 'finished')
  me.mockResolvedValue({
    member: { memberId: 'M1', displayName: 'Dewa Wijaya', role: 'admin' as const, isQa: false },
    totalRemaining: 3,
    allocations: [
      {
        allocRowKey: 'A|SEPTEMBER',
        batchId: 'B1',
        batchLabel: 'September beans',
        granted: 5,
        consumed: 2,
        remaining: 3,
        effectiveAt: '2026-09-01T00:00:00.000Z',
      },
    ],
  })
})

afterEach(() => vi.restoreAllMocks())

describe('shell accessibility', () => {
  test('the signed-in shell has no violations', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    )
    await screen.findByRole('navigation', { name: /sections/i })
    expect(await check(container)).toEqual([])
  })

  test('the profile menu has no violations while it is open', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    )
    await user.click(await screen.findByRole('button', { name: /dewa wijaya/i }))
    await waitFor(() => expect(screen.getByRole('menu')).toBeInTheDocument())
    expect(await check(container)).toEqual([])
  })

  test('every interactive control in the shell carries an accessible name', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    )
    await screen.findByRole('navigation', { name: /sections/i })
    for (const el of document.querySelectorAll('button, a[href]')) {
      const name = (el.textContent ?? '').trim() || el.getAttribute('aria-label') || ''
      expect(name, `${el.tagName}.${el.className} needs a name`).not.toBe('')
    }
  })

  test('the summary in both states, the card Put Back and the Drink another? warning have no violations', async () => {
    // The sheets are portaled into document.body, outside the render container,
    // so the whole page is what gets scanned.
    const cup = (opId: string, remainingTotal: number) => ({
      opId, txnRowKey: `T-${opId}`, allocRowKey: 'A|SEPTEMBER', batchId: 'B1',
      batchLabel: 'September beans', remainingTotal, replayed: false,
      createdAt: new Date().toISOString(),
      undoExpiresAt: new Date(Date.now() + 90_000).toISOString(),
    })
    drinkCall.mockResolvedValueOnce(cup('op1', 2)).mockResolvedValueOnce(cup('op2', 1))
    undoCall.mockResolvedValue({ remainingTotal: 2 })
    // The page holds the first cup, so the summary's figures render too.
    historyCall.mockResolvedValue({
      items: [
        { opId: 'op1', type: 'CONSUME', delta: -1, batchLabel: 'September beans', createdAt: new Date().toISOString(), reversed: false },
      ],
    })
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    )

    await user.click(await screen.findByRole('button', { name: 'Drink' }))
    const summary = await screen.findByRole('dialog', { name: 'Drink 1' })
    await within(summary).findByText(/cups? today/)
    await waitFor(() =>
      expect(within(summary).getByRole('link', { name: 'Share to WhatsApp' })).toHaveAccessibleDescription(
        /Includes team balances/,
      ),
    )
    expect(screen.getByRole('button', { name: 'Put back cup from September beans' })).toBeInTheDocument()
    expect(await check(document.body)).toEqual([])

    await user.click(within(summary).getByRole('button', { name: 'Done' }))
    await user.click(screen.getByRole('button', { name: 'Drink' }))
    expect(await screen.findByRole('alertdialog', { name: 'Drink another?' })).toBeInTheDocument()
    expect(await check(document.body)).toEqual([])

    await user.click(screen.getByRole('button', { name: 'Drink another' }))
    const second = await screen.findByRole('dialog', { name: 'Drink 1' })
    await user.click(within(second).getByRole('button', { name: 'Put back this cup' }))
    expect(await within(second).findByRole('heading', { name: 'Cup put back' })).toHaveFocus()
    expect(await check(document.body)).toEqual([])
    expect(drinkCall).toHaveBeenCalledTimes(2)
    expect(undoCall).toHaveBeenCalledTimes(1)
    // Three whole-page axe scans take 3-5s alone and more under a full parallel
    // run, which tripped the 5s default; the budget is for axe, not the app.
  }, 20_000)
})
