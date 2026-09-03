import type { ComponentType } from 'react'
import { MineIcon, TeamIcon, CardsIcon, HistoryIcon } from '../components/icons'

/**
 * The four destinations, in dock order.
 *
 * Four, not six. The old nav put Manage and Sign out beside the destinations
 * and styled all of them identically, so an admin got six equal-weight text
 * links and the most destructive one sat among them. Manage and Sign out are
 * now in the profile menu, which is why nothing here takes an admin flag.
 *
 * Labels are also the screen titles. The nav used to say "Cards" while the
 * screen called itself "Subscriptions", and "Everyone" where the dock now says
 * "Team" — one name per concept, everywhere. The *routes* are untouched, so
 * existing deep links and bookmarks still resolve.
 */

export interface Destination {
  to: string
  label: string
  /** Stable hook for the onboarding tour; see onboarding/tour.ts. */
  tour: string
  Icon: ComponentType<{ active?: boolean; size?: number }>
  end?: boolean
}

export const DESTINATIONS: Destination[] = [
  { to: '/', label: 'Mine', tour: 'nav-mine', Icon: MineIcon, end: true },
  { to: '/everyone', label: 'Team', tour: 'nav-team', Icon: TeamIcon },
  { to: '/subscriptions', label: 'Cards', tour: 'nav-cards', Icon: CardsIcon },
  { to: '/history', label: 'History', tour: 'nav-history', Icon: HistoryIcon },
]

/** Routes that own a title but not a dock slot. */
const EXTRA_TITLES: Record<string, string> = {
  '/manage': 'Manage',
}

export function titleForPath(pathname: string): string {
  const extra = EXTRA_TITLES[pathname]
  if (extra) return extra
  const exact = DESTINATIONS.find((d) => d.to === pathname)
  if (exact) return exact.label
  const prefixed = DESTINATIONS.find((d) => d.to !== '/' && pathname.startsWith(d.to))
  // Anything unmatched falls through to My Coffee, exactly as the catch-all
  // route does, so the title never disagrees with what is on screen.
  return prefixed?.label ?? DESTINATIONS[0]!.label
}
