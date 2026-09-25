import { describe, test, expect } from 'vitest'
import { render } from '@testing-library/react'
import type { DayCount } from '../../src/insights/recent'
import { RecentBars } from '../../src/components/RecentBars'

// Saturday 19 to Friday 25 September 2026, today last.
const WEEK: Array<[string, string, number]> = [
  ['2026-09-19', 'S', 1],
  ['2026-09-20', 'S', 0],
  ['2026-09-21', 'M', 2],
  ['2026-09-22', 'T', 0],
  ['2026-09-23', 'W', 0],
  ['2026-09-24', 'T', 3],
  ['2026-09-25', 'F', 2],
]

const days = (cups: number[] = WEEK.map(([, , c]) => c)): DayCount[] =>
  WEEK.map(([key, weekday], i) => ({ key, weekday, cups: cups[i] ?? 0, isToday: i === WEEK.length - 1 }))

const bars = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<SVGPathElement>('path.recent-bars__bar'))

/** Height of a bar path from its "M x yBase V yTop …" commands. */
function heightOf(bar: SVGPathElement): number {
  const d = bar.getAttribute('d') ?? ''
  const base = Number(/^M\S+ (\S+)/.exec(d)?.[1])
  const top = Number(/H\S+ Q\S+ (\S+)/.exec(d)?.[1])
  return base - top
}

describe('RecentBars', () => {
  test('draws seven bars and reads the week out as one exact sentence', () => {
    const { container } = render(<RecentBars days={days()} locale="en-US" />)

    expect(bars(container)).toHaveLength(7)
    expect(container.querySelector('.visually-hidden')?.textContent).toBe(
      'Last 7 days: Sat 1, Sun 0, Mon 2, Tue 0, Wed 0, Thu 3, today 2 cups.',
    )
  })

  test('says "cup" when today had exactly one, and takes a custom label', () => {
    const { container } = render(
      <RecentBars days={days([0, 0, 0, 0, 0, 0, 1])} label="This week" locale="en-US" />,
    )
    expect(container.querySelector('.visually-hidden')?.textContent).toBe(
      'This week: Sat 0, Sun 0, Mon 0, Tue 0, Wed 0, Thu 0, today 1 cup.',
    )
  })

  test('hides the drawing from assistive tech, labels included', () => {
    const { container } = render(<RecentBars days={days()} locale="en-US" />)
    const svg = container.querySelector('svg')!

    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.getAttribute('viewBox')).toMatch(/^0 0 \d+ \d+$/)
    expect(svg.getAttribute('width')).toBe('100%')
    expect(Array.from(svg.querySelectorAll('text')).map((t) => t.textContent)).toEqual(
      WEEK.map(([, weekday]) => weekday),
    )
  })

  test("outlines only today's bar, so colour is not the only cue", () => {
    const { container } = render(<RecentBars days={days()} locale="en-US" />)
    const all = bars(container)
    const today = all[6]!

    expect(today.classList.contains('recent-bars__bar--today')).toBe(true)
    expect(today.getAttribute('stroke')).toContain('--ink')
    for (const bar of all.slice(0, 6)) {
      expect(bar.classList.contains('recent-bars__bar--today')).toBe(false)
      expect(bar.getAttribute('stroke')).toBe('none')
    }
  })

  test('draws a zero day as a visible stub in the paper-edge colour', () => {
    const { container } = render(<RecentBars days={days()} locale="en-US" />)
    const [sat, sun, mon, , , thu] = bars(container)

    expect(sun!.classList.contains('recent-bars__bar--empty')).toBe(true)
    expect(sun!.getAttribute('fill')).toContain('--paper-edge')
    expect(heightOf(sun!)).toBeGreaterThan(0)

    expect(sat!.getAttribute('fill')).toContain('--punch')
    // Taller for more cups: 3 > 2 > 1 > 0.
    expect(heightOf(thu!)).toBeGreaterThan(heightOf(mon!))
    expect(heightOf(mon!)).toBeGreaterThan(heightOf(sat!))
    expect(heightOf(sat!)).toBeGreaterThan(heightOf(sun!))
  })

  test('an all-zero week still draws seven visible stubs', () => {
    const { container } = render(<RecentBars days={days([0, 0, 0, 0, 0, 0, 0])} locale="en-US" />)
    const all = bars(container)

    expect(all).toHaveLength(7)
    for (const bar of all) expect(heightOf(bar)).toBeGreaterThan(0)
    expect(all[6]!.getAttribute('stroke')).toContain('--ink')
  })
})
