import { useCoffee, undoDrink } from '../state/coffee'

/**
 * The 10 seconds in which the interface offers to put a cup back.
 *
 * It rides above the dock rather than sitting inside one screen, because the
 * undo now outlives the screen that created it. There is deliberately no
 * dismiss control: it is a single line, the main column already reserves the
 * room, and the only thing a dismiss would offer is a way to throw the undo
 * away by accident.
 *
 * This is also the announcement. My Coffee used to keep a separate
 * visually-hidden aria-live region, which said the same thing twice to a screen
 * reader once the snackbar existed.
 */
export function UndoSnackbar() {
  const { undo, busy } = useCoffee()
  if (!undo) return null

  return (
    <div className="snackbar" role="status" aria-live="polite">
      <span className="snackbar__text">One cup from {undo.batchLabel}.</span>
      <button
        type="button"
        className="snackbar__action"
        onClick={() => void undoDrink()}
        disabled={busy}
      >
        Put it back
      </button>
    </div>
  )
}
