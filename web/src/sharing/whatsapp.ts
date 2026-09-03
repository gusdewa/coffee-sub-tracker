import type { BalanceRow } from '../api/client'

export interface CoffeeRecap {
  memberName: string
  batchLabel: string
  balances: BalanceRow[]
  balanceState?: 'complete' | 'partial'
}

const cups = (count: number) => `${count} ${count === 1 ? 'cup' : 'cups'}`

/** A plain-text recap; wa.me leaves the destination chat for the user to choose. */
export function formatCoffeeRecap({
  memberName,
  batchLabel,
  balances,
  balanceState = 'complete',
}: CoffeeRecap): string {
  const lines = balances.map(({ displayName, remaining }) => `${displayName}: ${cups(remaining)}`)
  const total = balances.reduce((sum, { remaining }) => sum + remaining, 0)
  const heading =
    balanceState === 'complete'
      ? 'Current balances:'
      : 'Full balance list unavailable.\nKnown balance:'
  const totalLine = balanceState === 'complete' ? `\nTotal remaining: ${cups(total)}` : ''
  return `Cart Coffee\n${memberName} drank 1 cup from ${batchLabel}.\n\n${heading}\n${lines.join('\n')}${totalLine}`
}

export function whatsAppShareUrl(message: string): string {
  return `https://wa.me/?text=${encodeURIComponent(message)}`
}

/**
 * The stable name of the reserved handoff context. A fixed name means repeated
 * drinks reuse one secondary tab instead of spawning one per cup, and that a
 * leftover tab from a crashed session is adopted rather than duplicated.
 */
export const WHATSAPP_HANDOFF_WINDOW_NAME = 'coffee-sub-wa-handoff'

export interface WhatsAppHandoffReservation {
  /** Navigate the reserved context; false if it is no longer usable. */
  navigate(url: string): boolean
  /** Reclaim the reserved context without ever having navigated it. */
  close(): void
}

/**
 * Reserve the secondary context for the WhatsApp jump, synchronously with the
 * trusted Drink click.
 *
 * The mutation that has to succeed first is asynchronous, and by the time it
 * resolves the user activation is gone — a `window.open` then would be
 * popup-blocked, which is what made the previous same-context navigation the
 * only "safe" option and cost the PWA its document on every handoff. Opening a
 * named context during the click keeps the activation, leaves the app's window
 * untouched, and defers the actual wa.me navigation until the recap is real.
 *
 * Deliberately no `noopener` window feature: with it `window.open` returns
 * null, losing the very handle being reserved. The opener is severed
 * explicitly instead, which the fresh about:blank document (same-origin)
 * allows.
 */
export function reserveWhatsAppHandoffWindow(
  name = WHATSAPP_HANDOFF_WINDOW_NAME,
): WhatsAppHandoffReservation | null {
  let opened: Window | null
  try {
    opened = window.open('', name)
  } catch {
    // Blocked outright by a popup policy or embedded context restriction.
    return null
  }
  if (!opened) return null

  const reserved: Window = opened
  try {
    reserved.opener = null
  } catch {
    // The named context was already navigated cross-origin (for example a
    // previous handoff landed in WhatsApp); nothing here to sever.
  }

  return {
    navigate(url: string): boolean {
      try {
        reserved.location.assign(url)
        return true
      } catch {
        // The context navigated away or was closed mid-flight.
        return false
      }
    },
    close(): void {
      try {
        reserved.close()
      } catch {
        // Already closed by the person or the browser; nothing to reclaim.
      }
    },
  }
}

/**
 * Same-context fallback for when the reservation itself was blocked. It cannot
 * be popup-blocked, but it does replace the app's document — which is exactly
 * why it is the fallback and not the plan.
 */
export function navigateWhatsAppHandoff(message: string): boolean {
  try {
    const handoff = document.createElement('a')
    handoff.href = whatsAppShareUrl(message)
    handoff.target = '_self'
    handoff.click()
    return true
  } catch {
    return false
  }
}
