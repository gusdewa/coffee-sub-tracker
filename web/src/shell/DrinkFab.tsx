import { useCoffee, drink } from '../state/coffee'
import { CoffeeCupIcon } from '../components/icons'
import { ErrorState } from '../components/ErrorState'

/**
 * One tap, from anywhere.
 *
 * Drinking used to exist only on the My Coffee route, because the mutation was
 * that screen's local state. It is the thing the app is for, so it follows you.
 *
 * The label is always rendered. An unlabelled cup glyph is a guess, and the one
 * irreversible-feeling action in the app is a poor place to make people guess —
 * the 90-second undo notwithstanding.
 */
export function DrinkFab() {
  const { data, busy, offline, error } = useCoffee()

  const loading = data === null
  const empty = data !== null && data.totalRemaining === 0

  /*
   * Offline wins over an empty balance: if we cannot reach the server, we do
   * not actually know the balance, so that is the more honest thing to say.
   * README claimed this was already the behaviour; the button never checked.
   */
  const help = offline
    ? "You're offline. Cups can't be counted right now."
    : loading
      ? 'Loading your balance.'
      : empty
        ? 'You have no cups remaining.'
        : null

  return (
    <>
      {error && <ErrorState error={error} onRetry={() => void drink()} inline />}
      <button
        type="button"
        className="fab"
        data-tour="drink"
        onClick={() => void drink()}
        disabled={busy || loading || empty || offline}
        aria-busy={busy}
        aria-describedby={help ? 'fab-help' : undefined}
      >
        <CoffeeCupIcon />
        <span className="fab__label">{busy ? 'Working…' : 'Drink'}</span>
      </button>
      {/* Outside the button: help explains the state, it is not part of the name. */}
      {help && (
        <span id="fab-help" className="visually-hidden">
          {help}
        </span>
      )}
    </>
  )
}
