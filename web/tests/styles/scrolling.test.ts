import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * One scroll owner, and a bottom clearance derived from the things that
 * actually float over it.
 *
 * The document used to be the scroller, with the dock fixed on top of it and
 * <main> padded by hand to compensate. That works until a second fixed layer
 * appears — and there are now four: the dock, the update prompt, the Drink
 * action and the snackbar. The shell is a flex column, <main> owns the scroll,
 * and every offset is computed from shared variables so nothing is counted
 * twice or missed.
 */

const css = (name: string) =>
  readFileSync(resolve(__dirname, '../../src/styles/', name), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  )

const rule = (sheet: string, selector: string): string => {
  const found = sheet.match(
    new RegExp(`(^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm'),
  )
  return found?.[2] ?? ''
}

const shell = () => css('shell.css')
const app = () => css('app.css')

describe('the scroll contract', () => {
  test('the shell fills the viewport without the document scrolling', () => {
    const decl = rule(app(), '.app')
    expect(decl).toMatch(/min-height:\s*100svh/)
    expect(decl).toMatch(/height:\s*100dvh/)
    expect(decl).toMatch(/display:\s*flex/)
  })

  test('<main> is the scroll owner', () => {
    const decl = rule(app(), '.app__main')
    expect(decl).toMatch(/overflow-y:\s*auto/)
    expect(decl).toMatch(/overscroll-behavior-y:\s*contain/)
    // Without min-height:0 a flex child refuses to shrink and the page scrolls
    // behind the dock instead of inside the column.
    expect(decl).toMatch(/min-height:\s*0/)
  })

  test('there is exactly one scroll owner in the signed-in shell', () => {
    const owners = [...(app() + shell()).matchAll(/([^{}]+)\{[^}]*overflow-y:\s*auto[^}]*\}/g)]
      .map((m) => m[1]!.trim().split('\n').pop()!.trim())
      // The login screen is its own page and never coexists with the shell.
      .filter((sel) => !sel.startsWith('.login'))
    expect(owners).toEqual(['.app__main'])
  })

  test('bottom clearance is derived once, and reused for scrolling', () => {
    const decl = rule(app(), '.app__main')
    expect(decl).toMatch(/padding-bottom:\s*var\(--overlay-clearance\)/)
    // Focus must land above the floating action, not behind it (WCAG 2.4.11).
    expect(decl).toMatch(/scroll-padding-bottom:\s*var\(--overlay-clearance\)/)
    expect(decl).toMatch(/scroll-padding-top/)
  })

  test('the clearance counts the floating layers and not the dock', () => {
    // The dock is in flow, so it is outside the scroller and must not be added
    // again — that was the double-count the old fixed layout invited.
    const decl = rule(app(), '.app')
    expect(decl).toMatch(/--overlay-clearance:/)
    expect(decl).toMatch(/var\(--update-h\)/)
    expect(decl).toMatch(/var\(--fab-height\)/)
    expect(decl).not.toMatch(/--overlay-clearance:[^;]*--dock-height/)
  })

  test('a visible snackbar widens the clearance rather than overlapping content', () => {
    expect(app()).toMatch(/\.app:has\(\.snackbar\)[^{]*\{[^}]*--overlay-clearance:/)
  })

  test('the dock participates in layout instead of floating over the scroller', () => {
    expect(rule(shell(), '.dock')).not.toMatch(/position:\s*fixed/)
  })

  test('landscape keeps the left and right safe areas', () => {
    expect(app() + shell()).toMatch(/env\(safe-area-inset-left\)/)
    expect(app() + shell()).toMatch(/env\(safe-area-inset-right\)/)
  })
})

describe('the login screen scrolls rather than clipping', () => {
  test('it sizes to the viewport and scrolls when it cannot fit', () => {
    const decl = rule(shell(), '.login')
    expect(decl).toMatch(/min-height:\s*100svh/)
    expect(decl).toMatch(/min-height:\s*100dvh/)
    expect(decl).toMatch(/overflow-y:\s*auto/)
  })

  test('it centres by auto margin, never by translating off its own box', () => {
    // top:50% + transform centring clips the top of anything taller than the
    // viewport, which is exactly what happens at 200% text in landscape.
    const sheet = shell()
    expect(rule(sheet, '.login')).not.toMatch(/position:\s*absolute/)
    expect(rule(sheet, '.login__card')).toMatch(/margin:\s*auto/)
    expect(sheet).not.toMatch(/transform:\s*translate\(-50%,\s*-50%\)/)
  })

  test('it pads for the safe area on every edge', () => {
    const decl = rule(shell(), '.login')
    for (const side of ['top', 'bottom', 'left', 'right']) {
      expect(decl, `safe-area-inset-${side}`).toMatch(
        new RegExp(`env\\(safe-area-inset-${side}\\)`),
      )
    }
  })
})

describe('the viewport is never locked', () => {
  test('pinch zoom stays available', () => {
    const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8')
    const viewport = html.match(/<meta name="viewport"[^>]*>/)![0]
    expect(viewport).toContain('viewport-fit=cover')
    expect(viewport).not.toMatch(/maximum-scale/)
    expect(viewport).not.toMatch(/user-scalable\s*=\s*no/)
  })
})
