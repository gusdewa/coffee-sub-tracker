import { ApiError, OfflineError } from '../api/client'

/**
 * Errors say what happened and what to do about it. They do not apologise and
 * they are never vague — a person standing at a coffee machine needs to know
 * whether to tap again or to go and find an admin.
 */
function explain(error: Error): string {
  if (error instanceof OfflineError) return 'No connection. Your cup was not counted.'
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'NO_BALANCE':
        return 'No cups left on any card.'
      case 'ALREADY_UNDONE':
        return 'That cup was already put back.'
      case 'UNDO_WINDOW_EXPIRED':
        return 'Too late to put that one back.'
      case 'NOT_ALLOWLISTED':
        return 'You are not on the coffee roster yet. Ask an admin to add you.'
      case 'MEMBER_DISABLED':
        return 'Your access has been turned off.'
      case 'WRONG_DOMAIN':
        return 'Sign in with your work Google account.'
      case 'RATE_LIMITED':
        return 'That is a lot of coffee. Try again in a minute.'
      case 'STORAGE_CONFLICT':
        return 'Someone else was drinking at the same moment. Try again.'
      default:
        return error.message
    }
  }
  return 'Something went wrong.'
}

export function ErrorState({
  error,
  onRetry,
  inline = false,
}: {
  error: Error
  onRetry: () => void
  inline?: boolean
}) {
  return (
    <div className={inline ? 'error error--inline' : 'error'} role="alert">
      <p className="error__text">{explain(error)}</p>
      <button type="button" className="error__retry" onClick={onRetry}>
        Try again
      </button>
    </div>
  )
}
