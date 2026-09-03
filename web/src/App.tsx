import { Routes, Route, useLocation } from 'react-router-dom'
import { useState, useEffect, useRef } from 'react'
import { useAuth } from './auth/useAuth'
import { hasQaSession, setQaSession, ApiError } from './api/client'
import { signOut } from './auth/firebase'
import { useCoffee, loadMe } from './state/coffee'
import { useOnboarding } from './onboarding/useOnboarding'
import { AppHeader } from './shell/AppHeader'
import { Dock } from './shell/Dock'
import { DrinkFab } from './shell/DrinkFab'
import { UndoSnackbar } from './shell/UndoSnackbar'
import { MyCoffee } from './screens/MyCoffee'
import { AllBalances } from './screens/AllBalances'
import { Subscriptions } from './screens/Subscriptions'
import { History } from './screens/History'
import { QaRedeem } from './screens/QaRedeem'
import { AdminMembers } from './screens/AdminMembers'
import { ClaimIdentity } from './screens/ClaimIdentity'
import { OfflineBanner } from './components/OfflineBanner'
import { SignIn } from './screens/SignIn'

export function App() {
  const { user, loading } = useAuth()
  const location = useLocation()
  const [qaActive, setQaActive] = useState(hasQaSession())
  // One /api/me for the whole app. App and My Coffee used to fetch it
  // independently, so every cold start made the same request twice and the
  // two copies of the member could disagree.
  const { data, error } = useCoffee()

  // A verified account with no member yet is not an error — it can claim one.
  const unbound = error instanceof ApiError && error.code === 'ACCOUNT_UNBOUND'
  const isAdmin = data?.member.role === 'admin'
  const signedIn = Boolean(user) || qaActive

  /*
   * Keyed on the uid, not the user object. `onIdTokenChanged` hands back a new
   * User instance on every token refresh, and depending on the reference made
   * this re-fetch on each one — which, because the response updates the store
   * and the store re-renders App, is a loop rather than a stray request.
   */
  const uid = user?.uid ?? null
  useEffect(() => {
    if (!uid && !qaActive) return
    void loadMe()
  }, [uid, qaActive])

  // Only once the balance is in: the tour points at the shell, and the shell is
  // not on screen until there is something to show in it.
  const replayTour = useOnboarding(signedIn && !unbound && data !== null)

  const isQaRoute = location.pathname.startsWith('/qa')

  // The scroller is <main>, so a new route has to be told to start at the top;
  // otherwise it inherits wherever the previous screen happened to be left.
  const scroller = useRef<HTMLElement>(null)
  useEffect(() => {
    // scrollTop rather than scrollTo: it needs no smooth-scroll opt-out under
    // reduced motion, and it exists everywhere the app runs.
    if (scroller.current) scroller.current.scrollTop = 0
  }, [location.pathname])

  // A state of the login screen, not a blank page: anyone already signed in
  // must never see a sign-in button appear and then vanish.
  if (loading) return <SignIn restoring />

  // The QA route must run even when signed out — redeeming is what signs you in.
  // A redeemed QA session stands in for a signed-in user.
  if (!user && !qaActive && !isQaRoute) return <SignIn />

  // Signed in, but this Google account is not yet linked to anyone.
  if (unbound) {
    return (
      <div className="app app--bare">
        <main className="app__main">
          <ClaimIdentity onBound={() => window.location.reload()} />
        </main>
      </div>
    )
  }

  const leave = () => {
    // A QA session used to survive "Sign out": only Firebase was cleared, so the
    // tester stayed authenticated against the API with a bearer token the UI had
    // stopped showing any sign of.
    setQaSession(null)
    setQaActive(false)
    void signOut()
  }

  return (
    <div className="app">
      {signedIn && (
        <AppHeader
          displayName={data?.member.displayName}
          isAdmin={Boolean(isAdmin)}
          onSignOut={leave}
          onReplayTour={replayTour}
        />
      )}
      <OfflineBanner />
      <main className="app__main" ref={scroller}>
        <Routes>
          <Route path="/" element={<MyCoffee />} />
          <Route path="/everyone" element={<AllBalances />} />
          <Route path="/subscriptions" element={<Subscriptions />} />
          <Route path="/history" element={<History />} />
          <Route path="/qa" element={<QaRedeem onSession={() => setQaActive(true)} />} />
          <Route path="/manage" element={<AdminMembers />} />
          <Route path="*" element={<MyCoffee />} />
        </Routes>
      </main>

      {signedIn && (
        <>
          {/*
            One fixed row above the dock. The snackbar takes its own line so the
            Drink action never has to compete with it for width at 320px, and the
            whole row is pointer-events:none so only the controls are tappable.
          */}
          <div className="stack">
            <UndoSnackbar />
            <DrinkFab />
          </div>
          <Dock />
        </>
      )}
    </div>
  )
}
