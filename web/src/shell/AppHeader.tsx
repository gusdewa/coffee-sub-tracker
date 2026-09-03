import { useLocation } from 'react-router-dom'
import { ProfileMenu } from './ProfileMenu'
import { titleForPath } from './routes'

/**
 * The app bar the shell never had.
 *
 * Without one there was nowhere to put identity, so the signed-in member's name
 * appeared only as a greeting on one screen, and there was no home for anything
 * that is not a destination. Four screens each rendered their own <h2> title;
 * those move here, which also means the title and the dock label can no longer
 * drift apart.
 */
export function AppHeader({
  displayName,
  isAdmin,
  onSignOut,
  onReplayTour,
}: {
  /** Absent until the balance lands; the menu waits rather than showing "?". */
  displayName: string | undefined
  isAdmin: boolean
  onSignOut: () => void
  onReplayTour: () => void
}) {
  const { pathname } = useLocation()

  return (
    <header className="app-header">
      <div className="app-header__inner">
        <h1 className="app-header__title">{titleForPath(pathname)}</h1>
        {displayName && (
          <ProfileMenu
            displayName={displayName}
            isAdmin={isAdmin}
            onSignOut={onSignOut}
            onReplayTour={onReplayTour}
          />
        )}
      </div>
    </header>
  )
}
