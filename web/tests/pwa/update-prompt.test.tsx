import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/**
 * The prompt renders with no auth context whatsoever.
 *
 * No provider, no router, no signed-in user, no API client — because the state
 * it exists to serve is precisely the one where none of those work.
 */

const state = {
  needsRefresh: false,
  offlineReady: false,
  updatedElsewhere: false,
  blockedByMutation: false,
  update: vi.fn(),
}

vi.mock('../../src/pwa/useServiceWorker', () => ({
  useServiceWorker: () => state,
}))

const { UpdatePrompt } = await import('../../src/components/UpdatePrompt')

beforeEach(() => {
  state.needsRefresh = false
  state.updatedElsewhere = false
  state.blockedByMutation = false
  state.update = vi.fn()
})

describe('UpdatePrompt', () => {
  test('renders nothing when no update is waiting', () => {
    const { container } = render(<UpdatePrompt />)
    expect(container).toBeEmptyDOMElement()
  })

  test('appears with no auth context at all when an update is waiting', () => {
    state.needsRefresh = true
    render(<UpdatePrompt />)
    expect(screen.getByText('A new version is ready')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument()
  })

  test('is announced politely rather than stealing focus', () => {
    state.needsRefresh = true
    render(<UpdatePrompt />)
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-live', 'polite')
  })

  test('activating asks the worker to take over', async () => {
    state.needsRefresh = true
    const user = userEvent.setup()
    render(<UpdatePrompt />)
    await user.click(screen.getByRole('button', { name: /reload/i }))
    expect(state.update).toHaveBeenCalledTimes(1)
  })

  test('defers, and says so, while a drink is in flight', () => {
    state.needsRefresh = true
    state.blockedByMutation = true
    render(<UpdatePrompt />)
    expect(screen.getByText('Updating after your last tap…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /waiting/i })).toBeDisabled()
  })

  test('offers its own reload when another tab took the update', () => {
    state.updatedElsewhere = true
    render(<UpdatePrompt />)
    expect(screen.getByText('Updated in another tab')).toBeInTheDocument()
  })

  test('can be dismissed, and stays dismissed', async () => {
    state.needsRefresh = true
    const user = userEvent.setup()
    const { container } = render(<UpdatePrompt />)
    await user.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(container).toBeEmptyDOMElement()
  })

  test('the icon is decorative, so the label carries the meaning', () => {
    state.needsRefresh = true
    const { container } = render(<UpdatePrompt />)
    const svg = container.querySelector('svg')
    expect(svg).toHaveAttribute('aria-hidden', 'true')
  })
})

/**
 * The prompt and the shell share a bottom edge but may not share an import:
 * update-reachability.test.ts forbids App.tsx from knowing this component
 * exists. They coordinate through a custom property instead — one way, from
 * here outward — so the floating Drink action rides above the prompt rather
 * than being covered by it.
 */
describe('UpdatePrompt layout channel', () => {
  const measured = (height: number) =>
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get: () => height,
    })

  beforeEach(() => {
    document.documentElement.style.removeProperty('--update-h')
  })

  test('publishes its height while it is showing', () => {
    measured(56)
    state.needsRefresh = true
    render(<UpdatePrompt />)
    expect(document.documentElement.style.getPropertyValue('--update-h')).toBe('56px')
  })

  test('takes the space back when it is dismissed', async () => {
    measured(56)
    state.needsRefresh = true
    const user = userEvent.setup()
    render(<UpdatePrompt />)
    await user.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(document.documentElement.style.getPropertyValue('--update-h')).toBe('')
  })

  test('claims no space when nothing is waiting', () => {
    render(<UpdatePrompt />)
    expect(document.documentElement.style.getPropertyValue('--update-h')).toBe('')
  })
})
