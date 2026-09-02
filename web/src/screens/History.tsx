import { useEffect, useState } from 'react'
import { api, type HistoryItem } from '../api/client'
import { Skeleton } from '../components/Skeleton'
import { ErrorState } from '../components/ErrorState'

const VERB: Record<string, string> = {
  CONSUME: 'Drank one',
  REVERSAL: 'Put one back',
  CORRECTION: 'Adjusted',
  GRANT: 'Added',
}

export function History() {
  const [items, setItems] = useState<HistoryItem[] | null>(null)
  const [error, setError] = useState<Error | null>(null)

  const load = async () => {
    try {
      setError(null)
      setItems((await api.history()).items)
    } catch (err) {
      setError(err as Error)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  if (error) return <ErrorState error={error} onRetry={load} />
  if (!items) return <Skeleton />

  return (
    <div className="screen">
      <h2 className="screen__title">History</h2>
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
