import { useState } from 'react'
import { signInWithGoogle } from '../auth/firebase'
import { useOffline } from '../state/online'
import { explainSignIn } from '../auth/signInErrors'
import { CoffeeMark, GoogleMark } from '../components/CoffeeMark'

/**
 * The way in.
 *
 * Two things this screen has to get right. It must not flash a "sign in"
 * button at someone who is already signed in while Firebase restores its
 * persistence — so the restoring state is a state of *this* screen, not a blank
 * page somewhere else. And whatever goes wrong has to stay on the page, in
 * normal flow, next to the button that failed, in words rather than codes.
 */
export function SignIn({
  restoring = false,
  offline,
}: {
  /** Firebase is still working out whether there is already a session. */
  restoring?: boolean
  /** Overrides the detected value; the screen sources its own by default so
      App can render it as a bare <SignIn /> from any of its early returns. */
  offline?: boolean
}) {
  const detected = useOffline()
  const isOff = offline ?? detected
  const [starting, setStarting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const start = async () => {
    if (starting || isOff) return
    setStarting(true)
    setFailure(null)
    try {
      await signInWithGoogle()
      // On success the auth listener swaps this screen out from under us.
    } catch (err) {
      const { message, silent } = explainSignIn(err, isOff)
      // Closing the popup yourself is not a failure worth reporting.
      setFailure(silent ? null : message)
    } finally {
      setStarting(false)
    }
  }

  return (
    <main className="login">
      <div className="login__card">
        <CoffeeMark />
        <h1 className="login__title">Office coffee</h1>
        <p className="login__sub">Your subscription balance, without the group chat.</p>

        {restoring ? (
          <p className="login__status" role="status">
            Checking your session…
          </p>
        ) : (
          <>
            <button
              type="button"
              className="login__cta"
              onClick={() => void start()}
              disabled={starting || isOff}
              aria-busy={starting}
            >
              <GoogleMark />
              {starting ? 'Opening Google…' : 'Continue with Google'}
            </button>

            {isOff && (
              <p className="login__status" role="status">
                You&rsquo;re offline. Sign-in needs a connection.
              </p>
            )}

            {failure && (
              <p className="login__error" role="alert">
                {failure}
              </p>
            )}
          </>
        )}

        <p className="login__foot">Ask an admin if your name is not on the roster yet.</p>
      </div>
    </main>
  )
}
