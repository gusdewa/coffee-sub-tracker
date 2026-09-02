import { useEffect, useRef, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { api, setQaSession } from '../api/client'

/**
 * QA link redemption.
 *
 * The code arrives inside the URL fragment (`#/qa?code=…`), so it is never
 * sent to any server as a query string and never lands in an access log or a
 * Referer header. It reaches a server exactly once: in the body of the
 * redemption request.
 *
 * It is stripped from the address bar and from history *before* the network
 * call, held only in a local variable, and never written to localStorage,
 * sessionStorage, IndexedDB or a cookie.
 */
export function QaRedeem({ onSession }: { onSession: () => void }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [status, setStatus] = useState<'working' | 'done' | 'failed'>('working')
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true

    const code = new URLSearchParams(location.search).get('code') ?? ''

    // Remove the secret from the URL and from back/forward history first.
    navigate('/qa', { replace: true })

    if (!code) {
      setStatus('failed')
      return
    }

    void (async () => {
      try {
        const { sessionToken } = await api.redeemQa(code)
        // Held in memory only, and never a Firebase credential — so this works
        // even before Google sign-in has been configured on the project.
        setQaSession(sessionToken)
        onSession()
        setStatus('done')
        navigate('/', { replace: true })
      } catch {
        // The reason is deliberately not shown: expired, spent, revoked and
        // unknown all look identical, so a link cannot be probed.
        setStatus('failed')
      }
    })()
  }, [location.search, navigate])

  return (
    <div className="screen screen--centred">
      {status === 'working' && <p className="empty">Opening QA session…</p>}
      {status === 'failed' && (
        <p className="empty">
          That QA link is not valid. Ask an admin for a fresh one.
        </p>
      )}
    </div>
  )
}
