import { useEffect, useRef } from 'react'
import { ApiError, type AllocationView } from '../api/client'
import { PutBackIcon } from './icons'

const MAX_MARKS = 24

/** Where Put Back lives once a newer cup has taken the offer over. */
export const NEWER_CUP_COPY = 'A newer cup was counted — put it back from its card.'

/**
 * What a failed Put Back means, in the words both the card and the post-Drink
 * summary use. Only the two refusals are definite. Anything else — no answer,
 * or an answer this copy does not know — may have reversed the cup on the
 * server all the same, so it claims neither outcome and sends the person to
 * their balance instead of inviting a blind second tap.
 */
export function putBackErrorCopy(error: Error): string {
  if (error instanceof ApiError && error.code === 'UNDO_WINDOW_EXPIRED') {
    return 'Too late to put this one back — it stays counted.'
  }
  if (error instanceof ApiError && error.code === 'NOT_LATEST_CONSUME') return NEWER_CUP_COPY
  return "Couldn't reach the server — check your balance before trying again."
}

export function PunchCard({
  allocation,
  isNext,
  canPutBack = false,
  putBackBusy = false,
  putBackError = null,
  onPutBack,
}: {
  allocation: AllocationView
  isNext: boolean
  canPutBack?: boolean
  putBackBusy?: boolean
  /** Why this card's last Put Back failed; shown here, beside the cup it was for. */
  putBackError?: Error | null
  onPutBack?: () => void
}) {
  const { granted, consumed, remaining, batchLabel } = allocation
  const tooMany = granted > MAX_MARKS
  const marks = tooMany ? [] : Array.from({ length: granted }, (_, i) => i < consumed)
  const date = new Date(allocation.effectiveAt).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  })
  const label = batchLabel || 'Subscription'

  /*
   * Put Back goes from under the finger once it works (or is refused). Focus
   * dropped on <body> is lost to a keyboard or screen reader, so the card's
   * own title picks it up — only after this card's button was pressed, so an
   * offer that merely lapses never moves anyone's focus.
   */
  const titleRef = useRef<HTMLHeadingElement>(null)
  const pressed = useRef(false)
  useEffect(() => {
    if (canPutBack || !pressed.current) return
    pressed.current = false
    const active = document.activeElement
    if (active === null || active === document.body) titleRef.current?.focus()
  }, [canPutBack])

  return (
    <article className={`card${isNext ? ' card--next' : ''}${remaining === 0 ? ' card--spent' : ''}`}>
      <header className="card__head">
        <h3 className="card__title" ref={titleRef} tabIndex={-1}>
          {label}
        </h3>
        {canPutBack && (
          <button
            type="button"
            className="card__put-back"
            aria-label={`Put back cup from ${label}`}
            title={`Put back cup from ${label}`}
            onClick={() => {
              pressed.current = true
              onPutBack?.()
            }}
            disabled={putBackBusy}
          >
            <PutBackIcon />
          </button>
        )}
      </header>

      {tooMany ? (
        <p className="card__bulk tabular"><strong>{remaining}</strong> of {granted} left</p>
      ) : (
        <ul className="card__marks" aria-hidden="true">
          {marks.map((spent, i) => <li key={i} className={`mark${spent ? ' mark--spent' : ''}`} />)}
        </ul>
      )}

      <p className="card__count">
        <span className="card__meta">
          <span className="card__date">{date}</span>
          <span aria-hidden="true" className="tabular">{` · ${remaining}/${granted}`}</span>
          <span className="visually-hidden">{remaining} of {granted} cups remaining from {batchLabel}</span>
        </span>
        {isNext && remaining > 0 && <span className="card__next">next</span>}
      </p>

      {putBackError && (
        <p className="put-back-error card__put-back-error" role="alert">
          {putBackErrorCopy(putBackError)}
        </p>
      )}
    </article>
  )
}
