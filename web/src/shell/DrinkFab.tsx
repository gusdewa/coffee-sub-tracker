import { useState } from 'react'
import { useCoffee, drink, loadMe, wasDrinkUndone } from '../state/coffee'
import { api } from '../api/client'
import { CoffeeCupIcon } from '../components/icons'
import { ErrorState } from '../components/ErrorState'
import {
  formatCoffeeRecap,
  navigateWhatsAppHandoff,
  whatsAppShareUrl,
} from '../sharing/whatsapp'

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
  const [shareUrl, setShareUrl] = useState<string | null>(null)

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

  const handleDrink = async () => {
    setShareUrl(null)
    // Open synchronously while this handler still has the trusted click. wa.me
    // cannot target Cart Coffee (temp); it will ask the member to choose a chat.
    const handoff = window.open('about:blank', 'coffee-whatsapp-share')
    if (handoff) handoff.opener = null
    const result = await drink()
    if (!result) {
      handoff?.close()
      return
    }
    if (!data) return

    let balances
    let balanceState: 'complete' | 'partial' = 'complete'
    try {
      balances = (await api.balances()).balances
    } catch {
      // Consumption already succeeded. Fall back to the only current balance
      // we can state truthfully, and explicitly disclose that the list is partial.
      balanceState = 'partial'
      balances = [
        {
          memberId: data.member.memberId,
          displayName: data.member.displayName,
          remaining: result.remainingTotal,
        },
      ]
    }

    // Undo and the recap request run independently. Never hand off a message
    // about a cup that was successfully put back while balances were loading.
    if (wasDrinkUndone(result.opId)) {
      handoff?.close()
      return
    }

    const message = formatCoffeeRecap({
      memberName: data.member.displayName,
      batchLabel: result.batchLabel,
      balances,
      balanceState,
    })
    if (!navigateWhatsAppHandoff(handoff, message)) {
      setShareUrl(whatsAppShareUrl(message))
    }
  }

  return (
    <>
      {error && <ErrorState error={error} onRetry={() => void loadMe()} inline />}
      {shareUrl && (
        <a className="whatsapp-fallback" href={shareUrl} target="_blank" rel="noreferrer">
          Open WhatsApp
        </a>
      )}
      <button
        type="button"
        className="fab"
        data-tour="drink"
        onClick={() => void handleDrink()}
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
