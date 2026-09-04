import type { AllocationView } from '../api/client'
import { PutBackIcon } from './icons'

const MAX_MARKS = 24

export function PunchCard({
  allocation,
  isNext,
  canPutBack = false,
  putBackBusy = false,
  onPutBack,
}: {
  allocation: AllocationView
  isNext: boolean
  canPutBack?: boolean
  putBackBusy?: boolean
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

  return (
    <article className={`card${isNext ? ' card--next' : ''}${remaining === 0 ? ' card--spent' : ''}`}>
      <header className="card__head">
        <h3 className="card__title">{label}</h3>
        <span className="card__date">{date}</span>
      </header>

      {tooMany ? (
        <p className="card__bulk tabular"><strong>{remaining}</strong> of {granted} left</p>
      ) : (
        <ul className="card__marks" aria-hidden="true">
          {marks.map((spent, i) => <li key={i} className={`mark${spent ? ' mark--spent' : ''}`} />)}
        </ul>
      )}

      <p className="card__count">
        <span className="visually-hidden">{remaining} of {granted} cups remaining from {batchLabel}</span>
        <span aria-hidden="true" className="tabular">{remaining}/{granted}</span>
        {isNext && remaining > 0 && <span className="card__next">next</span>}
      </p>

      {canPutBack && (
        <button
          type="button"
          className="card__put-back"
          aria-label={`Put back cup from ${label}`}
          title={`Put back cup from ${label}`}
          onClick={onPutBack}
          disabled={putBackBusy}
        >
          <PutBackIcon />
        </button>
      )}
    </article>
  )
}
