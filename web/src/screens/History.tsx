import { useHistory } from '../state/history'
import { Skeleton } from '../components/Skeleton'
import { ErrorState } from '../components/ErrorState'

const VERB: Record<string, string> = {
  CONSUME: 'Drank one',
  REVERSAL: 'Put one back',
  CORRECTION: 'Adjusted',
  GRANT: 'Added',
}

export function History() {
  // The shared page re-reads when a cup is taken or put back anywhere in the
  // app, or on another device; without it this screen keeps showing a number
  // the FAB has already changed. The rows stay up while it re-reads.
  const { items, error, refresh } = useHistory()

  if (error) return <ErrorState error={error} onRetry={refresh} />
  if (!items) return <Skeleton />

  return (
    <div className="screen">
      {items.length === 0 ? (
        <p className="empty">Nothing yet. Your first cup will show up here.</p>
      ) : (
        <ol className="history">
          {items.map((it) => (
            <li key={it.opId} className={`entry${it.reversed ? ' entry--reversed' : ''}`}>
              <span className="entry__what">
                {VERB[it.type] ?? it.type}
                {it.batchLabel && <span className="entry__batch"> · {it.batchLabel}</span>}
              </span>
              {it.reason && <span className="entry__reason">{it.reason}</span>}
              <span className="entry__when">
                {new Date(it.createdAt).toLocaleString(undefined, {
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
              <span className={`entry__delta tabular${it.delta > 0 ? ' entry__delta--up' : ''}`}>
                {it.delta > 0 ? `+${it.delta}` : it.delta}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
