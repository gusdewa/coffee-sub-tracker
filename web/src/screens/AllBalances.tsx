import { useCallback, useEffect, useState } from 'react'
import { api, type BalanceRow } from '../api/client'
import { useCoffeeRevision } from '../state/coffee'
import { Skeleton } from '../components/Skeleton'
import { ErrorState } from '../components/ErrorState'

export function AllBalances() {
  const [rows, setRows] = useState<BalanceRow[] | null>(null)
  const [error, setError] = useState<Error | null>(null)

  const load = useCallback(async () => {
    try {
      setError(null)
      setRows((await api.balances()).balances)
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

  const most = Math.max(1, ...rows.map((r) => r.remaining))

  return (
    <div className="screen">
      <ul className="balances">
        {rows.map((r) => (
          <li key={r.memberId} className="balance">
            <span className="balance__name">{r.displayName}</span>
            <span className="balance__bar" aria-hidden="true">
              <span style={{ width: `${(r.remaining / most) * 100}%` }} />
            </span>
            <span className="balance__count tabular">{r.remaining}</span>
          </li>
        ))}
      </ul>
      {rows.length === 0 && <p className="empty">No one is on the roster yet.</p>}
    </div>
  )
}
