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
  const heading =
    balanceState === 'complete'
      ? 'Current balances:'
      : 'Full balance list unavailable.\nKnown balance:'
  return `${memberName} drank 1 cup from ${batchLabel}.\n\n${heading}\n${lines.join('\n')}`
}

export function whatsAppShareUrl(message: string): string {
  return `https://wa.me/?text=${encodeURIComponent(message)}`
}

export function navigateWhatsAppHandoff(handoff: Window | null, message: string): boolean {
  if (!handoff || handoff.closed) return false
  try {
    handoff.location.href = whatsAppShareUrl(message)
    return true
  } catch {
    // The member may close the inert window while the requests are in flight.
    handoff.close()
    return false
  }
}
