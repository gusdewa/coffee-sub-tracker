import { useEffect, useState } from 'react'
import { api, ApiError, type MemberRow } from '../api/client'
import { Skeleton } from '../components/Skeleton'
import { ErrorState } from '../components/ErrorState'

/**
 * Admin: who is on the roster, and who is still waiting for an address.
 *
 * A pending member is a person we know by name whose personal Google account
 * has not been confirmed. They can already be given cups; they just cannot
 * sign in yet. Linking is deliberately a typed-in, exact address — the server
 * refuses anything that is already claimed, and records who linked what.
 */

function explainLinkError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'EMAIL_ALREADY_LINKED':
        return 'That address already belongs to someone else on the roster.'
      case 'MEMBER_ALREADY_LINKED':
        return 'This person already has an address.'
      case 'VALIDATION_FAILED':
        return err.message
      default:
        return err.message
    }
  }
  return 'Could not link that address.'
}

export function AdminMembers() {
  const [members, setMembers] = useState<MemberRow[] | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')

  const load = async () => {
    try {
      setError(null)
      setMembers((await api.adminMembers()).members.filter((m) => !m.displayName.startsWith('QA')))
    } catch (err) {
      setError(err as Error)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  const link = async (member: MemberRow) => {
    const email = draft.trim()
    if (!email) return
    setBusy(true)
    setLinkError(null)
    try {
      await api.adminLinkEmail(member.memberId, email, crypto.randomUUID())
      setAnnouncement(`${member.displayName} linked.`)
      setEditing(null)
      setDraft('')
      await load()
    } catch (err) {
      setLinkError(explainLinkError(err))
    } finally {
      setBusy(false)
    }
  }

  if (error) return <ErrorState error={error} onRetry={load} />
  if (!members) return <Skeleton />

  const pending = members.filter((m) => m.pending)

  return (
    <div className="screen">
      <h2 className="screen__title">Manage</h2>

      <p aria-live="polite" className="visually-hidden">
        {announcement}
      </p>

      {pending.length > 0 && (
        <p className="empty">
          {pending.length === 1
            ? '1 person is waiting for their Google address.'
            : `${pending.length} people are waiting for their Google address.`}{' '}
          They can be given cups now, but cannot sign in until you link them.
        </p>
      )}

      <ul className="roster">
        {members.map((m) => (
          <li key={m.memberId} className={`person${m.pending ? ' person--pending' : ''}`}>
            <span className="person__name">
              {m.displayName}
              {m.role === 'admin' && <span className="person__role">admin</span>}
            </span>

            {m.pending ? (
              editing === m.memberId ? (
                <form
                  className="person__link"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void link(m)
                  }}
                >
                  <label className="visually-hidden" htmlFor={`email-${m.memberId}`}>
                    Google address for {m.displayName}
                  </label>
                  <input
                    id={`email-${m.memberId}`}
                    type="email"
                    inputMode="email"
                    autoComplete="off"
                    placeholder="name@gmail.com"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    disabled={busy}
                  />
                  <button type="submit" className="person__save" disabled={busy || !draft.trim()}>
                    {busy ? 'Linking…' : 'Link'}
                  </button>
                  <button
                    type="button"
                    className="person__cancel"
                    onClick={() => {
                      setEditing(null)
                      setLinkError(null)
                      setDraft('')
                    }}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <button
                  type="button"
                  className="person__action"
                  onClick={() => {
                    setEditing(m.memberId)
                    setDraft('')
                    setLinkError(null)
                  }}
                >
                  Add address
                </button>
              )
            ) : (
              <span className="person__email">{m.email}</span>
            )}
          </li>
        ))}
      </ul>

      {linkError && (
        <p className="error error--inline" role="alert">
          {linkError}
        </p>
      )}
    </div>
  )
}
