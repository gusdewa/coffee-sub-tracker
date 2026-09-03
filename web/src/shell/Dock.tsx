import { useEffect, useRef } from 'react'
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
  const bar = useRef<HTMLElement>(null)

  /*
   * Publish the dock's real height.
   *
   * The floating action and the update prompt sit on the dock's top edge, and
   * that edge moves: the safe area differs per device, and at 200% text the
   * labels wrap and the bar grows. Deriving it from the --dock-height token
   * alone would leave both of them overlapping the dock exactly when the text
   * is largest and overlap matters most.
   */
  useEffect(() => {
    const el = bar.current
    if (!el) return
    const root = document.documentElement
    const publish = () => root.style.setProperty('--dock-h', `${el.offsetHeight}px`)
    publish()
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish)
    observer?.observe(el)
    return () => {
      observer?.disconnect()
      root.style.removeProperty('--dock-h')
    }
  }, [])

  return (
    <nav ref={bar} className="dock" aria-label="Sections">
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
