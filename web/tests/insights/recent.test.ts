import { describe, expect, test } from 'vitest'
import type { HistoryItem } from '../../src/api/client'
import {
  DAY_MS,
  JAKARTA_OFFSET_MS,
  describePace,
  formatUndoDeadline,
  isCup,
  jakartaDayIndex,
  jakartaDayKey,
  jakartaWeekday,
  lastSevenDays,
  paceEstimate,
  receiptDayCount,
} from '../../src/insights/recent'

// en-GB keeps weekday and clock formatting deterministic across CI machines.
const LOCALE = 'en-GB'
const HOUR = 3_600_000
const at = (iso: string) => Date.parse(iso)

// Friday 25 September 2026, 10:00 in Jakarta.
const NOW = at('2026-09-25T03:00:00.000Z')

let seq = 0
function row(createdAt: number | string, overrides: Partial<HistoryItem> = {}): HistoryItem {
  seq += 1
  return {
    opId: `op-${seq}`,
    type: 'CONSUME',
    delta: -1,
    batchLabel: 'September beans',
    createdAt: typeof createdAt === 'number' ? new Date(createdAt).toISOString() : createdAt,
    reversed: false,
    ...overrides,
  }
}
const grant = (createdAt: number) => row(createdAt, { type: 'GRANT', delta: 8 })

/** The API returns history newest first; build every page the same way. */
const newestFirst = (...items: HistoryItem[]) =>
  [...items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))

describe('Jakarta days', () => {
  test('use the same fixed UTC+7 offset as the API undo policy', () => {
    expect(JAKARTA_OFFSET_MS).toBe(7 * 60 * 60 * 1000)
    expect(DAY_MS).toBe(24 * 60 * 60 * 1000)
  })

  test('16:59:59.999Z is still the previous Jakarta day and 17:00Z starts the next', () => {
    const lastMoment = at('2026-09-24T16:59:59.999Z')
    const midnight = at('2026-09-24T17:00:00.000Z')

    expect(jakartaDayKey(lastMoment)).toBe('2026-09-24')
    expect(jakartaDayKey(midnight)).toBe('2026-09-25')
    expect(jakartaDayIndex(midnight) - jakartaDayIndex(lastMoment)).toBe(1)
  })

  test('the week buckets a cup at 16:59:59.999Z into yesterday and one at 17:00Z into today', () => {
    const week = lastSevenDays(
      newestFirst(row('2026-09-24T16:59:59.999Z'), row('2026-09-24T17:00:00.000Z')),
      { now: NOW, limit: 100, locale: LOCALE },
    )

    expect(week.kind).toBe('known')
    if (week.kind !== 'known') return
    expect(week.days.at(-2)).toMatchObject({ key: '2026-09-24', cups: 1, isToday: false })
    expect(week.days.at(-1)).toMatchObject({ key: '2026-09-25', cups: 1, isToday: true })
  })
})

describe('what counts as a cup', () => {
  test('only an unreversed CONSUME is a cup', () => {
    expect(isCup(row(NOW))).toBe(true)
    expect(isCup(row(NOW, { reversed: true }))).toBe(false)
    expect(isCup(row(NOW, { type: 'REVERSAL', delta: 1 }))).toBe(false)
    expect(isCup(row(NOW, { type: 'GRANT', delta: 8 }))).toBe(false)
    expect(isCup(row(NOW, { type: 'CORRECTION', delta: 2 }))).toBe(false)
  })

  test('a row from an older API without `reversed` still counts', () => {
    const legacy = { ...row(NOW) } as Partial<HistoryItem>
    delete legacy.reversed
    expect(isCup(legacy as HistoryItem)).toBe(true)
  })

  test('the week ignores reversals, grants, corrections and reversed drinks', () => {
    const today = at('2026-09-25T02:00:00.000Z')
    const week = lastSevenDays(
      newestFirst(
        row(today + 5, { type: 'REVERSAL', delta: 1 }),
        row(today + 4, { reversed: true }),
        row(today + 3, { type: 'CORRECTION', delta: 2 }),
        row(today + 2),
        row(today + 1, { type: 'GRANT', delta: 8 }),
      ),
      { now: NOW, limit: 100, locale: LOCALE },
    )

    expect(week).toMatchObject({ kind: 'known', total: 1 })
    if (week.kind !== 'known') return
    expect(week.days.at(-1)?.cups).toBe(1)
  })
})

describe('lastSevenDays', () => {
  test('is seven Jakarta days, oldest first, zero-filled, ending today', () => {
    const week = lastSevenDays([], { now: NOW, limit: 100, locale: LOCALE })

    expect(week.kind).toBe('known')
    if (week.kind !== 'known') return
    expect(week.days.map((d) => d.key)).toEqual([
      '2026-09-19',
      '2026-09-20',
      '2026-09-21',
      '2026-09-22',
      '2026-09-23',
      '2026-09-24',
      '2026-09-25',
    ])
    // Sat … Fri, labelled by the Jakarta calendar day, not the device's.
    expect(week.days.map((d) => d.weekday)).toEqual(['S', 'S', 'M', 'T', 'W', 'T', 'F'])
    expect(week.days.map((d) => d.cups)).toEqual([0, 0, 0, 0, 0, 0, 0])
    expect(week.days.map((d) => d.isToday)).toEqual([false, false, false, false, false, false, true])
    expect(week.total).toBe(0)
  })

  test('counts cups into their Jakarta day and drops anything before the window', () => {
    const week = lastSevenDays(
      newestFirst(
        row('2026-09-25T02:30:00.000Z'),
        row('2026-09-24T18:00:00.000Z'), // 01:00 on the 25th in Jakarta
        row('2026-09-23T05:00:00.000Z'),
        row('2026-09-18T17:30:00.000Z'), // 00:30 on the 19th: first day of the window
        row('2026-09-18T16:30:00.000Z'), // 23:30 on the 18th: outside the window
      ),
      { now: NOW, limit: 100, locale: LOCALE },
    )

    expect(week.kind).toBe('known')
    if (week.kind !== 'known') return
    expect(week.days.map((d) => d.cups)).toEqual([1, 0, 0, 0, 1, 0, 2])
    expect(week.total).toBe(4)
  })

  test('a full page that does not reach back past the window is unknown, never zero-filled', () => {
    const items = newestFirst(
      row('2026-09-25T02:00:00.000Z'),
      row('2026-09-24T02:00:00.000Z'),
      row('2026-09-23T02:00:00.000Z'),
    )

    expect(lastSevenDays(items, { now: NOW, limit: 3, locale: LOCALE })).toEqual({ kind: 'unknown' })
  })

  test('a full page is complete once its oldest row, of any type, predates the window', () => {
    const items = newestFirst(
      row('2026-09-25T02:00:00.000Z'),
      row('2026-09-24T02:00:00.000Z'),
      grant(at('2026-09-18T16:59:59.999Z')),
    )

    expect(lastSevenDays(items, { now: NOW, limit: 3, locale: LOCALE })).toMatchObject({
      kind: 'known',
      total: 2,
    })
  })

  test('a full page whose oldest row sits exactly on the window start is still unknown', () => {
    // Rows sharing that millisecond may be the ones the page cut off.
    const items = newestFirst(row('2026-09-25T02:00:00.000Z'), grant(at('2026-09-18T17:00:00.000Z')))

    expect(lastSevenDays(items, { now: NOW, limit: 2, locale: LOCALE })).toEqual({ kind: 'unknown' })
  })

  test('an unparseable oldest row cannot prove a full page complete', () => {
    const items = [row('2026-09-25T02:00:00.000Z'), row('not a date')]

    expect(lastSevenDays(items, { now: NOW, limit: 2, locale: LOCALE })).toEqual({ kind: 'unknown' })
  })

  test('a cup whose time cannot be read makes the week unknown, not one cup short', () => {
    // Dropping it would draw a zero on a day the member may have had a cup.
    const items = [row('2026-09-25T02:00:00.000Z'), row('not a date')]

    expect(lastSevenDays(items, { now: NOW, limit: 100, locale: LOCALE })).toEqual({ kind: 'unknown' })
  })

  test('an unreadable row is harmless when it is no cup, or the page already places it before the window', () => {
    const items = [
      row('2026-09-25T02:00:00.000Z'),
      row('not a date', { type: 'GRANT', delta: 8 }),
      row('2026-09-10T02:00:00.000Z'),
      // Newest first, so this sits behind a row that predates the window.
      row('not a date'),
    ]

    expect(lastSevenDays(items, { now: NOW, limit: 100, locale: LOCALE })).toMatchObject({
      kind: 'known',
      total: 1,
    })
  })
})

describe('receiptDayCount', () => {
  const receiptAt = at('2026-09-25T02:30:00.000Z')

  test('is this cup plus the older unreversed cups on the same Jakarta day', () => {
    const receipt = row(receiptAt)
    const items = newestFirst(
      receipt,
      row(at('2026-09-25T00:10:00.000Z')),
      row(at('2026-09-24T23:00:00.000Z'), { type: 'REVERSAL', delta: 1 }),
      row(at('2026-09-24T22:00:00.000Z'), { reversed: true }),
      row(at('2026-09-24T17:00:00.000Z')), // 00:00 on the 25th: same day
      row(at('2026-09-24T16:59:59.999Z')), // the day before
    )

    expect(
      receiptDayCount(
        items,
        { opId: receipt.opId, createdAt: receipt.createdAt },
        { limit: 100, now: NOW, locale: LOCALE },
      ),
    ).toEqual({ cups: 3, isToday: true, weekday: 'Friday' })
  })

  test('is null when an older cup that day cannot be dated', () => {
    // It may or may not belong to the receipt's day; either count would be a guess.
    const receipt = row(receiptAt)
    const items = [receipt, row('not a date'), row(receiptAt - HOUR)]

    expect(
      receiptDayCount(items, { opId: receipt.opId, createdAt: receipt.createdAt }, { limit: 100, now: NOW }),
    ).toBeNull()
  })

  test('is null when the page does not contain the receipt op', () => {
    const items = newestFirst(row(receiptAt), row(receiptAt - HOUR))

    expect(
      receiptDayCount(items, { opId: 'op-missing', createdAt: new Date(receiptAt).toISOString() }, {
        limit: 100,
        now: NOW,
      }),
    ).toBeNull()
  })

  test('is null when the receipt cup has been put back', () => {
    const receipt = row(receiptAt, { reversed: true })
    const items = newestFirst(row(receiptAt + 1, { type: 'REVERSAL', delta: 1 }), receipt)

    expect(
      receiptDayCount(items, { opId: receipt.opId, createdAt: receipt.createdAt }, { limit: 100, now: NOW }),
    ).toBeNull()
  })

  test('is null when a full page cannot prove it covers the whole receipt day', () => {
    const receipt = row(receiptAt)
    const items = newestFirst(receipt, row(at('2026-09-24T17:00:00.000Z')))

    expect(
      receiptDayCount(items, { opId: receipt.opId, createdAt: receipt.createdAt }, { limit: 2, now: NOW }),
    ).toBeNull()
  })

  test('a full page that reaches into the previous day covers the receipt day', () => {
    const receipt = row(receiptAt)
    const items = newestFirst(
      receipt,
      row(at('2026-09-24T17:00:00.000Z')),
      grant(at('2026-09-24T16:59:59.999Z')),
    )

    expect(
      receiptDayCount(items, { opId: receipt.opId, createdAt: receipt.createdAt }, { limit: 3, now: NOW }),
    ).toMatchObject({ cups: 2, isToday: true })
  })

  test('falls back to the receipt time when the history row time is unusable', () => {
    const receipt = row('not a date')
    const items = [row(receiptAt + 60_000), receipt, row(receiptAt - HOUR)]

    expect(
      receiptDayCount(
        items,
        { opId: receipt.opId, createdAt: new Date(receiptAt).toISOString() },
        { limit: 100, now: NOW, locale: LOCALE },
      ),
    ).toEqual({ cups: 2, isToday: true, weekday: 'Friday' })
  })

  test('a cup from just before midnight is not "today" once the day has turned', () => {
    // 23:59:30 on Thursday in Jakarta, looked at 00:00:30 on Friday.
    const lateCup = row('2026-09-24T16:59:30.000Z')
    const items = newestFirst(lateCup, row('2026-09-24T05:00:00.000Z'))
    const now = at('2026-09-24T17:00:30.000Z')

    expect(jakartaWeekday(Date.parse(lateCup.createdAt), 'long', LOCALE)).toBe('Thursday')
    // The sheet names the day instead, and gets the name from the history
    // row, so a legacy receipt with no `createdAt` can still say it.
    expect(
      receiptDayCount(items, { opId: lateCup.opId, createdAt: null }, { limit: 100, now, locale: LOCALE }),
    ).toEqual({ cups: 2, isToday: false, weekday: 'Thursday' })
  })
})

describe('paceEstimate', () => {
  /** Five cups spread over the last ten days, as offsets back from `now`. */
  const fiveCupsBefore = (now: number) => [
    row(now - 1 * HOUR),
    row(now - 30 * HOUR),
    row(now - 50 * HOUR),
    row(now - 100 * HOUR),
    row(now - 230 * HOUR),
  ]

  test('is null when every row, the grant included, is newer than 14 days', () => {
    const items = newestFirst(...fiveCupsBefore(NOW), grant(NOW - 13 * DAY_MS))

    expect(paceEstimate(items, { now: NOW, limit: 100, remaining: 4 })).toBeNull()
  })

  test('is present once a grant 20 days old proves the whole window was lived through', () => {
    const items = newestFirst(...fiveCupsBefore(NOW), grant(NOW - 20 * DAY_MS))

    expect(paceEstimate(items, { now: NOW, limit: 100, remaining: 4 })).toEqual({
      perDay: 5 / 14,
      cups: 5,
      daysLeft: 12, // 4 ÷ (5/14) = 11.2
      capped: false,
    })
  })

  test('a morning and an evening look at the same history give the same rate', () => {
    const morning = at('2026-09-25T00:30:00.000Z') // 07:30 Jakarta
    const evening = at('2026-09-25T13:00:00.000Z') // 20:00 Jakarta
    const shape = (now: number) =>
      newestFirst(...fiveCupsBefore(now), row(now - 330 * HOUR), grant(now - 20 * DAY_MS))

    const early = paceEstimate(shape(morning), { now: morning, limit: 100, remaining: 4 })
    const late = paceEstimate(shape(evening), { now: evening, limit: 100, remaining: 4 })

    expect(early).not.toBeNull()
    expect(late?.perDay).toBe(early?.perDay)
    expect(early?.perDay).toBe(6 / 14)
  })

  test('one fixed history gives the same rate at 07:30 and at 20:00', () => {
    // The plan's literal case: nothing changes between the two looks, so a
    // rate that moved would be an artefact of the time of day.
    const items = newestFirst(
      row('2026-09-24T12:00:00.000Z'),
      row('2026-09-22T01:00:00.000Z'),
      row('2026-09-19T08:00:00.000Z'),
      row('2026-09-15T23:00:00.000Z'),
      grant(at('2026-09-01T02:00:00.000Z')),
    )
    const morning = paceEstimate(items, { now: at('2026-09-25T00:30:00.000Z'), limit: 100, remaining: 4 })
    const evening = paceEstimate(items, { now: at('2026-09-25T13:00:00.000Z'), limit: 100, remaining: 4 })

    expect(morning).toEqual({ perDay: 4 / 14, cups: 4, daysLeft: 14, capped: false })
    expect(evening).toEqual(morning)
  })

  test('is null when a cup that may fall inside the window cannot be dated', () => {
    const undated = row('not a date')

    expect(
      paceEstimate([...newestFirst(...fiveCupsBefore(NOW)), undated, grant(NOW - 20 * DAY_MS)], {
        now: NOW,
        limit: 100,
        remaining: 4,
      }),
    ).toBeNull()
    // Behind the 20-day grant it is older than the window and changes nothing.
    expect(
      paceEstimate([...newestFirst(...fiveCupsBefore(NOW), grant(NOW - 20 * DAY_MS)), undated], {
        now: NOW,
        limit: 100,
        remaining: 4,
      }),
    ).toMatchObject({ cups: 5 })
  })

  test('only cups inside the 14-day window count', () => {
    const items = newestFirst(
      ...fiveCupsBefore(NOW),
      row(NOW - 2 * HOUR, { reversed: true }),
      row(NOW - 2 * HOUR, { type: 'REVERSAL', delta: 1 }),
      row(NOW - 15 * DAY_MS),
      grant(NOW - 20 * DAY_MS),
    )

    expect(paceEstimate(items, { now: NOW, limit: 100, remaining: 4 })?.cups).toBe(5)
  })

  test('is null below 3 cups', () => {
    const items = newestFirst(row(NOW - HOUR), row(NOW - 2 * DAY_MS), grant(NOW - 20 * DAY_MS))

    expect(paceEstimate(items, { now: NOW, limit: 100, remaining: 4 })).toBeNull()
  })

  test('is null with no cups left, or no cups at all', () => {
    const items = newestFirst(...fiveCupsBefore(NOW), grant(NOW - 20 * DAY_MS))

    expect(paceEstimate(items, { now: NOW, limit: 100, remaining: 0 })).toBeNull()
    expect(paceEstimate([grant(NOW - 20 * DAY_MS)], { now: NOW, limit: 100, remaining: 4 })).toBeNull()
    expect(paceEstimate([], { now: NOW, limit: 100, remaining: 4 })).toBeNull()
  })

  test('rounds the days left up, exactly, without floating-point drift', () => {
    const cups = (n: number) => Array.from({ length: n }, (_, i) => row(NOW - (i + 1) * HOUR))
    const pace = (n: number, remaining: number) =>
      paceEstimate(newestFirst(...cups(n), grant(NOW - 20 * DAY_MS)), { now: NOW, limit: 100, remaining })

    expect(pace(3, 1)?.daysLeft).toBe(5) // 4.67 → 5
    // 17 left at 17 cups per 14 days is exactly 14 days; 17 ÷ (17/14) in
    // floating point is 14.000000000000002, which a naive ceil turns into 15.
    expect(pace(17, 17)?.daysLeft).toBe(14)
  })

  test('caps the estimate beyond 60 days', () => {
    const cups = (n: number) => Array.from({ length: n }, (_, i) => row(NOW - (i + 1) * HOUR))
    const pace = (n: number, remaining: number) =>
      paceEstimate(newestFirst(...cups(n), grant(NOW - 20 * DAY_MS)), { now: NOW, limit: 100, remaining })

    expect(pace(7, 30)).toMatchObject({ daysLeft: 60, capped: false })
    expect(pace(7, 31)).toMatchObject({ daysLeft: 62, capped: true })
  })
})

describe('describePace', () => {
  test('says roughly how many days are left and marks the figure as an estimate', () => {
    expect(describePace({ perDay: 5 / 14, cups: 5, daysLeft: 12, capped: false })).toEqual({
      headline: 'About 12 days left',
      detail: 'At your 14-day pace (0.4 a day) · Estimate',
    })
  })

  test('uses the singular for one day and trims a whole-number rate', () => {
    expect(describePace({ perDay: 1, cups: 14, daysLeft: 1, capped: false })).toEqual({
      headline: 'About 1 day left',
      detail: 'At your 14-day pace (1 a day) · Estimate',
    })
  })

  test('does not pretend to precision beyond two months', () => {
    expect(describePace({ perDay: 3 / 14, cups: 3, daysLeft: 61, capped: true }).headline).toBe(
      'More than 2 months left',
    )
  })
})

describe('formatUndoDeadline', () => {
  test('inside the grace window just before midnight, the deadline is tomorrow', () => {
    // Cup counted 23:59:30 Jakarta (16:59:30Z); the short grace outlives the day.
    const deadline = '2026-09-24T17:01:00.000Z'
    const now = at('2026-09-24T16:59:35.000Z')

    expect(formatUndoDeadline(deadline, now, LOCALE)).toBe('Available until 00:01 tomorrow')
  })

  test('the same grace deadline reads "today" once midnight has passed', () => {
    const deadline = '2026-09-24T17:01:00.000Z'
    const now = at('2026-09-24T17:00:10.000Z')

    expect(formatUndoDeadline(deadline, now, LOCALE)).toBe('Available until 00:01 today')
  })

  test('the end of the Jakarta day reads 23:59 today', () => {
    const deadline = '2026-09-24T16:59:59.999Z'
    const now = at('2026-09-24T03:00:00.000Z')

    expect(formatUndoDeadline(deadline, now, LOCALE)).toBe('Available until 23:59 today')
  })

  test('says only "today" when there is no usable deadline', () => {
    expect(formatUndoDeadline(null, NOW, LOCALE)).toBe('Available today')
    expect(formatUndoDeadline('not a date', NOW, LOCALE)).toBe('Available today')
  })

  test('never calls a deadline further out "today" or "tomorrow"', () => {
    const text = formatUndoDeadline('2026-09-27T02:00:00.000Z', NOW, LOCALE)

    expect(text).not.toMatch(/today|tomorrow/)
    expect(text).toMatch(/^Available until /)
    expect(text).toContain('Sun')
    expect(text).toContain('09:00')
  })
})
