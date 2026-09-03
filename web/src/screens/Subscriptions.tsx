import { useCallback, useEffect, useState } from 'react'
import { api, type BatchRow } from '../api/client'
import { useCoffeeRevision } from '../state/coffee'
import { Skeleton } from '../components/Skeleton'
import { ErrorState } from '../components/ErrorState'

export function Subscriptions() {
  const [rows, setRows] = useState<BatchRow[] | null>(null)
  const [error, setError] = useState<Error | null>(null)

  const load = useCallback(async () => {
    try {
      setError(null)
      setRows((await api.batches()).batches)
    } catch (err) {
      setError(err as Error)
    }
  }, [])

  // Re-reads when a cup is taken or put back anywhere in the app; without it
  // this screen keeps showing a number the FAB has already changed.
  const revision = useCoffeeRevision()
  useEffect(() => {
    void load()
  }, [load, revision])

  if (error) return <ErrorState error={error} onRetry={load} />
  if (!rows) return <Skeleton />

  return (
    <div className="screen">
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
