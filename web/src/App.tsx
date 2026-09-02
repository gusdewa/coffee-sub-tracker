import { Routes, Route, NavLink, useLocation } from 'react-router-dom'
import { useAuth } from './auth/useAuth'
import { signInWithGoogle, signOut } from './auth/firebase'
import { MyCoffee } from './screens/MyCoffee'
import { AllBalances } from './screens/AllBalances'
import { Subscriptions } from './screens/Subscriptions'
import { History } from './screens/History'
import { QaRedeem } from './screens/QaRedeem'
import { OfflineBanner } from './components/OfflineBanner'

function SignIn() {
  return (
    <div className="screen screen--centred">
      <div className="signin">
        <h1 className="signin__title">Office coffee</h1>
        <p className="signin__sub">Your subscription balance, without the group chat.</p>
        <button type="button" className="drink" onClick={() => void signInWithGoogle()}>
          Sign in with Google
        </button>
      </div>
    </div>
  )
}

export function App() {
  const { user, loading } = useAuth()
  const location = useLocation()
  const isQaRoute = location.pathname.startsWith('/qa')

  if (loading) return <div className="screen screen--centred" aria-busy="true" />

  // The QA route must run even when signed out — redeeming is what signs you in.
  if (!user && !isQaRoute) return <SignIn />

  return (
    <div className="app">
      <OfflineBanner />
      <main className="app__main">
        <Routes>
          <Route path="/" element={<MyCoffee />} />
          <Route path="/everyone" element={<AllBalances />} />
          <Route path="/subscriptions" element={<Subscriptions />} />
          <Route path="/history" element={<History />} />
          <Route path="/qa" element={<QaRedeem />} />
          <Route path="*" element={<MyCoffee />} />
        </Routes>
      </main>

      {user && (
        <nav className="nav" aria-label="Sections">
          <NavLink to="/" end className="nav__link">My coffee</NavLink>
          <NavLink to="/everyone" className="nav__link">Everyone</NavLink>
          <NavLink to="/subscriptions" className="nav__link">Cards</NavLink>
          <NavLink to="/history" className="nav__link">History</NavLink>
          <button type="button" className="nav__link nav__signout" onClick={() => void signOut()}>
            Sign out
          </button>
        </nav>
      )}
    </div>
  )
}
