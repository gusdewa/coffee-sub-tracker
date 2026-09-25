import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'

/**
 * A modal sheet on the native <dialog>, rendered into document.body.
 *
 * Native because the browser then owns the hard parts: the top layer (no
 * z-index can put the update prompt or a fixed stack above it), an inert page
 * behind it, focus kept inside, and Escape / Android Back arriving as `cancel`
 * and `close`. Portaled so no ancestor's stacking context or overflow can clip
 * it before showModal() promotes it.
 *
 * Mounted means open. The parent closes a sheet by unmounting it, and learns
 * that the person wants it gone through onDismiss — at most once per open, so
 * every close path can report without a double dismissal reaching the store.
 *
 * The workarounds below are each for a real browser behaviour:
 * - Chrome 120+ lets a page prevent `cancel` only once per activation, then
 *   closes anyway. So `close` is handled too, and dismissal is idempotent.
 * - StrictMode (and any cleanup/remount) closes then reopens the same element;
 *   the `close` event from that cleanup arrives after the reopen. A `close`
 *   while the dialog is still open is therefore stale, and ignored.
 * - A drag that starts in the panel and ends on the backdrop is a click on the
 *   dialog. Only a press that also *started* on the backdrop dismisses.
 * - Engines without showModal() get an open, non-modal dialog marked
 *   `sheet--nonmodal`, rather than nothing at all.
 */

export type SheetDismissReason = 'escape' | 'backdrop' | 'close'

export interface SheetProps {
  /** Id of the visible title; a dialog must have an accessible name. */
  labelledBy: string
  describedBy?: string
  /** A native <dialog> is already role=dialog; only alertdialog is written out. */
  role?: 'dialog' | 'alertdialog'
  /** Focused (without scrolling) as soon as the dialog opens. */
  initialFocus: RefObject<HTMLElement>
  /** Where focus should land when the sheet goes away, if not back on the opener. */
  returnFocus?: () => HTMLElement | null
  onDismiss: (reason: SheetDismissReason) => void
  /** Light dismiss on a backdrop tap. Default true. */
  dismissOnBackdrop?: boolean
  variant?: 'bottom' | 'center'
  className?: string
  children: ReactNode
}

/**
 * Can focus actually land here? Not if it has gone from the page, is disabled,
 * sits under an inert ancestor (focus() is then silently ignored), or is inside
 * the sheet that is closing.
 */
function canTakeFocus(el: Element | null | undefined, sheet: Element): el is HTMLElement {
  return (
    el instanceof HTMLElement &&
    el.isConnected &&
    !sheet.contains(el) &&
    !el.matches(':disabled') &&
    el.closest('[inert]') === null
  )
}

export function Sheet({
  labelledBy,
  describedBy,
  role,
  initialFocus,
  returnFocus,
  onDismiss,
  dismissOnBackdrop = true,
  variant = 'bottom',
  className,
  children,
}: SheetProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [nonModal, setNonModal] = useState(false)
  const dismissed = useRef(false)
  const pressedOn = useRef<EventTarget | null>(null)
  /** undefined until the first open has looked; null when nothing had focus. */
  const opener = useRef<HTMLElement | null | undefined>(undefined)

  /*
   * The latest callbacks, read by listeners that are attached once per mount.
   * Putting them in the open/close effect's dependencies would close and
   * reopen the dialog whenever a parent passed a fresh arrow function.
   */
  const latest = useRef({ onDismiss, returnFocus })
  useLayoutEffect(() => {
    latest.current = { onDismiss, returnFocus }
  })

  const dismiss = useCallback((reason: SheetDismissReason) => {
    if (dismissed.current) return
    dismissed.current = true
    latest.current.onDismiss(reason)
  }, [])

  /*
   * Open and close with the mount, in a layout effect so the dialog is modal
   * and focused before the first paint. Deliberately runs once per mount:
   * `initialFocus` is only read on open.
   */
  useLayoutEffect(() => {
    const d = dialogRef.current
    if (!d) return
    dismissed.current = false
    // Read once per instance. StrictMode's rehearsal cleanup below moves focus
    // (to returnFocus() first), so re-reading on the remount would remember
    // that target and lose the element that really opened the sheet.
    if (opener.current === undefined) {
      const active = document.activeElement
      opener.current = active instanceof HTMLElement && active !== document.body ? active : null
    }

    const onCancel = (event: Event) => {
      // Keep it open: closing is the parent's decision, made by unmounting.
      event.preventDefault()
      dismiss('escape')
    }
    const onClose = () => {
      if (!d.open) dismiss('close')
    }
    d.addEventListener('cancel', onCancel)
    d.addEventListener('close', onClose)

    // Never pass `open` as a prop: React would set the attribute, and
    // showModal() on an already-open dialog throws.
    if (!d.open) {
      try {
        d.showModal()
      } catch {
        d.setAttribute('open', '')
        setNonModal(true)
      }
    }
    initialFocus.current?.focus({ preventScroll: true })

    return () => {
      d.removeEventListener('cancel', onCancel)
      d.removeEventListener('close', onClose)
      // Close first: while the modal is up the page behind it is inert, and
      // focus() there would be ignored.
      if (d.open) d.close()
      const candidates = [
        latest.current.returnFocus?.(),
        opener.current,
        document.querySelector('.fab:enabled'),
        document.querySelector('.app__main'),
      ]
      for (const el of candidates) {
        if (!canTakeFocus(el, d)) continue
        el.focus({ preventScroll: true })
        if (document.activeElement === el) return
      }
    }
  }, [])

  const classes = ['sheet', `sheet--${variant}`]
  if (nonModal) classes.push('sheet--nonmodal')
  if (className) classes.push(className)

  return createPortal(
    <dialog
      ref={dialogRef}
      className={classes.join(' ')}
      role={role === 'alertdialog' ? 'alertdialog' : undefined}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onPointerDown={(event) => {
        pressedOn.current = event.target
      }}
      onClick={(event) => {
        // The panel covers the whole box, so only the backdrop targets the
        // dialog itself — and only a press that began there counts.
        const startedOnBackdrop = pressedOn.current === event.currentTarget
        pressedOn.current = null
        if (dismissOnBackdrop && startedOnBackdrop && event.target === event.currentTarget) {
          dismiss('backdrop')
        }
      }}
      onKeyDown={(event) => {
        // A non-modal dialog gets no `cancel` from the browser.
        if (nonModal && event.key === 'Escape' && !event.defaultPrevented) dismiss('escape')
      }}
    >
      <div className="sheet__panel">{children}</div>
    </dialog>,
    document.body,
  )
}
