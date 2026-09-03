/**
 * The icon set, inlined.
 *
 * `UpdatePrompt` set the house rule — "one icon does not justify a dependency"
 * — and eight do not change it: @heroicons/react unpacks to 3.7MB and
 * lucide-react to 31.7MB, both would need the registry workaround for the next
 * person running `npm ci`, and neither settles the question anyway because
 * Heroicons has no coffee cup. The most important glyph in this app has to be
 * drawn either way.
 *
 * One geometry throughout, copied from the existing arrow-path: a 24 viewBox,
 * 1.8 stroke, round caps and joins. The active variant fills the same closed
 * shapes rather than swapping in a different drawing, so the outline and solid
 * states are provably the same icon. Punched holes are painted in the active
 * pill's own colour, which is what makes them read as holes.
 */

interface IconProps {
  active?: boolean
  size?: number
}

const base = {
  'aria-hidden': true,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

/** The colour showing through a punched hole: the active pill behind the icon. */
const HOLE = 'var(--punch-soft)'

export function MineIcon({ active = false, size = 24 }: IconProps) {
  return (
    <svg {...base} width={size} height={size}>
      <rect
        x="2.9"
        y="6.4"
        width="18.2"
        height="11.2"
        rx="2.4"
        fill={active ? 'currentColor' : 'none'}
      />
      {[8, 12, 16].map((cx) => (
        <circle key={cx} cx={cx} cy="12" r="1.15" fill={active ? HOLE : 'currentColor'} stroke="none" />
      ))}
    </svg>
  )
}

export function TeamIcon({ active = false, size = 24 }: IconProps) {
  const fill = active ? 'currentColor' : 'none'
  return (
    <svg {...base} width={size} height={size}>
      <circle cx="9.25" cy="8.4" r="3.1" fill={fill} />
      <path d="M3.6 19.1a5.65 5.65 0 0 1 11.3 0" fill={fill} />
      <circle cx="17.1" cy="9.1" r="2.35" fill={fill} />
      <path d="M16.1 14.2a4.9 4.9 0 0 1 4.3 4.9" fill="none" />
    </svg>
  )
}

export function CardsIcon({ active = false, size = 24 }: IconProps) {
  const fill = active ? 'currentColor' : 'none'
  return (
    <svg {...base} width={size} height={size}>
      <path d="M7 9.4V7.7a2 2 0 0 1 2-2h9.3a2 2 0 0 1 2 2v6.6" fill={fill} />
      <rect x="3.1" y="9.4" width="14.6" height="8.9" rx="2" fill={fill} />
      {/* The tear line: a ticket, not a credit card. */}
      <path d="M13.2 10.3v7.1" strokeDasharray="1.7 1.7" stroke={active ? HOLE : 'currentColor'} />
    </svg>
  )
}

export function HistoryIcon({ active = false, size = 24 }: IconProps) {
  return (
    <svg {...base} width={size} height={size}>
      <circle cx="12" cy="12" r="8.3" fill={active ? 'currentColor' : 'none'} />
      <path d="M12 7.4V12l3.1 1.9" stroke={active ? HOLE : 'currentColor'} />
    </svg>
  )
}

/** The one icon Heroicons could not supply. Always solid — it is a filled button. */
export function CoffeeCupIcon({ size = 22 }: IconProps) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M4.9 9.6h11.2v3.9a5.6 5.6 0 0 1-11.2 0V9.6Z" />
      <path d="M16.1 10.8h1.6a2.4 2.4 0 0 1 0 4.8h-1.6" />
      <path d="M3.6 20.2h13.8" />
      <path d="M8 3.4c-.75.95-.75 1.95 0 2.9M11.6 3.4c-.75.95-.75 1.95 0 2.9" />
    </svg>
  )
}

export function ManageIcon({ size = 18 }: IconProps) {
  return (
    <svg {...base} width={size} height={size}>
      <rect x="2.9" y="4.9" width="18.2" height="14.2" rx="2.4" />
      <circle cx="8.6" cy="10.9" r="2.2" />
      <path d="M5.2 16.3a4 4 0 0 1 6.8 0" />
      <path d="M14.9 9.9h3.6M14.9 13.4h3.6" />
    </svg>
  )
}

export function HelpIcon({ size = 18 }: IconProps) {
  return (
    <svg {...base} width={size} height={size}>
      <circle cx="12" cy="12" r="8.3" />
      <path d="M9.7 9.7a2.45 2.45 0 0 1 4.7.9c0 1.7-2.35 2-2.35 3.5" />
      <circle cx="12" cy="17.1" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function SignOutIcon({ size = 18 }: IconProps) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M13.9 8.2V6.6a2 2 0 0 0-2-2H6.6a2 2 0 0 0-2 2v10.8a2 2 0 0 0 2 2h5.3a2 2 0 0 0 2-2v-1.6" />
      <path d="M10.6 12h9.6" />
      <path d="m17.5 9.2 2.8 2.8-2.8 2.8" />
    </svg>
  )
}
