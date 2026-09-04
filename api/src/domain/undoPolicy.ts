const DAY_MS = 24 * 60 * 60 * 1000
const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000

/**
 * Put Back follows the Jakarta calendar day used by the coffee group.
 * Jakarta is UTC+07:00 year-round, so shifting into local clock space keeps
 * the boundary deterministic without depending on the server's timezone.
 *
 * The optional short deadline preserves the original grace window when a
 * drink happens just before local midnight.
 */
export function sameDayUndoDeadline(createdAt: Date, shortDeadline?: Date): Date {
  const jakartaClock = createdAt.getTime() + JAKARTA_OFFSET_MS
  const localDayStart = Math.floor(jakartaClock / DAY_MS) * DAY_MS
  const localDayEndUtc = localDayStart + DAY_MS - 1 - JAKARTA_OFFSET_MS
  const sameDayDeadline = new Date(localDayEndUtc)
  if (
    shortDeadline
    && Number.isFinite(shortDeadline.getTime())
    && shortDeadline.getTime() > sameDayDeadline.getTime()
  ) {
    return shortDeadline
  }
  return sameDayDeadline
}

export function isSameJakartaDay(left: Date, right: Date): boolean {
  return Math.floor((left.getTime() + JAKARTA_OFFSET_MS) / DAY_MS)
    === Math.floor((right.getTime() + JAKARTA_OFFSET_MS) / DAY_MS)
}
