import type { BalanceRow } from '../api/client'

export interface CoffeeRecap {
  memberName: string
  batchLabel: string
  balances: BalanceRow[]
}

const cups = (count: number) => `${count} ${count === 1 ? 'cup' : 'cups'}`

/** A plain-text recap; wa.me leaves the destination chat for the user to choose. */
export function formatCoffeeRecap({ memberName, batchLabel, balances }: CoffeeRecap): string {
  const lines = balances.map(({ displayName, remaining }) => `${displayName}: ${cups(remaining)}`)
  return `${memberName} drank 1 cup from ${batchLabel}.\n\nCurrent balances:\n${lines.join('\n')}`
}

export function whatsAppShareUrl(message: string): string {
  return `https://wa.me/?text=${encodeURIComponent(message)}`
}

export function navigateWhatsAppHandoff(handoff: Window | null, message: string): void {
  if (!handoff || handoff.closed) return
  try {
    handoff.location.href = whatsAppShareUrl(message)
  } catch {
    // The member may close the inert window while the requests are in flight.
    handoff.close()
  }
}
