import { useEffect, useId, useRef, useState } from 'react'
import { useCoffee, drink, loadMe, type UndoOffer } from '../state/coffee'
import { CoffeeCupIcon } from '../components/icons'
import { ErrorState } from '../components/ErrorState'
import { Sheet } from '../components/Sheet'
import { jakartaClock } from './DrinkSummarySheet'

/**
 * How long a Drink may be out before the person is told it is still going.
 * There is deliberately no client-side timeout: aborting a POST that the
 * server may already have committed would invite exactly the second tap this
 * message exists to prevent.
 */
const STILL_COUNTING_AFTER_MS = 8_000
const STILL_COUNTING = 'Still counting — no need to tap again.'

/** "Drink another?" copy, naming the cup already counted so the question is answerable. */
function anotherCupCopy(offer: UndoOffer): string {
  const time = jakartaClock(offer.createdAt)
  if (time === null) return 'You already counted a cup today. Count one more?'
  const label = offer.batchLabel.trim()
  return `You counted a cup at ${time}${label ? ` from ${label}` : ''}. Count one more?`
}

/**
 * The one Drink action, reachable from every screen.
 *
 * A tap records the cup and nothing else. What happens next — `Drink 1`, the
 * balance, Put Back, sharing — belongs to the summary sheet the store's
 * receipt opens. This component never opens a window, follows a link, waits
 * for a paint or reads team balances: each of those, done here, is what used
 * to leave a blank tab in front of the app.
 */
export function DrinkFab() {
  const { data, busy, offline, error, undo } = useCoffee()
  /** The offer this warning is about, kept as it was when the warning opened. */
  const [confirming, setConfirming] = useState<UndoOffer | null>(null)
  const [duplicateWarning, setDuplicateWarning] = useState(false)
  const [counting, setCounting] = useState(false)
  const [slow, setSlow] = useState(false)
  const submitting = useRef(false)
  const fabRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const bodyId = useId()

  // Only this button's own Drink counts: the store is also busy while a Put
  // Back is out, and "still counting" would be the wrong thing to say then.
  useEffect(() => {
    setSlow(false)
    if (!counting) return
    const timer = window.setTimeout(() => setSlow(true), STILL_COUNTING_AFTER_MS)
    return () => window.clearTimeout(timer)
  }, [counting])

  const loading = data === null
  const empty = data !== null && data.totalRemaining === 0
  const help = offline
    ? "You're offline. Cups can't be counted right now."
    : loading
      ? 'Loading your balance.'
      : empty
        ? 'You have no cups remaining.'
        : null

  const performDrink = async (confirmedAnother = false) => {
    if (submitting.current) return
    submitting.current = true
    setDuplicateWarning(false)
    setConfirming(null)
    setCounting(true)
    try {
      await drink({ confirmedAnother })
    } finally {
      submitting.current = false
      setCounting(false)
    }
  }

  const requestDrink = () => {
    if (busy || submitting.current) {
      setDuplicateWarning(true)
      return
    }
    if (undo) {
      setConfirming(undo)
      return
    }
    void performDrink()
  }

  const stillCounting = counting && slow

  return (
    <>
      {error && <ErrorState error={error} onRetry={() => void loadMe()} inline />}
      {duplicateWarning && (
        <p className="drink-duplicate-warning" role="alert">
          Drink is already being counted.
        </p>
      )}
      {/*
        Mounted from the start and empty, so the words are announced when they
        arrive. The visible copy is hidden from assistive tech: the status
        already says it, once.
      */}
      <p className="visually-hidden" role="status">
        {stillCounting ? STILL_COUNTING : null}
      </p>
      {stillCounting && (
        <p className="drink-slow" aria-hidden="true">
          {STILL_COUNTING}
        </p>
      )}
      <button
        ref={fabRef}
        type="button"
        className="fab"
        data-tour="drink"
        onClick={requestDrink}
        disabled={loading || empty || offline}
        aria-disabled={busy}
        aria-busy={busy}
        aria-describedby={help ? 'fab-help' : undefined}
      >
        <CoffeeCupIcon />
        <span className="fab__label">{busy ? 'Working…' : 'Drink'}</span>
      </button>
      {help && <span id="fab-help" className="visually-hidden">{help}</span>}

      {confirming && (
        <Sheet
          role="alertdialog"
          variant="bottom"
          className="drink-confirm"
          labelledBy={titleId}
          describedBy={bodyId}
          initialFocus={cancelRef}
          returnFocus={() => fabRef.current}
          dismissOnBackdrop
          onDismiss={() => setConfirming(null)}
        >
          {/* A scroller like the summary's, so 200% text in landscape clips nothing. */}
          <div className="sheet__body" tabIndex={0}>
            <h2 id={titleId} className="sheet__title">
              Drink another?
            </h2>
            <p id={bodyId} className="drink-confirm__copy">
              {anotherCupCopy(confirming)}
            </p>
          </div>
          <div className="sheet__footer drink-confirm__actions">
            {/* Cancel first and focused: the safe answer is the default one. */}
            <button
              ref={cancelRef}
              type="button"
              className="sheet__button"
              onClick={() => setConfirming(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="sheet__button sheet__button--primary"
              onClick={() => void performDrink(true)}
            >
              Drink another
            </button>
          </div>
        </Sheet>
      )}
    </>
  )
}
