import { useEffect, useRef, useState } from 'react'
import { useCoffee, drink, loadMe, wasDrinkUndone } from '../state/coffee'
import { api } from '../api/client'
import { CoffeeCupIcon } from '../components/icons'
import { ErrorState } from '../components/ErrorState'
import {
  formatCoffeeRecap,
  navigateWhatsAppHandoff,
  reserveWhatsAppHandoffWindow,
  whatsAppShareUrl,
} from '../sharing/whatsapp'

/** Resolve only after React's success state has had a browser paint opportunity. */
function afterVisiblePaint(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') {
    return new Promise((resolve) => setTimeout(resolve, 0))
  }
  return new Promise((resolve) => {
    // One frame runs before paint. The second frame proves the committed
    // success state had a paint opportunity before WhatsApp takes focus.
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

export function DrinkFab() {
  const { data, busy, offline, error, undo } = useCoffee()
  const [shareUrl, setShareUrl] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [duplicateWarning, setDuplicateWarning] = useState(false)
  const submitting = useRef(false)
  const cancelButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (confirming) cancelButton.current?.focus()
  }, [confirming])

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
    setConfirming(false)
    setShareUrl(null)
    // Reservation and idempotency-key creation occur only for a confirmed intent.
    const reserved = reserveWhatsAppHandoffWindow()
    try {
      const member = data?.member
      const result = await drink({ confirmedAnother })
      if (!result || !member) {
        reserved?.close()
        return
      }

      // The exact success announcement is now committed. Yield through a frame
      // and task boundary so it paints before any WhatsApp navigation.
      await afterVisiblePaint()
      if (wasDrinkUndone(result.opId)) {
        reserved?.close()
        return
      }

      let balances
      let balanceState: 'complete' | 'partial' = 'complete'
      try {
        balances = (await api.balances()).balances
      } catch {
        balanceState = 'partial'
        balances = [{
          memberId: member.memberId,
          displayName: member.displayName,
          remaining: result.remainingTotal,
        }]
      }

      if (wasDrinkUndone(result.opId)) {
        reserved?.close()
        return
      }

      const message = formatCoffeeRecap({
        memberName: member.displayName,
        batchLabel: result.batchLabel,
        balances,
        balanceState,
      })
      const url = whatsAppShareUrl(message)
      if (!reserved?.navigate(url) && !navigateWhatsAppHandoff(message)) setShareUrl(url)
    } finally {
      submitting.current = false
    }
  }

  const requestDrink = () => {
    if (busy || submitting.current) {
      setDuplicateWarning(true)
      return
    }
    if (undo) {
      setConfirming(true)
      return
    }
    void performDrink()
  }

  return (
    <>
      {error && <ErrorState error={error} onRetry={() => void loadMe()} inline />}
      {duplicateWarning && (
        <p className="drink-duplicate-warning" role="alert">
          Drink is already being counted.
        </p>
      )}
      {shareUrl && (
        <a className="whatsapp-fallback" href={shareUrl} target="_blank" rel="noreferrer">
          Open WhatsApp
        </a>
      )}
      <button
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
        <div
          className="drink-confirm__backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setConfirming(false)
          }}
        >
          <section
            className="drink-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="drink-confirm-title"
            onKeyDown={(event) => {
              if (event.key === 'Escape') setConfirming(false)
            }}
          >
            <h2 id="drink-confirm-title">Drink another?</h2>
            <p>You just counted a drink. Count one more cup?</p>
            <div className="drink-confirm__actions">
              <button ref={cancelButton} type="button" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button type="button" className="drink-confirm__accept" onClick={() => void performDrink(true)}>
                Drink another
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  )
}
