import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import axe from 'axe-core'

/**
 * axe-core has been a devDependency since the PWA pass and was imported
 * nowhere. The shell is a good place to start using it: a dock, a floating
 * action, a menu and a snackbar are exactly the shapes where roles and names
 * quietly go wrong.
 *
 * Colour contrast is excluded because jsdom does not lay out or paint, so the
 * rule cannot reach a real answer here — that one is checked against the
 * rendered page in the Playwright pass instead.
 */

const me = vi.fn()
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
      drink: vi.fn(),
      undo: vi.fn(),
      history: vi.fn().mockResolvedValue({ items: [] }),
      balances: vi.fn().mockResolvedValue({ balances: [] }),
      batches: vi.fn().mockResolvedValue({ batches: [] }),
    },
  }
})

const store = await import('../../src/state/coffee')
const { App } = await import('../../src/App')

const RULES = { rules: { 'color-contrast': { enabled: false } } }

const check = async (container: HTMLElement) => {
  const results = await axe.run(container, RULES)
  return results.violations.map((v) => `${v.id}: ${v.help}`)
}

beforeEach(() => {
  vi.clearAllMocks()
  store.resetCoffeeStore()
  localStorage.clear()
  localStorage.setItem('onboarding.coffee-sub.v1', 'finished')
  me.mockResolvedValue({
    member: { memberId: 'M1', displayName: 'Dewa Wijaya', role: 'admin' as const, isQa: false },
    totalRemaining: 3,
    allocations: [
      {
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
})
