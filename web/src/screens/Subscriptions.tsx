import { useEffect, useState } from 'react'
import { api, type BatchRow } from '../api/client'
import { Skeleton } from '../components/Skeleton'
import { ErrorState } from '../components/ErrorState'

export function Subscriptions() {
  const [rows, setRows] = useState<BatchRow[] | null>(null)
  const [error, setError] = useState<Error | null>(null)

  const load = async () => {
    try {
      setError(null)
      setRows((await api.batches()).batches)
    } catch (err) {
      setError(err as Error)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  if (error) return <ErrorState error={error} onRetry={load} />
  if (!rows) return <Skeleton />

  return (
    <div className="screen">
      <h2 className="screen__title">Subscriptions</h2>
      {rows.length === 0 ? (
        <p className="empty">No subscriptions have been bought yet.</p>
      ) : (
        <ul className="batches">
          {rows.map((b) => (
            <li key={b.batchId} className="batch">
              <span className="batch__label">{b.label}</span>
              <span className="batch__meta">
                {new Date(b.effectiveAt).toLocaleDateString(undefined, {
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                })}
              </span>
              <span className="batch__units tabular">{b.totalUnits} cups</span>
              {b.status !== 'active' && <span className="batch__warn">Still being set up</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
