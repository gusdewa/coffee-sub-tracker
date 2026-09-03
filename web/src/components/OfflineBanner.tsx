import { useCoffee } from '../state/coffee'

/**
 * Offline state now lives in the coffee store, so this banner and the Drink
 * action are guaranteed to agree. They used to be independent: this component
 * carried a comment saying going offline disables the action, while the button
 * had no such check and simply failed after the tap.
 */
export function OfflineBanner() {
  const { offline } = useCoffee()
  if (!offline) return null
  return (
    <p className="offline" role="status">
      Offline — balances may be out of date.
    </p>
  )
}
