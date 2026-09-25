import type { HistoryItem } from '../api/client'
import { DAY_MS, describePace, isCup, lastSevenDays, paceEstimate } from '../insights/recent'
import { useCoffee } from '../state/coffee'
import { useHistory } from '../state/history'
import { RecentBars } from './RecentBars'

const PACE_WINDOW_MS = 14 * DAY_MS

/**
 * Whether the page proves at least one cup in the last 14 days.
 *
 * Only a cup actually on the page counts as proof; a page that shows none
 * cannot rule out cups it was cut off before, so the card stays hidden
 * rather than drawing an empty fortnight it cannot vouch for. A row with no
 * readable time proves nothing either way.
 */
function hasCupSince(items: readonly HistoryItem[], startMs: number): boolean {
  return items.some((item) => isCup(item) && Date.parse(item.createdAt) >= startMs)
}

/**
 * Home's compact "Your pace" card: the last seven days as bars, and — only
 * when the page proves the member spans the whole fortnight — an estimate of
 * how long the remaining cups last, tucked inside a disclosure.
 *
 * Renders nothing while the page is loading or failed, when the week can't
 * be proven complete, or when there were no cups in the last 14 days.
 */
export function PaceCard() {
  const coffee = useCoffee()
  const history = useHistory()

  if (history.loading || history.error !== null || history.items === null) return null

  const now = Date.now()
  const items = history.items
  const week = lastSevenDays(items, { now, limit: history.limit })
  if (week.kind !== 'known') return null
  if (!hasCupSince(items, now - PACE_WINDOW_MS)) return null

  const remaining = coffee.data?.totalRemaining ?? 0
  const pace = paceEstimate(items, { now, limit: history.limit, remaining })
  const copy = pace === null ? null : describePace(pace)

  return (
    <section className="pace" aria-labelledby="pace-title">
      <h2 id="pace-title" className="home__heading">
        Your pace
      </h2>
      <p className="pace__count">
        {`${week.total} ${week.total === 1 ? 'cup' : 'cups'} in the last 7 days`}
      </p>
      <RecentBars days={week.days} />
      {copy !== null && (
        <details className="pace__details">
          <summary>How long will my cups last?</summary>
          <p className="pace__headline">{copy.headline}</p>
          <p className="pace__detail">{copy.detail}</p>
        </details>
      )}
    </section>
  )
}
