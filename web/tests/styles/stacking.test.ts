import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * One place decides what covers what.
 *
 * Before this, the whole app had two z-indexes — `.action` at 2 and `.update`
 * at 60 — and `.nav` had none at all. Both fixed layers were pinned to the same
 * `bottom`, so the update toast landed on top of the Drink button. A dock, a
 * FAB, a snackbar, a menu and a tour overlay cannot be reasoned about one
 * declaration at a time, so the ladder lives in tokens and nothing may opt out.
 */

const css = (name: string) =>
  readFileSync(resolve(__dirname, '../../src/styles/', name), 'utf8')

/** Prose about z-index is not a z-index. Scan declarations only. */
const declarations = (name: string) => css(name).replace(/\/\*[\s\S]*?\*\//g, '')

const LADDER = [
  '--z-header',
  '--z-dock',
  '--z-fab',
  '--z-snackbar',
  '--z-update',
  '--z-menu',
  '--z-tour',
  '--z-tour-card',
  '--z-dialog',
] as const

describe('stacking contract', () => {
  test('every layer is named in tokens.css', () => {
    const tokens = css('tokens.css')
    for (const name of LADDER) {
      expect(tokens, `${name} must be defined`).toMatch(
        new RegExp(`${name}:\\s*\\d+`),
      )
    }
  })

  test('the ladder is strictly ascending in the order it is documented', () => {
    const tokens = css('tokens.css')
    const values = LADDER.map((name) => {
      const m = tokens.match(new RegExp(`${name}:\\s*(\\d+)`))
      return Number(m![1])
    })
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i], `${LADDER[i]} must sit above ${LADDER[i - 1]}`).toBeGreaterThan(
        values[i - 1]!,
      )
    }
  })

  test('--z-update stays at 60', () => {
    // Pinned: the e2e suite asserts `.update` by class and by copy, and the
    // shell is built around the prompt keeping its level rather than moving.
    expect(css('tokens.css')).toMatch(/--z-update:\s*60/)
  })

  test('no stylesheet sets a raw z-index', () => {
    for (const name of ['tokens.css', 'app.css', 'shell.css']) {
      const raw = [...declarations(name).matchAll(/z-index:\s*([^;]+);/g)]
        .map((m) => m[1]!.trim())
        .filter((v) => !v.startsWith('var(--z-'))
      expect(raw, `${name} must use --z-* tokens, found: ${raw.join(', ')}`).toEqual([])
    }
  })
})
