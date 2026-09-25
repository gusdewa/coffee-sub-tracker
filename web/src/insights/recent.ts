import type { HistoryItem } from '../api/client'

/**
 * Small, honest figures derived from the member's own history page.
 *
 * Every function here is pure: the caller passes `now` and the `limit` the
 * page was requested with, so a figure can be recomputed and tested at any
 * fixed instant. The rule throughout is that a figure is either provable
 * from the rows in hand or absent — never a guess dressed up as a count.
 *
 * History arrives newest first (the API's RowKey is an inverted clock), and a
 * reversal is always newer than the drink it reverses. So a page that was
 * cut off at `limit` is still complete for any window that begins after its
 * oldest row. `limit` must be the limit the server honoured for that page.
 */

export const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Jakarta is UTC+07:00 year-round, the same fixed rule as
 * api/src/domain/undoPolicy.ts, so the day boundaries shown here are the ones
 * the server enforces for Put Back regardless of the device's time zone.
 */
export const JAKARTA_OFFSET_MS = 7 * 3_600_000

const PACE_WINDOW_DAYS = 14
const PACE_MIN_CUPS = 3
const PACE_CAP_DAYS = 60

/** Days since the epoch, counted on the Jakarta calendar. */
export function jakartaDayIndex(ms: number): number {
  return Math.floor((ms + JAKARTA_OFFSET_MS) / DAY_MS)
}

/** The first UTC millisecond of a Jakarta day. */
function dayStartMs(dayIndex: number): number {
  return dayIndex * DAY_MS - JAKARTA_OFFSET_MS
}

// `dayIndex * DAY_MS` is midnight UTC of the date that is the Jakarta date,
// so reading it back in UTC names the Jakarta day without a time-zone lookup.
function keyOfDay(dayIndex: number): string {
  return new Date(dayIndex * DAY_MS).toISOString().slice(0, 10)
}

function weekdayOfDay(dayIndex: number, style: 'narrow' | 'short' | 'long', locale?: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: style, timeZone: 'UTC' }).format(
    new Date(dayIndex * DAY_MS),
  )
}

/** 'YYYY-MM-DD' of the Jakarta day containing `ms` (which must be finite). */
export function jakartaDayKey(ms: number): string {
  return keyOfDay(jakartaDayIndex(ms))
}

/** The Jakarta weekday of `ms`, e.g. 'Thursday' — for naming a day that is no longer today. */
export function jakartaWeekday(
  ms: number,
  style: 'narrow' | 'short' | 'long' = 'long',
  locale?: string,
): string {
  return weekdayOfDay(jakartaDayIndex(ms), style, locale)
}

/** Only a drink that still stands is a cup; grants, corrections and reversals never are. */
export function isCup(item: HistoryItem): boolean {
  // `reversed` is compared, not truth-tested, so a row from an API that
  // predates the field still counts.
  return item.type === 'CONSUME' && item.reversed !== true
}

/** NaN for a missing or unparseable time, which every caller treats as unknown. */
function timeOf(item: HistoryItem | undefined): number {
  return typeof item?.createdAt === 'string' ? Date.parse(item.createdAt) : Number.NaN
}

interface Span {
  /** Times of the cups from `startMs` on. */
  times: number[]
  /** Whether the page shows a row strictly older than `startMs`. */
  reached: boolean
}

/**
 * Walks a newest-first page from its start back to `startMs`.
 *
 * The walk stops at the first row strictly older than `startMs`: RowKey order
 * puts everything after it further back still, rows that merely share its
 * millisecond included. Reaching such a row therefore proves the page holds
 * every row of the span, and that the member was around before it. A short
 * page is complete too, being the whole ledger, but proves no such tenure;
 * callers that accept it check `items.length < limit` themselves.
 *
 * Null when a cup inside the span has no readable time. It can't be placed on
 * a day, and leaving it out would draw a zero where there may have been a cup.
 */
function spanSince(items: readonly HistoryItem[], startMs: number): Span | null {
  const times: number[] = []
  for (const item of items) {
    const ms = timeOf(item)
    if (ms < startMs) return { times, reached: true }
    if (!isCup(item)) continue
    if (!Number.isFinite(ms)) return null
    times.push(ms)
  }
  return { times, reached: false }
}

export interface DayCount {
  key: string
  weekday: string
  cups: number
  isToday: boolean
}

export type Week = { kind: 'known'; days: DayCount[]; total: number } | { kind: 'unknown' }

/**
 * Cups per Jakarta day for the seven days ending today, oldest first.
 *
 * Zero-filled only when the page proves it reaches back past the first day;
 * before a member's first row the true count really is zero, but a truncated
 * page could be hiding cups, so it is `unknown` rather than a row of zeros.
 */
export function lastSevenDays(
  items: readonly HistoryItem[],
  { now, limit, locale }: { now: number; limit: number; locale?: string },
): Week {
  const today = jakartaDayIndex(now)
  const firstDay = today - 6
  const span = spanSince(items, dayStartMs(firstDay))
  if (!span || !(span.reached || items.length < limit)) return { kind: 'unknown' }

  const days: DayCount[] = Array.from({ length: 7 }, (_, i) => ({
    key: keyOfDay(firstDay + i),
    weekday: weekdayOfDay(firstDay + i, 'narrow', locale),
    cups: 0,
    isToday: firstDay + i === today,
  }))

  let total = 0
  for (const ms of span.times) {
    // A cup on a later Jakarta day than `now` (device clock behind the
    // server's) has no bar yet; the store refetches once the day turns.
    const day = days[jakartaDayIndex(ms) - firstDay]
    if (!day) continue
    day.cups += 1
    total += 1
  }
  return { kind: 'known', days, total }
}

/**
 * Which cup of its Jakarta day the receipt's drink was: 1 plus the older cups
 * that day. Null when the drink is not on the page, has been put back, or the
 * page cannot prove it reaches the start of that day.
 *
 * `weekday` names the receipt's Jakarta day for when it is no longer today.
 * It comes from here rather than from the receipt, because a receipt from an
 * older API has no `createdAt` while its history row still has a time.
 */
export function receiptDayCount(
  items: readonly HistoryItem[],
  receipt: { opId: string; createdAt: string | null },
  { limit, now, locale }: { limit: number; now: number; locale?: string },
): { cups: number; isToday: boolean; weekday: string } | null {
  const idx = items.findIndex((item) => item.type === 'CONSUME' && item.opId === receipt.opId)
  const own = items[idx]
  if (!own || !isCup(own)) return null

  let ms = timeOf(own)
  if (!Number.isFinite(ms) && receipt.createdAt !== null) ms = Date.parse(receipt.createdAt)
  if (!Number.isFinite(ms)) return null

  const day = jakartaDayIndex(ms)
  // Rows ahead of the receipt are newer and can't change its ordinal.
  const span = spanSince(items.slice(idx + 1), dayStartMs(day))
  if (!span || !(span.reached || items.length < limit)) return null

  const cups = 1 + span.times.filter((at) => jakartaDayIndex(at) === day).length
  return { cups, isToday: day === jakartaDayIndex(now), weekday: weekdayOfDay(day, 'long', locale) }
}

export interface Pace {
  perDay: number
  cups: number
  daysLeft: number
  capped: boolean
}

/**
 * How long the remaining cups last at the member's last-14-days rate.
 *
 * The window rolls (`now` minus 14×24h) rather than counting calendar days,
 * so the rate doesn't jump between a morning and an evening look at the same
 * history. The estimate needs proof the member was around for the whole
 * window — a row on the page, of any type, must predate it — otherwise a
 * newcomer's first week would read as half their real pace. That same proof
 * makes the page complete for the window, so `limit` is accepted only to
 * keep the call shape uniform.
 */
export function paceEstimate(
  items: readonly HistoryItem[],
  { now, remaining }: { now: number; limit: number; remaining: number },
): Pace | null {
  if (!(remaining > 0)) return null
  // No upper bound on purpose: a row stamped after `now` can only be clock
  // skew between this device and the server, and it is still a real cup.
  const span = spanSince(items, now - PACE_WINDOW_DAYS * DAY_MS)
  if (!span?.reached) return null

  const cups = span.times.length
  if (cups < PACE_MIN_CUPS) return null

  const perDay = cups / PACE_WINDOW_DAYS
  // remaining ÷ (cups/14), kept in integers: the float form turns an exact
  // 14 into 14.000000000000002, which ceil would report as 15.
  const daysLeft = Math.ceil((remaining * PACE_WINDOW_DAYS) / cups)
  return { perDay, cups, daysLeft, capped: daysLeft > PACE_CAP_DAYS }
}

/** The pace card's copy, kept beside the maths so the two cannot drift apart. */
export function describePace(pace: Pace): { headline: string; detail: string } {
  const headline = pace.capped
    ? 'More than 2 months left'
    : `About ${pace.daysLeft} ${pace.daysLeft === 1 ? 'day' : 'days'} left`
  // One decimal is all a 14-day sample supports; '1.0' reads as false precision.
  const rate = pace.perDay.toFixed(1).replace(/\.0$/, '')
  return { headline, detail: `At your ${PACE_WINDOW_DAYS}-day pace (${rate} a day) · Estimate` }
}

/**
 * The Put Back caption. The clock time is always Jakarta's, since that is the
 * day the server enforces. "today"/"tomorrow" compare Jakarta days, so a
 * deadline in the grace window just past midnight reads "tomorrow" until
 * midnight and "today" after it; anything further out names the date instead.
 */
export function formatUndoDeadline(undoExpiresAt: string | null, now: number, locale?: string): string {
  const deadline = undoExpiresAt === null ? Number.NaN : Date.parse(undoExpiresAt)
  if (!Number.isFinite(deadline)) return 'Available today'

  const clock = { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } as const
  const daysAhead = jakartaDayIndex(deadline) - jakartaDayIndex(now)
  if (daysAhead === 0 || daysAhead === 1) {
    const time = new Intl.DateTimeFormat(locale, clock).format(deadline)
    return `Available until ${time} ${daysAhead === 0 ? 'today' : 'tomorrow'}`
  }
  const when = new Intl.DateTimeFormat(locale, {
    ...clock,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(deadline)
  return `Available until ${when}`
}
