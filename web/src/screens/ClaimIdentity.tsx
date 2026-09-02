import { useEffect, useState } from 'react'
import { api, ApiError, type ClaimCandidate } from '../api/client'
import { Skeleton } from '../components/Skeleton'
import { ErrorState } from '../components/ErrorState'

/**
 * First sign-in: bind this Google account to the person it belongs to.
 *
 * The list is only ever the *pending* members, and the highlighted one is a
 * prediction from the Google display name — a shortcut, not a decision. The
 * person confirms, and an admin can correct it afterwards, because a wrong
 * bind hands one person's balance to another.
 */
export function ClaimIdentity({ onBound }: { onBound: () => void }) {
  const [candidates, setCandidates] = useState<ClaimCandidate[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [predicted, setPredicted] = useState<string | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const load = async () => {
    try {
      setError(null)
      const res = await api.claimOptions()
      if (res.bound) {
        onBound()
        return
      }
      setCandidates(res.candidates ?? [])
      const guess = res.prediction?.memberId ?? null
      setPredicted(guess)
      setSelected(guess)
    } catch (err) {
      setError(err as Error)
    }
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const confirm = async () => {
    if (!selected || busy) return
    setBusy(true)
    setFailure(null)
    try {
      await api.claim(selected, crypto.randomUUID())
      onBound()
    } catch (err) {
      setFailure(
        err instanceof ApiError && err.code === 'NOT_CLAIMABLE'
          ? 'Someone has already taken that name. Pick another, or ask an admin.'
          : 'Could not link that account. Try again, or ask an admin.',
      )
      void load()
    } finally {
      setBusy(false)
    }
  }

  if (error) return <ErrorState error={error} onRetry={load} />
  if (!candidates) return <Skeleton />

  if (candidates.length === 0) {
    return (
      <div className="screen">
        <h2 className="screen__title">Almost there</h2>
        <p className="empty">
          Your account is not linked to anyone yet, and there is nobody left to claim.
          Ask an admin to add you.
        </p>
      </div>
    )
  }

  return (
    <div className="screen">
      <h2 className="screen__title">Which one are you?</h2>
      <p className="empty">
        Pick your name to link it to this Google account. You only do this once.
      </p>

      <ul className="claim">
        {candidates.map((c) => (
          <li key={c.memberId}>
            <label className={`claim__option${selected === c.memberId ? ' claim__option--on' : ''}`}>
              <input
                type="radio"
                name="claim"
                value={c.memberId}
                checked={selected === c.memberId}
                onChange={() => setSelected(c.memberId)}
              />
              <span className="claim__name">{c.displayName}</span>
              {predicted === c.memberId && <span className="claim__hint">probably you</span>}
            </label>
          </li>
        ))}
      </ul>

      {failure && (
        <p className="error error--inline" role="alert">
          {failure}
        </p>
      )}

      <div className="action">
        <button type="button" className="drink" onClick={confirm} disabled={!selected || busy}>
          {busy ? 'Linking…' : "That's me"}
        </button>
      </div>
    </div>
  )
}
