import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

const { ProfileMenu } = await import('../../src/shell/ProfileMenu')

const onSignOut = vi.fn()
const onReplayTour = vi.fn()

const show = (isAdmin = false) =>
  render(
    <MemoryRouter>
      <ProfileMenu
        displayName="Dewa Wijaya"
        isAdmin={isAdmin}
        onSignOut={onSignOut}
        onReplayTour={onReplayTour}
      />
    </MemoryRouter>,
  )

beforeEach(() => vi.clearAllMocks())

describe('the profile menu', () => {
  test('the trigger shows initials and says it opens a menu', () => {
    show()
    const trigger = screen.getByRole('button', { name: /dewa wijaya/i })
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveTextContent('DW')
  })

  test('opening moves focus to the first item', async () => {
    const user = userEvent.setup()
    show()
    await user.click(screen.getByRole('button', { name: /dewa wijaya/i }))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.getAllByRole('menuitem')[0]).toHaveFocus()
  })

  test('Escape closes it and gives focus back to the trigger', async () => {
    const user = userEvent.setup()
    show()
    const trigger = screen.getByRole('button', { name: /dewa wijaya/i })
    await user.click(trigger)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger).toHaveFocus()
  })

  test('arrow keys move between items', async () => {
    const user = userEvent.setup()
    show(true)
    await user.click(screen.getByRole('button', { name: /dewa wijaya/i }))
    const items = screen.getAllByRole('menuitem')
    await user.keyboard('{ArrowDown}')
    expect(items[1]).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(items[0]).toHaveFocus()
  })

  test('sign out is present, last, and separated from the rest', async () => {
    const user = userEvent.setup()
    show()
    await user.click(screen.getByRole('button', { name: /dewa wijaya/i }))
    const items = screen.getAllByRole('menuitem')
    const signOut = items[items.length - 1]!
    expect(signOut).toHaveTextContent('Sign out')
    // Terminal actions do not sit in the same rhythm as navigation.
    expect(signOut.className).toContain('profile__item--danger')
    await user.click(signOut)
    expect(onSignOut).toHaveBeenCalledTimes(1)
  })

  test('Manage members appears only for an admin', async () => {
    const user = userEvent.setup()
    const { unmount } = show(false)
    await user.click(screen.getByRole('button', { name: /dewa wijaya/i }))
    expect(screen.queryByRole('menuitem', { name: /manage members/i })).toBeNull()
    expect(screen.getByText('Member')).toBeInTheDocument()
    unmount()

    show(true)
    await user.click(screen.getByRole('button', { name: /dewa wijaya/i }))
    expect(screen.getByRole('menuitem', { name: /manage members/i })).toBeInTheDocument()
    expect(screen.getByText('Admin')).toBeInTheDocument()
  })

  test('the tour can be replayed from the menu', async () => {
    const user = userEvent.setup()
    show()
    await user.click(screen.getByRole('button', { name: /dewa wijaya/i }))
    await user.click(screen.getByRole('menuitem', { name: /show me around/i }))
    expect(onReplayTour).toHaveBeenCalledTimes(1)
    // The menu gets out of the way before the spotlight opens over it.
    expect(screen.queryByRole('menu')).toBeNull()
  })

  test('a tap outside closes the menu', async () => {
    const user = userEvent.setup()
    show()
    await user.click(screen.getByRole('button', { name: /dewa wijaya/i }))
    await user.click(screen.getByTestId('profile-scrim'))
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
