/**
 * Offered, never forced. A new bundle activates on the person's tap so it can
 * never replace the app between reading a balance and pressing Drink 1.
 */
export function UpdateBanner({ show, onUpdate }: { show: boolean; onUpdate: () => void }) {
  if (!show) return null
  return (
    <div className="update" role="status">
      <span className="update__text">A new version is ready.</span>
      <button type="button" className="update__action" onClick={onUpdate}>
        Reload
      </button>
    </div>
  )
}
