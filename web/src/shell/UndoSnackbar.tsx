import { useCoffee } from '../state/coffee'

/** A ten-second success announcement, independent of server undo eligibility. */
export function UndoSnackbar() {
  const { notice } = useCoffee()
  if (!notice) return null

  return (
    <div className="snackbar" role="status" aria-live="polite">
      <span className="snackbar__text">{notice.text}</span>
    </div>
  )
}
