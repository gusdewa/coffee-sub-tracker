import { describe, test, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/**
 * A tripwire for the blank white tab.
 *
 * Every Drink used to open `about:blank` inside the tap and navigate it to
 * wa.me once the Drink, a paint wait and a balances read had all finished. A
 * phone that hid the app, or a read that never answered, left the person
 * staring at the blank page. The fix is structural: the app never opens or
 * steers a window on its own. The only way to WhatsApp is a real link the
 * person taps, which the browser follows.
 *
 * Source-level on purpose. The failure is a pattern that can come back in any
 * file, not a behaviour of one component, so every file under src/ is read.
 */

const SRC = resolve(__dirname, '../../src')

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

/**
 * Comments explaining why something is never done are not doing it. Line
 * comments are stripped only where `//` is not part of a URL like https://.
 */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const FORBIDDEN: [string, RegExp][] = [
  ['window.open(', /window\.open\s*\(/],
  ['location.assign', /location\.assign\b/],
  ['location.replace(', /location\.replace\s*\(/],
  ['location.href =', /location\.href\s*=(?!=)/],
  ["'_self'", /['"`]_self['"`]/],
  // The placeholder page itself: nothing may open, or point a link at, a blank page.
  ['about:blank', /about:blank/],
]

describe('nothing navigates on its own', () => {
  const sources = filesUnder(SRC).map((path) => ({ file: relative(SRC, path), text: code(path) }))

  test('the scan actually reads the app', () => {
    // A path mistake would make every check below pass vacuously.
    expect(sources.map(({ file }) => file)).toEqual(
      expect.arrayContaining(['App.tsx', 'shell/DrinkFab.tsx', 'sharing/whatsapp.ts']),
    )
  })

  test.each(FORBIDDEN)('no %s anywhere in src/', (_label, pattern) => {
    const offenders = sources.filter(({ text }) => pattern.test(text)).map(({ file }) => file)
    expect(offenders).toEqual([])
  })

  test('the popup reservation is gone from the sharing module', async () => {
    const sharing: Record<string, unknown> = await import('../../src/sharing/whatsapp')
    for (const name of [
      'reserveWhatsAppHandoffWindow',
      'navigateWhatsAppHandoff',
      'WHATSAPP_HANDOFF_WINDOW_NAME',
    ]) {
      expect(sharing, `${name} must not be exported`).not.toHaveProperty(name)
    }
    // A type leaves nothing at runtime, so its name is checked in the source.
    expect(code(join(SRC, 'sharing/whatsapp.ts'))).not.toMatch(/WhatsAppHandoffReservation/)
  })
})
