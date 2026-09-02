import { useEffect, useState } from 'react'

/** A tap must never be silently queued, so going offline disables the action. */
export function OfflineBanner() {
  const [offline, setOffline] = useState(!navigator.onLine)

  useEffect(() => {
    const on = () => setOffline(false)
    const off = () => setOffline(true)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  if (!offline) return null
  return (
    <p className="offline" role="status">
      Offline — balances may be out of date.
    </p>
  )
}
