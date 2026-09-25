import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The palette, measured rather than eyeballed.
 *
 * A real browser running axe found four token-level contrast failures that
 * jsdom could never see, because jsdom does not paint: --ink-faint was 3.08:1
 * on white, and --punch as text on --punch-soft was 3.9:1. Both had shipped.
 * This is the guard that stops them coming back, in both colour schemes.
 *
 * WCAG 1.4.3 Contrast (Minimum), Level AA: 4.5:1 for normal text, 3:1 for
 * large text and for user-interface component boundaries.
 */

const TOKENS = readFileSync(resolve(__dirname, '../../src/styles/tokens.css'), 'utf8')

function palette(scheme: 'light' | 'dark'): Record<string, string> {
  const block =
    scheme === 'light'
      ? TOKENS.slice(TOKENS.indexOf(':root {'), TOKENS.indexOf('@media (prefers-color-scheme: dark)'))
      : TOKENS.slice(TOKENS.indexOf('@media (prefers-color-scheme: dark)'))
  const found: Record<string, string> = {}
  for (const [, name, value] of block.matchAll(/(--[a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    found[name!] = value!
  }
  return found
}

const channel = (v: number) => {
  const c = v / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

const luminance = (hex: string) => {
  const h = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(h.slice(i, i + 2), 16)))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)]
  const [hi, lo] = x! > y! ? [x!, y!] : [y!, x!]
  return (hi + 0.05) / (lo + 0.05)
}

/** foreground token, background token, minimum ratio, what it is used for */
const PAIRS: Array<[string, string, number, string]> = [
  ['--ink', '--paper', 4.5, 'body text'],
  ['--ink', '--paper-raised', 4.5, 'text on a card'],
  ['--ink-soft', '--paper', 4.5, 'secondary text'],
  ['--ink-soft', '--paper-raised', 4.5, 'secondary text on a card'],
  ['--ink-faint', '--paper', 4.5, 'dates, build id, footnotes'],
  ['--ink-faint', '--paper-raised', 4.5, 'card dates'],
  ['--punch-ink', '--punch-soft', 4.5, 'active dock icon, profile initials, next badge'],
  ['--punch-ink', '--paper-raised', 4.5, 'active dock label'],
  ['--punch', '--paper', 3, 'the balance number, large text'],
  ['--punch', '--paper-raised', 3, 'the 7-day bars and the success cup, on a card or sheet'],
  ['--alert', '--paper-raised', 4.5, 'sign out, inline errors'],
]

describe.each(['light', 'dark'] as const)('%s palette', (scheme) => {
  const tokens = palette(scheme)

  test('defines every colour it is asked for', () => {
    for (const [fg, bg] of PAIRS) {
      expect(tokens[fg], `${fg} missing in ${scheme}`).toBeTruthy()
      expect(tokens[bg], `${bg} missing in ${scheme}`).toBeTruthy()
    }
  })

  test.each(PAIRS)('%s on %s clears %s:1 — %s', (fg, bg, min) => {
    const ratio = contrast(tokens[fg]!, tokens[bg]!)
    expect(
      Number(ratio.toFixed(2)),
      `${fg} (${tokens[fg]}) on ${bg} (${tokens[bg]}) is ${ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(min)
  })
})

describe('colour-on-colour surfaces', () => {
  test('the Drink action and the alert carry their own ink safely', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const tokens = palette(scheme)
      for (const [ink, ground] of [
        ['--on-action', '--action'],
        ['--on-alert', '--alert'],
      ] as const) {
        expect(
          Number(contrast(tokens[ink]!, tokens[ground]!).toFixed(2)),
          `${ink} (${tokens[ink]}) on ${ground} (${tokens[ground]}) in ${scheme}`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  test('the update prompt and snackbar reverse out cleanly', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const tokens = palette(scheme)
      expect(
        Number(contrast(tokens['--paper']!, tokens['--ink']!).toFixed(2)),
        `--paper on --ink in ${scheme}`,
      ).toBeGreaterThanOrEqual(4.5)
    }
  })
})

/*
 * Tokens that pass mean nothing if a rule paints text in one that was never
 * meant for text. --spent is the colour of used-up things — a punched mark, a
 * disabled button — and at about 1.9:1 it is unreadable as type, which is how
 * the empty hero "0" shipped.
 */
describe('which colour each text rule uses', () => {
  const sheet = (name: string) =>
    readFileSync(resolve(__dirname, '../../src/styles/', name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

  const ruleBody = (css: string, selector: string) => {
    const at = css.indexOf(`${selector} {`)
    expect(at, `${selector} must exist`).toBeGreaterThanOrEqual(0)
    return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at))
  }

  test('no rule sets text in --spent', () => {
    for (const name of ['app.css', 'shell.css']) {
      const offenders = [...sheet(name).matchAll(/([^{}]+)\{[^}]*(?<![\w-])color:\s*var\(--spent\)[^}]*\}/g)].map(
        (m) => m[1]!.trim(),
      )
      expect(offenders, `${name}: text in --spent`).toEqual([])
    }
  })

  test('the empty hero "0" is set in --ink-faint, readable on the slip', () => {
    const body = ruleBody(sheet('app.css'), '.slip:has(.slip__next--empty) .slip__number')
    expect(body).toMatch(/(?<![\w-])color:\s*var\(--ink-faint\)/)
  })
})
