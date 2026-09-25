import type { BalanceRow } from '../api/client'

export interface CoffeeRecap {
  memberName: string
  /** Optional because older API responses may omit it during a rolling deploy. */
  batchLabel?: string | null
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
  // A partial recap only ever carries the drinker's own row, so it must not
  // look like a balance list the group could mistake for everyone's state; the
  // row keeps a label so its "4 cups" still reads as a balance, not cups drunk.
  const heading =
    balanceState === 'complete' ? 'Current balances:' : 'Team balances not included.\nKnown balance:'
  const totalLine = balanceState === 'complete' ? `\nTotal remaining: ${cups(total)}` : ''
  // No label (older API response, blank batch) drops the clause rather than
  // inventing a source: the group reads this in the third person, so a stand-in
  // like "from your card" would point at the reader's card.
  const label = batchLabel?.trim()
  const source = label ? ` from ${label}` : ''
  return `Cart Coffee\n${memberName} drank 1 cup${source}.\n\n${heading}\n${lines.join('\n')}${totalLine}`
}

export function whatsAppShareUrl(message: string): string {
  return `https://wa.me/?text=${encodeURIComponent(message)}`
}

/**
 * Where the team balance list stands when the share is built. Owned here, not
 * by the balances hook, so the message builder stays a pure function of its
 * inputs; `useTeamBalances` reports this exact shape.
 */
export type TeamState =
  | { status: 'loading' }
  | { status: 'ready'; rows: BalanceRow[] }
  | { status: 'unavailable'; reason: 'timeout' | 'error' }

export interface ShareMessageInput {
  memberName: string
  memberId: string
  batchLabel?: string | null
  /** The drinker's remaining cups from live store state, not from /api/balances. */
  liveRemaining: number
  team: TeamState
}

export interface ShareMessage {
  message: string
  url: string
  balanceState: 'complete' | 'partial'
  /** The caption shown beside Share; describes exactly what `message` contains. */
  disclosure: string
}

/**
 * The drinker's own row always carries the live number, in the server's order.
 *
 * /api/balances filters QA members out, and its row for the drinker can predate
 * the Drink that just succeeded, so it is replaced (or appended) from live
 * state rather than trusted.
 */
function withLiveSelf(rows: readonly BalanceRow[], self: BalanceRow): BalanceRow[] {
  const at = rows.findIndex(({ memberId }) => memberId === self.memberId)
  const others = rows.filter(({ memberId }) => memberId !== self.memberId)
  if (at === -1) return [...others, self]
  return [...others.slice(0, at), self, ...others.slice(at)]
}

/**
 * The Share to WhatsApp message and its caption, derived together from one set
 * of inputs so the caption can never promise more than the message carries.
 */
export function buildShareMessage({
  memberName,
  memberId,
  batchLabel,
  liveRemaining,
  team,
}: ShareMessageInput): ShareMessage {
  const self: BalanceRow = { memberId, displayName: memberName, remaining: liveRemaining }

  let balances: BalanceRow[]
  let balanceState: ShareMessage['balanceState']
  let disclosure: string
  if (team.status === 'ready') {
    balances = withLiveSelf(team.rows, self)
    balanceState = 'complete'
    const people = balances.length === 1 ? 'person' : 'people'
    disclosure = `Includes team balances for ${balances.length} ${people}`
  } else {
    balances = [self]
    balanceState = 'partial'
    disclosure =
      team.status === 'loading'
        ? 'Shares your balance only (team balances still loading)'
        : 'Team balances unavailable — shares your balance only'
  }

  const message = formatCoffeeRecap({ memberName, batchLabel, balances, balanceState })
  return { message, url: whatsAppShareUrl(message), balanceState, disclosure }
}
