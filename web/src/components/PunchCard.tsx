import type { AllocationView } from '../api/client'

/**
 * A subscription batch, drawn as the punch card it actually is.
 *
 * Filled marks are cups you still have; struck marks are cups you have drunk.
 * The card the next drink will come from carries a "next" marker — which makes
 * the FIFO rule visible instead of something the user has to be told.
 */

const MAX_MARKS = 24

export function PunchCard({
  allocation,
  isNext,
}: {
  allocation: AllocationView
  isNext: boolean
}) {
  const { granted, consumed, remaining, batchLabel } = allocation
  const tooMany = granted > MAX_MARKS

  const marks = tooMany
    ? []
    : Array.from({ length: granted }, (_, i) => i < consumed)

  const date = new Date(allocation.effectiveAt).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  })

  return (
    <article className={`card${isNext ? ' card--next' : ''}${remaining === 0 ? ' card--spent' : ''}`}>
      <header className="card__head">
        {/* h2: the route title in the app header is the page h1. */}
        <h2 className="card__title">{batchLabel || 'Subscription'}</h2>
        <span className="card__date">{date}</span>
      </header>

      {tooMany ? (
        <p className="card__bulk tabular">
          <strong>{remaining}</strong> of {granted} left
        </p>
      ) : (
        <ul className="card__marks" aria-hidden="true">
          {marks.map((spent, i) => (
            <li key={i} className={`mark${spent ? ' mark--spent' : ''}`} />
          ))}
        </ul>
      )}

      <p className="card__count">
        <span className="visually-hidden">
          {remaining} of {granted} cups remaining from {batchLabel}
        </span>
        <span aria-hidden="true" className="tabular">
          {remaining}/{granted}
        </span>
        {isNext && remaining > 0 && <span className="card__next">next</span>}
      </p>
    </article>
  )
}
