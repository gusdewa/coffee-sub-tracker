import { useOffline } from '../state/online'

/**
 * The banner, the Drink action and the login screen all read state/online.ts,
 * so they cannot disagree. This component used to carry a comment saying that
 * going offline disables the action while the button had no such check.
 */
export function OfflineBanner() {
  const offline = useOffline()
  if (!offline) return null
  return (
    <p className="offline" role="status">
      Offline — balances may be out of date.
    </p>
  )
}
