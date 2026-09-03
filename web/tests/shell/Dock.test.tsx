import { describe, test, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { Dock } = await import('../../src/shell/Dock')
const { DESTINATIONS, titleForPath } = await import('../../src/shell/routes')

const at = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Dock />
    </MemoryRouter>,
  )

describe('the dock', () => {
  test('offers exactly four destinations', () => {
    at('/')
    const nav = screen.getByRole('navigation', { name: /sections/i })
    expect(within(nav).getAllByRole('link')).toHaveLength(4)
  })

  test('every destination has a visible label, not just an icon', () => {
    at('/')
    for (const d of DESTINATIONS) {
      expect(screen.getByText(d.label)).toBeVisible()
    }
  })

  test('labels are short enough to survive a 320px viewport', () => {
    // Four columns of 80px at 320px; anything long wraps or truncates.
    for (const d of DESTINATIONS) {
      expect(d.label.length).toBeLessThanOrEqual(8)
    }
  })

  test('the current destination is marked for assistive tech, not by colour alone', () => {
    at('/history')
    const current = screen.getByRole('link', { current: 'page' })
    expect(current).toHaveTextContent('History')
    // The punched pill is the visual signal; `active` is what carries it.
    expect(current.className).toContain('active')
  })

  test('an admin gets no extra dock item — Manage lives in the profile menu', () => {
    // The dock takes no admin flag at all, which is the point: the old nav grew
    // to six items for admins and put Sign out among the destinations.
    at('/')
    const nav = screen.getByRole('navigation', { name: /sections/i })
    expect(within(nav).queryByText(/manage/i)).toBeNull()
    expect(within(nav).queryByText(/sign out/i)).toBeNull()
  })

  test('icons are decorative; the label carries the accessible name', () => {
    at('/')
    const nav = screen.getByRole('navigation', { name: /sections/i })
    for (const svg of nav.querySelectorAll('svg')) {
      expect(svg).toHaveAttribute('aria-hidden', 'true')
    }
    expect(screen.getByRole('link', { name: 'Mine' })).toBeInTheDocument()
  })

  test('routes are unchanged, so existing deep links still resolve', () => {
    expect(DESTINATIONS.map((d) => d.to)).toEqual([
      '/',
      '/everyone',
      '/subscriptions',
      '/history',
    ])
  })

  test('the header title matches the destination, including admin-only routes', () => {
    expect(titleForPath('/')).toBe('Mine')
    expect(titleForPath('/everyone')).toBe('Team')
    expect(titleForPath('/subscriptions')).toBe('Cards')
    expect(titleForPath('/history')).toBe('History')
    expect(titleForPath('/manage')).toBe('Manage')
  })
})
