import { useEffect, useState } from 'react'
import { api, type BalanceRow } from '../api/client'
import { Skeleton } from '../components/Skeleton'
import { ErrorState } from '../components/ErrorState'

export function AllBalances() {
  const [rows, setRows] = useState<BalanceRow[] | null>(null)
  const [error, setError] = useState<Error | null>(null)

  const load = async () => {
    try {
      setError(null)
      setRows((await api.balances()).balances)
    } catch (err) {
      setError(err as Error)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  if (error) return <ErrorState error={error} onRetry={load} />
  if (!rows) return <Skeleton />

  const most = Math.max(1, ...rows.map((r) => r.remaining))

  return (
    <div className="screen">
      <h2 className="screen__title">Everyone</h2>
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
