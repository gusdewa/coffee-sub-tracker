import type { DayCount } from '../insights/recent'

/**
 * Seven small bars, one per Jakarta day, oldest first with today last.
 *
 * The drawing is decoration for sighted readers and is hidden from assistive
 * tech; the same figures are read out once, as a sentence, from a visually
 * hidden paragraph. Colour is never the only cue: an empty day is a short
 * stub rather than nothing, and today's bar carries an ink outline.
 *
 * Every paint value is an inline attribute with a fallback, so the chart
 * still draws sensibly before any `.recent-bars*` rule has loaded.
 */

const SLOT = 24
const BAR_WIDTH = 14
const RADIUS = 4
const TOP = 4
const PLOT_HEIGHT = 44
const STUB_HEIGHT = 3
const MIN_BAR_HEIGHT = 6
const LABEL_Y = 60
const VIEW_HEIGHT = 64

/** A bar with its two top corners rounded and a flat base. */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(RADIUS, w / 2, h)
  return [
    `M${x} ${y + h}`,
    `V${y + r}`,
    `Q${x} ${y} ${x + r} ${y}`,
    `H${x + w - r}`,
    `Q${x + w} ${y} ${x + w} ${y + r}`,
    `V${y + h}`,
    'Z',
  ].join(' ')
}

/** The weekday a DayCount's 'YYYY-MM-DD' key falls on, read on the UTC calendar. */
function weekdayName(key: string, locale?: string): string {
  const ms = Date.parse(`${key}T00:00:00.000Z`)
  if (!Number.isFinite(ms)) return key
  return new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(ms)
}

function cupsWord(n: number): string {
  return n === 1 ? 'cup' : 'cups'
}

/** "Last 7 days: Sat 1, Sun 0, … today 2 cups." */
export function describeDays(days: readonly DayCount[], label = 'Last 7 days', locale?: string): string {
  if (days.length === 0) return `${label}: no days.`
  const parts = days.map((day) => `${day.isToday ? 'today' : weekdayName(day.key, locale)} ${day.cups}`)
  const lastCups = days[days.length - 1]?.cups ?? 0
  return `${label}: ${parts.join(', ')} ${cupsWord(lastCups)}.`
}

export function RecentBars({
  days,
  label = 'Last 7 days',
  locale,
}: {
  days: readonly DayCount[]
  label?: string
  locale?: string
}) {
  const max = Math.max(1, ...days.map((day) => day.cups))
  const width = SLOT * Math.max(days.length, 1)
  const base = TOP + PLOT_HEIGHT

  return (
    <div className="recent-bars">
      <svg
        className="recent-bars__chart"
        viewBox={`0 0 ${width} ${VIEW_HEIGHT}`}
        width="100%"
        aria-hidden="true"
        focusable="false"
      >
        {days.map((day, i) => {
          const empty = day.cups <= 0
          const h = empty
            ? STUB_HEIGHT
            : Math.max(MIN_BAR_HEIGHT, Math.round((day.cups / max) * PLOT_HEIGHT))
          const x = i * SLOT + (SLOT - BAR_WIDTH) / 2
          const classes = [
            'recent-bars__bar',
            empty ? 'recent-bars__bar--empty' : '',
            day.isToday ? 'recent-bars__bar--today' : '',
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <g key={day.key}>
              <path
                className={classes}
                d={barPath(x, base - h, BAR_WIDTH, h)}
                fill={empty ? 'var(--paper-edge, #dde2dc)' : 'var(--punch, #2e7d5b)'}
                stroke={day.isToday ? 'var(--ink, #17202a)' : 'none'}
                strokeWidth={day.isToday ? 1.5 : 0}
                data-cups={day.cups}
                data-today={day.isToday ? 'true' : undefined}
              />
              <text
                className={`recent-bars__label${day.isToday ? ' recent-bars__label--today' : ''}`}
                x={i * SLOT + SLOT / 2}
                y={LABEL_Y}
                textAnchor="middle"
                fontSize={10}
                fontWeight={day.isToday ? 700 : 400}
                fill="var(--ink-soft, #47525e)"
              >
                {day.weekday}
              </text>
            </g>
          )
        })}
      </svg>
      <p className="visually-hidden">{describeDays(days, label, locale)}</p>
    </div>
  )
}
