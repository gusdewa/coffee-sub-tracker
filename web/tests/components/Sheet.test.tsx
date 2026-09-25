import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { StrictMode, useRef } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import axe from 'axe-core'
import type { SheetProps } from '../../src/components/Sheet'

/**
 * The native <dialog> primitive under every sheet in the app.
 *
 * jsdom has no top layer, no inertness and no focus restoration, and its
 * dialog methods come from the polyfill in tests/setup.ts. So these tests pin
 * down what the component itself owns: when it opens, who it tells that it was
 * dismissed (and how many times), and where focus goes afterwards. What the
 * browser owns — the backdrop painting, the inert page — is left to the
 * Playwright pass.
 */

const { Sheet } = await import('../../src/components/Sheet')

type SheetOverrides = Partial<Omit<SheetProps, 'labelledBy' | 'initialFocus' | 'children'>>

const onDismiss = vi.fn<SheetProps['onDismiss']>()

function Harness({
  open,
  opener = true,
  openerDisabled = false,
  sheet = {},
}: {
  open: boolean
  opener?: boolean
  openerDisabled?: boolean
  sheet?: SheetOverrides
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  return (
    <main>
      {opener && (
        <button type="button" disabled={openerDisabled}>
          Open sheet
        </button>
      )}
      {open && (
        <Sheet
          labelledBy="sheet-title"
          describedBy="sheet-desc"
          initialFocus={heading}
          onDismiss={onDismiss}
          {...sheet}
        >
          <h2 id="sheet-title" tabIndex={-1} ref={heading}>
            Drink 1
          </h2>
          <p id="sheet-desc">4 cups left now</p>
          <button type="button">Done</button>
        </Sheet>
      )}
    </main>
  )
}

type HarnessState = Omit<Parameters<typeof Harness>[0], 'sheet'>

/**
 * Render closed, focus the opener, then open — the order a real tap produces,
 * so the sheet has an opener to remember.
 */
function openSheet(sheet: SheetOverrides = {}, wrap: 'strict' | 'plain' = 'plain') {
  const tree = (state: HarnessState, props: SheetOverrides = sheet) =>
    wrap === 'strict' ? (
      <StrictMode>
        <Harness {...state} sheet={props} />
      </StrictMode>
    ) : (
      <Harness {...state} sheet={props} />
    )
  const view = render(tree({ open: false }))
  const opener = screen.getByRole('button', { name: 'Open sheet' })
  opener.focus()
  view.rerender(tree({ open: true }))
  const dialog = document.querySelector('dialog')
  if (!dialog) throw new Error('the sheet did not render a <dialog>')
  return {
    view,
    opener,
    dialog,
    heading: screen.getByText('Drink 1'),
    /** Re-render; pass `props` to give the open sheet new props, as a parent would. */
    update: (state: HarnessState, props?: SheetOverrides) => view.rerender(tree(state, props)),
  }
}

/**
 * Let the polyfill's queued `close` event land. Browsers queue it as a task;
 * the polyfill uses a microtask (see tests/setup.ts). Either way it arrives
 * after the code that called close() has finished.
 */
const settle = () =>
  act(async () => {
    await Promise.resolve()
  })

/** Page furniture the focus chain falls back to, added outside React. */
const furniture: Element[] = []
function addToPage(html: string): HTMLElement {
  const holder = document.createElement('div')
  holder.innerHTML = html
  const el = holder.firstElementChild as HTMLElement
  document.body.append(el)
  furniture.push(el)
  return el
}

beforeEach(() => onDismiss.mockReset())

afterEach(() => {
  vi.restoreAllMocks()
  for (const el of furniture.splice(0)) el.remove()
})

describe('Sheet — opening', () => {
  test('opens as a modal and focuses the initialFocus element', () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal')
    const { dialog, heading } = openSheet()

    expect(showModal).toHaveBeenCalledTimes(1)
    expect(dialog).toHaveAttribute('open')
    expect(dialog).not.toHaveClass('sheet--nonmodal')
    expect(heading).toHaveFocus()
    // A native <dialog> is already role=dialog; restating it is noise.
    expect(dialog).not.toHaveAttribute('role')
    expect(screen.getByRole('dialog', { name: 'Drink 1' })).toBe(dialog)
    expect(dialog).toHaveAccessibleDescription('4 cups left now')
    expect(onDismiss).not.toHaveBeenCalled()
  })

  test('content is portaled into document.body inside a panel that covers it', () => {
    const { view, dialog, heading } = openSheet()

    expect(view.container.querySelector('dialog')).toBeNull()
    expect(dialog.parentElement).toBe(document.body)
    const panel = dialog.firstElementChild
    expect(panel).toHaveClass('sheet__panel')
    expect(dialog.children).toHaveLength(1)
    expect(panel).toContainElement(heading)
  })

  test('the class list carries the variant and any extra class', () => {
    const { dialog } = openSheet({ variant: 'center', className: 'drink-confirm' })
    expect(dialog.className).toBe('sheet sheet--center drink-confirm')
  })

  test('the variant defaults to a bottom sheet', () => {
    const { dialog } = openSheet()
    expect(dialog.className).toBe('sheet sheet--bottom')
  })

  test("role='alertdialog' is exposed with the accessible name from labelledBy", () => {
    const { dialog } = openSheet({ role: 'alertdialog' })
    expect(dialog).toHaveAttribute('role', 'alertdialog')
    expect(screen.getByRole('alertdialog', { name: 'Drink 1' })).toBe(dialog)
  })

  test('falls back to a non-modal open dialog when showModal throws', () => {
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(() => {
      throw new DOMException('Not supported here', 'NotSupportedError')
    })
    const { dialog, heading } = openSheet()

    expect(dialog).toHaveAttribute('open')
    expect(dialog).toHaveClass('sheet', 'sheet--bottom', 'sheet--nonmodal')
    expect(heading).toHaveFocus()
    expect(onDismiss).not.toHaveBeenCalled()
  })

  test('the non-modal marker survives a re-render that changes the class list', () => {
    // React rewrites `className` wholesale when it changes, so a class added
    // straight onto the element would be wiped and the fallback's z-index lost.
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(() => {
      throw new DOMException('Not supported here', 'NotSupportedError')
    })
    const { dialog, update } = openSheet()

    update({ open: true }, { variant: 'center', className: 'drink-confirm' })
    expect(dialog).toHaveClass('sheet--center', 'drink-confirm', 'sheet--nonmodal')
    expect(dialog).toHaveAttribute('open')
  })

  test('the non-modal fallback still dismisses on Escape', () => {
    // No modal means no native `cancel`; Escape must not become a dead key.
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(() => {
      throw new TypeError('showModal is not a function')
    })
    const { heading } = openSheet()

    fireEvent.keyDown(heading, { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledWith('escape')
  })
})

describe('Sheet — dismissing', () => {
  test("Escape dismisses exactly once with reason 'escape', even if pressed twice", async () => {
    const { dialog, heading } = openSheet()

    fireEvent.keyDown(heading, { key: 'Escape' })
    fireEvent.keyDown(heading, { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledWith('escape')
    // The cancel was prevented: closing is the parent's call, by unmounting.
    expect(dialog).toHaveAttribute('open')

    // Chrome 120+ lets a page prevent `cancel` only once per activation and
    // then closes the dialog anyway. That forced close is the same dismissal.
    act(() => dialog.close())
    await settle()
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  test('a stale close event while the dialog is still open is ignored', async () => {
    const { dialog } = openSheet()

    dialog.dispatchEvent(new Event('close'))
    await settle()
    expect(onDismiss).not.toHaveBeenCalled()
    expect(dialog).toHaveAttribute('open')
  })

  test("a close with no cancel before it still dismisses, with reason 'close'", async () => {
    // Escape and Android Back always send `cancel` first; this is the safety
    // net for any other way the dialog ends up closed under the component.
    const { dialog } = openSheet()

    act(() => dialog.close())
    await settle()
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledWith('close')
  })

  test('after the browser has closed it, unmounting neither closes again nor reports again, and still returns focus', async () => {
    // The Chrome path: a second Escape without a tap in between sends a
    // cancel that cannot be prevented, and the browser closes the dialog
    // before the parent has unmounted it.
    const { dialog, opener, update } = openSheet()
    act(() => dialog.close())
    await settle()
    const close = vi.spyOn(dialog, 'close')

    update({ open: false })
    await settle()
    expect(close).not.toHaveBeenCalled()
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(opener).toHaveFocus()
  })

  test('re-rendering with fresh callbacks neither reopens the dialog nor calls a stale one', () => {
    // Parents pass inline arrows. If the open effect depended on them, every
    // render would close and reopen the dialog and re-steal focus.
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal')
    const first = vi.fn<SheetProps['onDismiss']>()
    const target = addToPage('<button type="button">Card title</button>')
    const { dialog, heading, update } = openSheet({ onDismiss: first })
    const close = vi.spyOn(dialog, 'close')
    const latest = vi.fn<SheetProps['onDismiss']>()

    update({ open: true }, { onDismiss: latest, returnFocus: () => target })
    expect(showModal).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
    expect(heading).toHaveFocus()

    fireEvent.keyDown(heading, { key: 'Escape' })
    expect(first).not.toHaveBeenCalled()
    expect(latest).toHaveBeenCalledWith('escape')

    update({ open: false }, { onDismiss: latest, returnFocus: () => target })
    expect(target).toHaveFocus()
  })

  test('a tap on the backdrop (pointerdown and click on the dialog) dismisses', () => {
    const { dialog } = openSheet()

    fireEvent.pointerDown(dialog)
    fireEvent.click(dialog)
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledWith('backdrop')
  })

  test('a drag starting inside the panel and ending on the backdrop does not dismiss', () => {
    const { dialog } = openSheet()

    // The browser sends the click to the common ancestor: the dialog itself.
    fireEvent.pointerDown(screen.getByText('4 cups left now'))
    fireEvent.click(dialog)
    // Taps inside the panel never count either.
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Done' }))
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onDismiss).not.toHaveBeenCalled()
  })

  test('dismissOnBackdrop=false ignores the backdrop', () => {
    const { dialog } = openSheet({ dismissOnBackdrop: false })

    fireEvent.pointerDown(dialog)
    fireEvent.click(dialog)
    expect(onDismiss).not.toHaveBeenCalled()
  })

  test('survives a <StrictMode> double mount: open, focused and not dismissed', async () => {
    const { dialog, heading, opener, update } = openSheet({}, 'strict')
    await settle()

    expect(dialog).toHaveAttribute('open')
    expect(heading).toHaveFocus()
    expect(onDismiss).not.toHaveBeenCalled()

    // The remount re-armed the listeners and the once-only guard.
    fireEvent.keyDown(heading, { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledWith('escape')

    update({ open: false })
    expect(opener).toHaveFocus()
  })

  test("<StrictMode>'s rehearsal unmount does not replace the real opener", async () => {
    // The rehearsal cleanup moves focus to returnFocus(). If the remount then
    // re-read document.activeElement, that target would be remembered as the
    // opener, and the element that really opened the sheet would drop out of
    // the chain.
    const target = addToPage('<button type="button">Card title</button>')
    const { opener, heading, update } = openSheet({ returnFocus: () => target }, 'strict')
    await settle()
    expect(heading).toHaveFocus()

    target.remove()
    update({ open: false })
    expect(opener).toHaveFocus()
  })

  test('unmounting closes the dialog, then returns focus, without reporting a dismissal', async () => {
    const { dialog, opener, update } = openSheet()
    const close = vi.spyOn(dialog, 'close')
    const focus = vi.spyOn(opener, 'focus')

    update({ open: false })
    await settle()
    expect(close).toHaveBeenCalledTimes(1)
    // In a browser the page behind an open modal is inert and ignores focus();
    // jsdom cannot show that, so pin the order instead.
    expect(focus).toHaveBeenCalledTimes(1)
    expect(close.mock.invocationCallOrder[0]!).toBeLessThan(focus.mock.invocationCallOrder[0]!)
    expect(opener).toHaveFocus()
    expect(onDismiss).not.toHaveBeenCalled()
  })
})

describe('Sheet — returning focus on unmount', () => {
  test('goes to returnFocus() first', () => {
    const target = addToPage('<button type="button">Card title</button>')
    const { update } = openSheet({ returnFocus: () => target })

    update({ open: false })
    expect(target).toHaveFocus()
  })

  test('falls back to the opener when returnFocus() has nothing usable', () => {
    const inert = addToPage('<div inert><button type="button">Behind</button></div>')
    const { opener, heading, update } = openSheet({
      returnFocus: () => inert.querySelector('button'),
    })
    expect(heading).toHaveFocus()

    update({ open: false })
    expect(opener).toHaveFocus()
  })

  test('falls back to the opener when there is no returnFocus', () => {
    const { opener, heading, update } = openSheet()
    expect(heading).toHaveFocus()

    update({ open: false })
    expect(opener).toHaveFocus()
  })

  test.each([
    ['disabled', { opener: true, openerDisabled: true }],
    ['removed', { opener: false }],
  ] as const)('falls back to .fab:enabled when the opener is %s', (_, change) => {
    const fab = addToPage('<button type="button" class="fab">Drink</button>')
    const { update } = openSheet()

    update({ open: true, ...change })
    update({ open: false, ...change })
    expect(fab).toHaveFocus()
  })

  test('lands on .app__main when neither the opener nor Drink can take focus', () => {
    addToPage('<button type="button" class="fab" disabled>Drink</button>')
    const main = addToPage('<div class="app__main" tabindex="0">Home</div>')
    const { update } = openSheet()

    update({ open: true, opener: false })
    update({ open: false, opener: false })
    expect(main).toHaveFocus()
  })
})

describe('Sheet — accessibility', () => {
  // Contrast is excluded because jsdom does not paint; Playwright checks it.
  const RULES = { rules: { 'color-contrast': { enabled: false } } }

  test.each(['dialog', 'alertdialog'] as const)(
    'axe finds no violations with role=%s',
    async (role) => {
      openSheet({ role })
      const results = await axe.run(document.body, RULES)
      expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])
    },
  )
})
