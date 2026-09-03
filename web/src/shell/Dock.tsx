import { NavLink } from 'react-router-dom'
import { DESTINATIONS } from './routes'

/**
 * Four destinations, each an icon over a short label.
 *
 * The old active state was coloured text plus a 2px inset rule, which is close
 * to colour-only and reads as a generic web tab bar. Here the icon sits in a
 * punched pill that fills, the icon itself switches from outline to solid, the
 * label takes the accent, and NavLink contributes aria-current="page" — four
 * signals, only one of which is colour.
 */
export function Dock() {
  return (
    <nav className="dock" aria-label="Sections">
      {DESTINATIONS.map(({ to, label, Icon, end, tour }) => (
        <NavLink key={to} to={to} end={end} className="dock__link" data-tour={tour}>
          {({ isActive }) => (
            <>
              <span className="dock__pill">
                <Icon active={isActive} size={24} />
              </span>
              <span className="dock__label">{label}</span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  )
}
