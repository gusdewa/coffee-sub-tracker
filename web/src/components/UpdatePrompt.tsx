import { useEffect, useRef, useState } from 'react'
import { useServiceWorker } from '../pwa/useServiceWorker'

/**
 * "Update ready" — the one control that must never be gated.
 *
 * Mounted beside <App/> in main.tsx rather than inside it. App returns early
 * for auth-loading, signed-out and claim-binding, so anything rendered there is
 * invisible to precisely the person whose build is broken. If that build is
 * what prevents sign-in, an update mounted inside the app can never be applied.
 *
 * It imports no auth, no API client and no router — it renders identically with
 * no session at all.
 */

/** Heroicons `arrow-path`, inlined: one icon does not justify a dependency. */
function ArrowPath() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="18"
      height="18"
    >
      <path d="M16.023 9.348h4.992V4.356" />
      <path d="M20.015 9.348a8.25 8.25 0 1 0-1.98 6.36" />
    </svg>
  )
}

export function UpdatePrompt() {
  const { needsRefresh, updatedElsewhere, blockedByMutation, update } = useServiceWorker()
  const [dismissed, setDismissed] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  const show = (needsRefresh || updatedElsewhere) && !dismissed

  /*
   * Publish how much room this is taking at the bottom of the screen.
   *
   * The shell's floating Drink action sits directly above the dock, which is
   * exactly where this sits too — and App.tsx may not import or observe this
   * component, so it cannot be told directly. A custom property on the root is
   * a one-way channel that costs the shell nothing and keeps the dependency
   * pointing outward from here.
   */
  useEffect(() => {
    const root = document.documentElement
    const el = box.current
    if (!show || !el) {
      root.style.removeProperty('--update-h')
      return
    }
    const publish = () => root.style.setProperty('--update-h', `${el.offsetHeight}px`)
    publish()
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish)
    observer?.observe(el)
    return () => {
      observer?.disconnect()
      root.style.removeProperty('--update-h')
    }
  }, [show])

  if (!show) return null

  const label = blockedByMutation
    ? 'Updating after your last tap…'
    : updatedElsewhere
      ? 'Updated in another tab'
      : 'A new version is ready'

  return (
    <div ref={box} className="update" role="status" aria-live="polite">
      <span className="update__text">
        {label}
        <span className="update__build"> · {typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'}</span>
      </span>
      <button
        type="button"
        className="update__action"
        onClick={update}
        disabled={blockedByMutation}
      >
        <ArrowPath />
        {blockedByMutation ? 'Waiting' : 'Reload'}
      </button>
      <button
        type="button"
        className="update__dismiss"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss update notice"
      >
        ✕
      </button>
    </div>
  )
}
