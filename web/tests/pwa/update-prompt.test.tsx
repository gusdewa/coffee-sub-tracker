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
