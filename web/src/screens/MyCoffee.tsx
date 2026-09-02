import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, OfflineError, type MeResponse } from '../api/client'
import { PunchCard } from '../components/PunchCard'
import { Skeleton } from '../components/Skeleton'
import { ErrorState } from '../components/ErrorState'

/**
 * The one screen that matters: how many cups are left, and one way to spend one.
 *
 * The button is disabled while a request is in flight, which stops a double
 * tap client-side — but the server's idempotency key is the real guarantee,
 * and the key is generated once per press so a retry reuses it.
 */

const UNDO_SECONDS = 90

export function MyCoffee() {
  const [data, setData] = useState<MeResponse | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [busy, setBusy] = useState(false)
  const [undo, setUndo] = useState<{ opId: string; until: number } | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const undoTimer = useRef<number | undefined>(undefined)

  const load = useCallback(async () => {
    try {
      setError(null)
      setData(await api.me())
    } catch (err) {
      setError(err as Error)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => () => window.clearTimeout(undoTimer.current), [])

  const drink = async () => {
    if (busy || !data || data.totalRemaining === 0) return
    setBusy(true)
    setError(null)
    // One key per intent. A retry of this press must reuse it.
    const key = crypto.randomUUID()
    try {
      const result = await api.drink(key)
      setData((d) => (d ? { ...d, totalRemaining: result.remainingTotal } : d))
      setAnnouncement(`One cup from ${result.batchLabel}. ${result.remainingTotal} left.`)
      setUndo({ opId: result.opId, until: Date.now() + UNDO_SECONDS * 1000 })
      undoTimer.current = window.setTimeout(() => setUndo(null), UNDO_SECONDS * 1000)
      void load()
    } catch (err) {
      setError(err as Error)
    } finally {
      setBusy(false)
    }
  }

  const undoDrink = async () => {
    if (!undo) return
    setBusy(true)
    try {
      const result = await api.undo(undo.opId, crypto.randomUUID())
      setUndo(null)
      window.clearTimeout(undoTimer.current)
      setAnnouncement(`Put back. ${result.remainingTotal} left.`)
      void load()
    } catch (err) {
      setError(err as Error)
    } finally {
      setBusy(false)
    }
  }

  if (!data && !error) return <Skeleton />
  if (!data) return <ErrorState error={error!} onRetry={load} />

  const empty = data.totalRemaining === 0
  const nextIndex = data.allocations.findIndex((a) => a.remaining > 0)

  return (
    <div className="screen">
      <p className="greeting">{data.member.displayName}</p>

      <div className="hero">
        <span className="hero__number tabular">{data.totalRemaining}</span>
        <span className="hero__unit">{data.totalRemaining === 1 ? 'cup left' : 'cups left'}</span>
      </div>

      <p aria-live="polite" className="visually-hidden">
        {announcement}
      </p>

      {error && <ErrorState error={error} onRetry={load} inline />}

      {empty ? (
        <p className="empty">
          Nothing left on any card. Ask an admin to add a subscription.
        </p>
      ) : (
        <div className="cards">
          {data.allocations
            .filter((a) => a.granted > 0)
            .map((a, i) => (
              <PunchCard key={a.batchId + a.effectiveAt} allocation={a} isNext={i === nextIndex} />
            ))}
        </div>
      )}

      <div className="action">
        {undo ? (
          <button type="button" className="undo" onClick={undoDrink} disabled={busy}>
            Put it back
          </button>
        ) : (
          <span className="action__spacer" />
        )}
        <button
          type="button"
          className="drink"
          onClick={drink}
          disabled={busy || empty}
          aria-describedby={empty ? 'empty-help' : undefined}
        >
          {busy ? 'Working…' : 'Drink 1'}
        </button>
        {empty && (
          <span id="empty-help" className="visually-hidden">
            You have no cups remaining.
          </span>
        )}
      </div>
    </div>
  )
}
