import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { ManageIcon, HelpIcon, SignOutIcon } from '../components/icons'

/**
 * Everything that is not a destination.
 *
 * Sign out used to be a primary navigation item — a <button> wearing a nav
 * link's classes, sitting fifth or sixth in a row of places you might go. It is
 * not a place, and it is the one control in the app you cannot undo, so it
 * lives here instead: last, separated by a rule, and coloured as the terminal
 * action it is.
 *
 * A menu, not a dialog: Tab moves on rather than being trapped, which is what
 * the pattern expects. Escape restores focus to the trigger.
 */

function initialsOf(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  const first = parts[0]![0]!
  const second = parts.length > 1 ? parts[parts.length - 1]![0]! : ''
  return (first + second).toUpperCase()
}

export function ProfileMenu({
  displayName,
  isAdmin,
  onSignOut,
  onReplayTour,
}: {
  displayName: string
  isAdmin: boolean
  onSignOut: () => void
  onReplayTour: () => void
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const { pathname } = useLocation()

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }, [])

  // Navigating away closes it; otherwise it would hang over the new screen.
  useEffect(() => {
    setOpen(false)
  }, [pathname])

  const items = useCallback(
    () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
    [],
  )

  useEffect(() => {
    if (open) items()[0]?.focus()
  }, [open, items])

  const onKeyDown = (event: React.KeyboardEvent) => {
    const all = items()
    const at = all.indexOf(document.activeElement as HTMLElement)
    if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      all[(at + 1) % all.length]?.focus()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      all[(at - 1 + all.length) % all.length]?.focus()
    } else if (event.key === 'Home') {
      event.preventDefault()
      all[0]?.focus()
    } else if (event.key === 'End') {
      event.preventDefault()
      all[all.length - 1]?.focus()
    }
  }

  return (
    <div className="profile">
      <button
        ref={triggerRef}
        type="button"
        className="profile__trigger"
        aria-label={displayName}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? 'profile-menu' : undefined}
        data-tour="profile"
        onClick={() => setOpen((was) => !was)}
      >
        <span aria-hidden="true">{initialsOf(displayName)}</span>
      </button>

      {open && (
        <>
          {/*
            A real element rather than a document listener, so an outside tap
            behaves identically under touch, mouse and test. Not focusable, so
            it adds no keyboard trap — Escape is the keyboard route out.
          */}
          <div
            className="profile__scrim"
            data-testid="profile-scrim"
            aria-hidden="true"
            onClick={() => close(false)}
          />
          <div
            ref={menuRef}
            id="profile-menu"
            className="profile__menu"
            role="menu"
            aria-label={displayName}
            onKeyDown={onKeyDown}
          >
            <div className="profile__identity">
              <span className="profile__name">{displayName}</span>
              <span className="profile__role">{isAdmin ? 'Admin' : 'Member'}</span>
            </div>

            {isAdmin && (
              <Link
                to="/manage"
                role="menuitem"
                className="profile__item"
                onClick={() => close(false)}
              >
                <ManageIcon />
                Manage members
              </Link>
            )}

            <button
              type="button"
              role="menuitem"
              className="profile__item"
              onClick={() => {
                // Out of the way first: the spotlight is about to open over here.
                close(false)
                onReplayTour()
              }}
            >
              <HelpIcon />
              Show me around
            </button>

            <button
              type="button"
              role="menuitem"
              className="profile__item profile__item--danger"
              onClick={() => {
                close(false)
                onSignOut()
              }}
            >
              <SignOutIcon />
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  )
}
