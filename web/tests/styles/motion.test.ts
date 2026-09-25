import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Motion is named once, in tokens.css, and is opt-in.
 *
 * The success cup and the sheet's entry are decoration: the base styles draw
 * the final frame, and every animation that moves anything sits inside
 * `prefers-reduced-motion: no-preference` with `fill-mode: both`, so reduced
 * motion shows the finished picture and no slide-in (WCAG 2.3.3). The one
 * exception is the loading skeleton's pulse, which the global reduced-motion
 * rule already collapses to a single, instant iteration.
 */

const read = (name: string) =>
  readFileSync(resolve(__dirname, '../../src/styles/', name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

const tokens = () => read('tokens.css')

interface Declaration {
  property: string
  value: string
  /** Enclosing preludes, outermost first: at-rules, then the selector. */
  within: string[]
}

/** Every declaration in a stylesheet, with the blocks it sits in. */
function declarations(css: string): Declaration[] {
  const found: Declaration[] = []
  const stack: string[] = []
  let buffer = ''
  for (const ch of css) {
    if (ch === '{') {
      stack.push(buffer.trim())
      buffer = ''
    } else if (ch === '}' || ch === ';') {
      const text = buffer.trim()
      const colon = text.indexOf(':')
      if (colon > 0 && stack.length > 0 && !stack[stack.length - 1]!.startsWith('@')) {
        found.push({
          property: text.slice(0, colon).trim(),
          value: text.slice(colon + 1).trim(),
          within: [...stack],
        })
      }
      buffer = ''
      if (ch === '}') stack.pop()
    } else {
      buffer += ch
    }
  }
  return found
}

/** The body of each @keyframes rule, by name. */
function keyframes(css: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const match of css.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    let depth = 1
    let i = match.index! + match[0].length
    const start = i
    for (; i < css.length && depth > 0; i += 1) {
      if (css[i] === '{') depth += 1
      if (css[i] === '}') depth -= 1
    }
    found.set(match[1]!, css.slice(start, i - 1))
  }
  return found
}

/** A token's time in milliseconds. */
function tokenMs(name: string): number {
  const m = tokens().match(new RegExp(`${name}:\\s*([\\d.]+)(ms|s)\\s*;`))
  if (!m) throw new Error(`${name} is not a time token`)
  return Number(m[1]) * (m[2] === 's' ? 1000 : 1)
}

/** A time written as a token, or a sum of tokens in calc(); anything else is unsupported. */
function timeMs(value: string): number {
  if (/[-*/]\s/.test(value.replace(/var\(--[\w-]+\)/g, ''))) throw new Error(`only sums: ${value}`)
  return [...value.matchAll(/var\((--[\w-]+)\)/g)].reduce((sum, m) => sum + tokenMs(m[1]!), 0)
}

const isTime = (part: string) => /^(calc\(|var\(--(dur|delay|stagger)-)/.test(part)

/** Splits a shorthand on whitespace outside parentheses. */
function parts(value: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const ch of value) {
    if (ch === '(') depth += 1
    if (ch === ')') depth -= 1
    if (/\s/.test(ch) && depth === 0) {
      if (current) out.push(current)
      current = ''
    } else current += ch
  }
  if (current) out.push(current)
  return out
}

const NO_PREFERENCE = /@media\s*\(\s*prefers-reduced-motion:\s*no-preference\s*\)/

/** The stylesheet without its no-preference blocks: what everyone gets. */
function withoutNoPreference(css: string): string {
  let out = css
  for (let m = out.match(NO_PREFERENCE); m; m = out.match(NO_PREFERENCE)) {
    let i = out.indexOf('{', m.index!) + 1
    for (let depth = 1; depth > 0; i += 1) {
      if (out[i] === '{') depth += 1
      if (out[i] === '}') depth -= 1
    }
    out = out.slice(0, m.index!) + out.slice(i)
  }
  return out
}

/** The last compound of a selector: `.a ~ .b` is a rule about `.b`. */
const subject = (selector: string) => selector.split(/\s*[~+>\s]\s*/).pop()!

describe('motion tokens', () => {
  test.each([
    ['--dur-press', 120],
    ['--dur-pill', 140],
    ['--dur-pulse', 1400],
    ['--dur-sheet', 240],
    ['--dur-celebrate', 900],
    ['--delay-steam', 200],
    ['--delay-hole', 600],
  ])('%s is %sms', (name, ms) => {
    expect(tokenMs(name)).toBe(ms)
  })

  test('--ease-out is the decelerating curve', () => {
    expect(tokens()).toMatch(/--ease-out:\s*cubic-bezier\(\s*0?\.05,\s*0?\.7,\s*0?\.1,\s*1\s*\)\s*;/)
  })

  test('app.css and shell.css write no raw durations: every time is a token', () => {
    for (const name of ['app.css', 'shell.css']) {
      const raw = [...read(name).matchAll(/(?<![\w.-])\d*\.?\d+(?:ms|s)\b/g)].map((m) => m[0])
      expect(raw, `${name} must use motion tokens, found: ${raw.join(', ')}`).toEqual([])
    }
  })
})

describe('animations', () => {
  const sheets = ['app.css', 'shell.css'].map(read).join('\n')

  test('keyframes only move transform, opacity and stroke-dashoffset', () => {
    const frames = keyframes(sheets)
    expect(frames.size).toBeGreaterThan(1)
    for (const [name, body] of frames) {
      const properties = [...body.matchAll(/([\w-]+)\s*:/g)].map((m) => m[1]!)
      for (const property of properties) {
        expect(['transform', 'opacity', 'stroke-dashoffset'], `@keyframes ${name} animates ${property}`).toContain(
          property,
        )
      }
    }
  })

  test('every @keyframes except the skeleton pulse is declared inside no-preference', () => {
    for (const name of ['app.css', 'shell.css']) {
      const css = read(name)
      for (const frame of keyframes(withoutNoPreference(css)).keys()) {
        expect(frame, `${name}: @keyframes ${frame}`).toBe('pulse')
      }
    }
  })

  test('every animation except the skeleton pulse is opt-in, and fills both ways', () => {
    const animated = declarations(sheets).filter((d) => d.property === 'animation' || d.property === 'animation-name')
    expect(animated.length).toBeGreaterThan(1)
    for (const d of animated) {
      const selector = d.within[d.within.length - 1]!
      if (selector === '.skeleton') continue
      expect(d.within.some((p) => NO_PREFERENCE.test(p)), `${selector} animates outside no-preference`).toBe(true)
      const rule = declarations(sheets).filter(
        (other) => other.within.join('|') === d.within.join('|'),
      )
      const both =
        /\bboth\b/.test(d.value) ||
        rule.some((other) => other.property === 'animation-fill-mode' && other.value === 'both')
      expect(both, `${selector} must use animation-fill-mode: both`).toBe(true)
    }
  })

  test('the sheet slides and fades in over --dur-sheet', () => {
    const entry = declarations(sheets).find(
      (d) => d.property === 'animation' && d.within[d.within.length - 1] === '.sheet[open]',
    )
    expect(entry?.value).toMatch(/var\(--dur-sheet\)/)
    const name = parts(entry!.value).find((p) => keyframes(sheets).has(p))!
    expect(keyframes(sheets).get(name)).toMatch(/translateY/)
    expect(keyframes(sheets).get(name)).toMatch(/opacity/)
  })

  test('the success cup’s whole timeline ends within --dur-celebrate', () => {
    const cup = declarations(sheets).filter(
      (d) => d.within.some((p) => NO_PREFERENCE.test(p)) && d.within[d.within.length - 1]!.includes('.success-cup'),
    )
    const ends: number[] = []
    for (const d of cup.filter((c) => c.property === 'animation')) {
      const [duration, delay] = parts(d.value).filter(isTime)
      const selector = d.within[d.within.length - 1]!
      const override = cup.find(
        (c) => c.property === 'animation-delay' && c.within[c.within.length - 1] !== selector &&
          subject(c.within[c.within.length - 1]!) === selector,
      )
      ends.push(timeMs(duration!) + (delay ? timeMs(delay) : 0))
      if (override) ends.push(timeMs(duration!) + timeMs(override.value))
    }
    // The pop, two steam strokes, the hole and the sparks.
    expect(ends.length).toBeGreaterThanOrEqual(5)
    expect(Math.max(...ends)).toBeLessThanOrEqual(tokenMs('--dur-celebrate'))
  })
})

describe('the global reduced-motion rule', () => {
  test('zeroes durations and delays, so nothing waits to appear', () => {
    const reduced = declarations(tokens()).filter((d) =>
      d.within.some((p) => /prefers-reduced-motion:\s*reduce/.test(p)),
    )
    const value = (property: string) => reduced.find((d) => d.property === property)?.value
    expect(value('animation-duration')).toMatch(/!important/)
    expect(value('animation-delay')).toMatch(/^0s\s*!important$/)
    expect(value('transition-delay')).toMatch(/^0s\s*!important$/)
  })

  test('creates no transitions of its own', () => {
    // 0.01ms still made a real transition on every element (transition-property
    // defaults to all), so a hover under the pointer registered as motion.
    const reduced = declarations(tokens()).filter((d) =>
      d.within.some((p) => /prefers-reduced-motion:\s*reduce/.test(p)),
    )
    expect(reduced.find((d) => d.property === 'transition-duration')?.value).toMatch(/^0s\s*!important$/)
  })
})
