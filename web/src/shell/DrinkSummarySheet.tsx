import { useEffect, useId, useRef, useState } from 'react'
import type { AllocationView, HistoryItem, MeResponse } from '../api/client'
import { Sheet } from '../components/Sheet'
import { SafeSection } from '../components/SafeSection'
import { SuccessCup } from '../components/SuccessCup'
import { ChatIcon, PutBackIcon } from '../components/icons'
import { NEWER_CUP_COPY, putBackErrorCopy } from '../components/PunchCard'
import {
  formatUndoDeadline,
  jakartaWeekday,
  lastSevenDays,
  receiptDayCount,
  type Week,
} from '../insights/recent'
import { buildShareMessage } from '../sharing/whatsapp'
import { dismissReceipt, undoDrink, useCoffee, type DrinkReceipt } from '../state/coffee'
import { useHistory, type HistorySnapshot } from '../state/history'
import { useTeamBalances } from '../state/teamBalances'

const JAKARTA_CLOCK = {
  timeZone: 'Asia/Jakarta',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
} as const

/**
 * "09:12" in Jakarta, the clock the server keeps Put Back by, whatever zone the
 * phone is set to. Null for a missing or unparseable time, so a caller says
 * something true ("just now") instead of "Invalid Date".
 */
export function jakartaClock(instant: string | null): string | null {
  const ms = instant === null ? Number.NaN : Date.parse(instant)
  return Number.isFinite(ms) ? new Intl.DateTimeFormat(undefined, JAKARTA_CLOCK).format(ms) : null
}

const cups = (count: number) => (count === 1 ? 'cup' : 'cups')

/** The allocation the cup came off, by its row key or, from an older API, its batch. */
function cardOf(allocations: readonly AllocationView[], receipt: DrinkReceipt): AllocationView | undefined {
  if (receipt.allocRowKey) return allocations.find((a) => a.allocRowKey === receipt.allocRowKey)
  if (receipt.batchId) return allocations.find((a) => a.batchId === receipt.batchId)
  return undefined
}

/** The ledger's own account of this cup going back, wherever that happened. */
function reversedInHistory(items: readonly HistoryItem[] | null, opId: string): boolean {
  return (items ?? []).some((item) => item.type === 'CONSUME' && item.opId === opId && item.reversed === true)
}

/**
 * The summary after a Drink: `Drink 1`, the balance as it stands now, Put Back
 * for this exact cup, and a Share link the person may or may not tap.
 *
 * It opens on the store's receipt and closes by clearing it, so a Drink makes
 * one summary however it was tapped, and nothing here can make another Drink.
 * Everything below the heading reads live state: /api/me reconciling after the
 * Drink, or a Put Back from another device, shows up in the open sheet.
 */
export function DrinkSummarySheet() {
  const { receipt } = useCoffee()
  if (!receipt) return null
  // Keyed on the cup: a newer Drink starts clean — its own focus, share state
  // and figures — rather than inheriting the last one's.
  return <ReceiptSheet key={receipt.opId} receipt={receipt} />
}

function ReceiptSheet({ receipt }: { receipt: DrinkReceipt }) {
  const { data, undo, undoError, offline, busy } = useCoffee()
  const history = useHistory()
  const { refresh } = history

  /*
   * Put back by this device's request, or by the ledger's account of it. An
   * offer that simply ends proves nothing on its own: it also ends at the
   * deadline, and when the server refuses. Only a reversed history row, or the
   * store's own confirmed Put Back, turns this into "Cup put back".
   */
  const putBack = receipt.status === 'putBack' || reversedInHistory(history.items, receipt.opId)
  const counted = !putBack
  // Aborted as soon as the cup goes back: there is nothing left to share.
  const team = useTeamBalances(counted, receipt.opId)

  const headingRef = useRef<HTMLHeadingElement>(null)
  const titleId = useId()
  const balanceId = useId()
  const deadlineId = useId()
  const offlineId = useId()
  const disclosureId = useId()

  const ownsOffer = undo?.opId === receipt.opId
  const offerGone = undo === null

  // The offer left this cup with nothing newer taking it over: put back here or
  // elsewhere, expired, or refused. Ask the ledger now rather than on the next
  // poll, because only it can say which of those happened.
  const heldOffer = useRef(ownsOffer)
  useEffect(() => {
    const held = heldOffer.current
    heldOffer.current = ownsOffer
    if (!held || ownsOffer) return
    if (offerGone && receipt.status === 'counted') refresh()
    // Put Back may have had focus as it went (a refusal, the deadline, a newer
    // cup). Focus dropped on <body> is lost to a keyboard or screen reader, so
    // the heading picks it up; focus anywhere else was not ours to move.
    const active = document.activeElement
    if (active === null || active === document.body) headingRef.current?.focus({ preventScroll: true })
  }, [ownsOffer, offerGone, receipt.status, refresh])

  // The Put Back button has just gone from under focus; the new heading says why.
  const shownPutBack = useRef(putBack)
  useEffect(() => {
    if (putBack && !shownPutBack.current) headingRef.current?.focus({ preventScroll: true })
    shownPutBack.current = putBack
  }, [putBack])

  // Double-tap safe on top of the store's own busy guard: one tap, one undo.
  const sending = useRef(false)
  const putItBack = async () => {
    if (sending.current) return
    sending.current = true
    try {
      await undoDrink(receipt.opId)
    } finally {
      sending.current = false
    }
  }

  const [shared, setShared] = useState(false)
  const [copied, setCopied] = useState<{ message: string; ok: boolean } | null>(null)
  const canCopy = typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function'

  const share =
    counted && data
      ? buildShareMessage({
          memberName: receipt.memberName,
          memberId: receipt.memberId,
          batchLabel: receipt.batchLabel,
          liveRemaining: data.totalRemaining,
          team,
        })
      : null

  const copyMessage = async (message: string) => {
    try {
      await navigator.clipboard.writeText(message)
      setCopied({ message, ok: true })
    } catch {
      setCopied({ message, ok: false })
    }
  }
  // Only for the text on screen: once team balances arrive, the copy made
  // before them is no longer "the message".
  const copyStatus =
    share && copied?.message === share.message
      ? copied.ok
        ? 'Copied'
        : "Couldn't copy. Select the message above instead."
      : ''

  const time = jakartaClock(receipt.createdAt)
  const label = receipt.batchLabel.trim()
  const subline = counted
    ? ['Cup counted', time ?? 'just now', label].filter(Boolean).join(' · ')
    : [`Counted ${time ? `at ${time}` : 'just now'}, then put back`, label].filter(Boolean).join(' · ')

  const alert = counted && undoError?.opId === receipt.opId ? putBackErrorCopy(undoError.error) : ''
  // The alert may already be saying this; it should be said once.
  const newerCup = counted && undo !== null && !ownsOffer && alert !== NEWER_CUP_COPY

  return (
    <Sheet
      labelledBy={titleId}
      describedBy={data ? balanceId : undefined}
      initialFocus={headingRef}
      returnFocus={() => document.querySelector<HTMLElement>('.fab')}
      onDismiss={dismissReceipt}
      className="drink-summary"
    >
      {/* tabIndex: the one scroller in here must be reachable by keyboard. */}
      <div className="sheet__body" tabIndex={0}>
        <div className="sheet__header">
          {counted && <SuccessCup />}
          <div>
            <h2 id={titleId} ref={headingRef} tabIndex={-1} className="sheet__title">
              {counted ? 'Drink 1' : 'Cup put back'}
            </h2>
            <p className="sheet__subline">{subline}</p>
          </div>
        </div>

        {data && (
          <p id={balanceId} className="sheet__balance">
            <strong className="tabular">{data.totalRemaining}</strong> {cups(data.totalRemaining)} left now
          </p>
        )}
        {data && <CardLine data={data} receipt={receipt} counted={counted} />}

        {counted && ownsOffer && undo && (
          <div className="sheet__put-back">
            <button
              type="button"
              className="sheet__button"
              onClick={() => void putItBack()}
              disabled={offline}
              aria-disabled={busy || undefined}
              aria-describedby={offline ? `${deadlineId} ${offlineId}` : deadlineId}
            >
              <PutBackIcon />
              Put back this cup
            </button>
            <p id={deadlineId} className="sheet__caption">
              {formatUndoDeadline(undo.undoExpiresAt, Date.now())}
            </p>
            {offline && (
              <p id={offlineId} className="sheet__caption">
                You're offline. Put Back needs a connection.
              </p>
            )}
          </div>
        )}
        {newerCup && <p className="sheet__caption">{NEWER_CUP_COPY}</p>}
        {/* Mounted empty, so a failure is announced when it happens. */}
        <p className="put-back-error" role="alert">
          {alert}
        </p>

        {counted && (
          <SafeSection>
            <RecentActivity receipt={receipt} history={history} />
          </SafeSection>
        )}

        {/*
          In the scroller, not the footer: the footer never scrolls and the
          sheet clips at the viewport, so a team-length message opened down
          there would push Done out of reach on a short or landscape screen.
        */}
        {share && (
          <details className="sheet__preview">
            <summary>Preview message</summary>
            <pre className="sheet__message">{share.message}</pre>
            {canCopy && (
              <div className="sheet__copy">
                <button type="button" className="sheet__button" onClick={() => void copyMessage(share.message)}>
                  Copy message
                </button>
                <span className="sheet__caption" role="status">
                  {copyStatus}
                </span>
              </div>
            )}
          </details>
        )}
      </div>

      <div className="sheet__footer">
        {share && (
          <>
            <a
              className="sheet__share"
              href={share.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-describedby={disclosureId}
              // Record only. The browser follows the link from this very tap:
              // no preventDefault, no await, nothing that could lose it.
              onClick={() => setShared(true)}
            >
              <ChatIcon />
              Share to WhatsApp
            </a>
            <p id={disclosureId} className="sheet__caption sheet__disclosure">
              {share.disclosure}
            </p>
            {shared && <p className="sheet__caption">Didn't open? Copy the message instead.</p>}
          </>
        )}
        <button type="button" className="sheet__button sheet__button--primary" onClick={dismissReceipt}>
          Done
        </button>
      </div>
    </Sheet>
  )
}

/** Where the cup came off, from live allocations. Omitted when that is unknown. */
function CardLine({ data, receipt, counted }: { data: MeResponse; receipt: DrinkReceipt; counted: boolean }) {
  // The two "last cup" lines describe what this Drink just did, so they go
  // once the cup is back; the plain line is live state and stays.
  if (counted && data.totalRemaining === 0) {
    return <p className="sheet__card">That was your last cup. Ask an admin to add a subscription.</p>
  }
  const card = cardOf(data.allocations, receipt)
  if (!card) return null
  const label = card.batchLabel || receipt.batchLabel || 'Subscription'

  if (counted && card.remaining === 0) {
    // FIFO, over the same filtered list Home draws its cards and "next" from.
    const next = data.allocations.filter((a) => a.granted > 0).find((a) => a.remaining > 0)
    return (
      <p className="sheet__card">
        {`That was the last cup on ${label}. Next cup comes from ${next?.batchLabel || 'your oldest card'}.`}
      </p>
    )
  }

  const fill = card.granted > 0 ? Math.min(1, card.remaining / card.granted) : 0
  return (
    <div className="sheet__card">
      <p>{`${label} · ${card.remaining} of ${card.granted} left`}</p>
      <span className="sheet__bar" aria-hidden="true">
        <span style={{ width: `${Math.round(fill * 100)}%` }} />
      </span>
    </div>
  )
}

/**
 * A few figures from the member's own history, only when the page proves them.
 *
 * Unknown is left out rather than drawn as zeros: a page that does not hold
 * this cup (not yet indexed, or put back since) or cannot show where its day
 * began would make any count here a guess.
 */
function RecentActivity({ receipt, history }: { receipt: DrinkReceipt; history: HistorySnapshot }) {
  const titleId = useId()
  // Static on purpose: a pulsing skeleton inside a sheet that just animated in
  // is motion for its own sake, and this box only holds the space.
  if (history.loading) return <div className="sheet__recent sheet__recent--pending" aria-hidden="true" />
  if (!history.items) return null

  const now = Date.now()
  const day = receiptDayCount(history.items, receipt, { limit: history.limit, now })
  if (!day) return null
  const week = lastSevenDays(history.items, { now, limit: history.limit })

  return (
    <section className="sheet__recent" aria-labelledby={titleId}>
      <h3 id={titleId} className="sheet__recent-title">
        Recent activity
      </h3>
      <p className="sheet__recent-count">
        {`${day.cups} ${cups(day.cups)} ${day.isToday ? 'today' : `on ${day.weekday}`}`}
      </p>
      {week.kind === 'known' && <RecentWeekSlot week={week} />}
    </section>
  )
}

/**
 * The slot the seven-day bars (RecentBars) fill. Until they land it carries
 * their text alternative only, so the week is already there for a screen
 * reader and the bars can arrive without changing what is announced.
 */
function RecentWeekSlot({ week }: { week: Extract<Week, { kind: 'known' }> }) {
  const days = week.days.map((d) =>
    d.isToday
      ? `today ${d.cups} ${cups(d.cups)}`
      : // The key is the Jakarta date, so its UTC midnight names the right weekday.
        `${jakartaWeekday(Date.parse(d.key), 'short')} ${d.cups}`,
  )
  return <p className="visually-hidden">{`Last 7 days: ${days.join(', ')}`}</p>
}
