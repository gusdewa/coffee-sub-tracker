import { Routes, Route, NavLink, useLocation } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { useAuth } from './auth/useAuth'
import { api, hasQaSession } from './api/client'
import { signInWithGoogle, signOut } from './auth/firebase'
import { MyCoffee } from './screens/MyCoffee'
import { AllBalances } from './screens/AllBalances'
import { Subscriptions } from './screens/Subscriptions'
import { History } from './screens/History'
import { QaRedeem } from './screens/QaRedeem'
import { AdminMembers } from './screens/AdminMembers'
import { OfflineBanner } from './components/OfflineBanner'
import { UpdateBanner } from './components/UpdateBanner'
import { useServiceWorker } from './pwa/useServiceWorker'

function SignIn() {
  const [error, setError] = useState<string | null>(null)

  const signIn = async () => {
    setError(null)
    try {
      await signInWithGoogle()
    } catch (err) {
      // Google sign-in is unavailable until the Firebase project has its
      // provider enabled; saying so beats a button that silently does nothing.
      const code = (err as { code?: string }).code ?? ""
      setError(
        code.includes("configuration-not-found") || code.includes("internal-error")
          ? "Google sign-in is not switched on for this project yet. Ask an admin."
          : "Could not sign in. Please try again.",
      )
    }
  }

  return (
    <div className="screen screen--centred">
      <div className="signin">
        <h1 className="signin__title">Office coffee</h1>
        <p className="signin__sub">Your subscription balance, without the group chat.</p>
        <button type="button" className="drink" onClick={() => void signIn()}>
          Sign in with Google
        </button>
        {error && (
          <p className="error error--inline" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}

export function App() {
  const { user, loading } = useAuth()
  const location = useLocation()
  const [isAdmin, setIsAdmin] = useState(false)
  const [qaActive, setQaActive] = useState(hasQaSession())
  const sw = useServiceWorker()

  useEffect(() => {
    if (!user && !qaActive) return
    api.me()
      .then((me) => setIsAdmin(me.member.role === 'admin'))
      .catch(() => setIsAdmin(false))
  }, [user, qaActive])
  const isQaRoute = location.pathname.startsWith('/qa')

  if (loading) return <div className="screen screen--centred" aria-busy="true" />

  // The QA route must run even when signed out — redeeming is what signs you in.
  // A redeemed QA session stands in for a signed-in user.
  if (!user && !qaActive && !isQaRoute) return <SignIn />

  return (
    <div className="app">
      <UpdateBanner show={sw.needsRefresh} onUpdate={sw.update} />
      <OfflineBanner />
      <main className="app__main">
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

      {(user || qaActive) && (
        <nav className="nav" aria-label="Sections">
          <NavLink to="/" end className="nav__link">My coffee</NavLink>
          <NavLink to="/everyone" className="nav__link">Everyone</NavLink>
          <NavLink to="/subscriptions" className="nav__link">Cards</NavLink>
          <NavLink to="/history" className="nav__link">History</NavLink>
          {isAdmin && <NavLink to="/manage" className="nav__link">Manage</NavLink>}
          <button type="button" className="nav__link nav__signout" onClick={() => void signOut()}>
            Sign out
          </button>
        </nav>
      )}
    </div>
  )
}
