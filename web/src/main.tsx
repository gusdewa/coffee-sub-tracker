import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { App } from './App'
import { UpdatePrompt } from './components/UpdatePrompt'
import './styles/tokens.css'
import './styles/app.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* HashRouter: every route lives in the fragment, so GitHub Pages needs
        no 404.html fallback and deep links always resolve. */}
    <HashRouter>
      {/* UpdatePrompt is a sibling of App, not a child, and that is
          load-bearing: App returns early for auth-loading, signed-out and
          claim-binding, so an update control mounted inside it is invisible to
          exactly the person whose build is broken. Out here it is always
          reachable. */}
      <App />
      <UpdatePrompt />
    </HashRouter>
  </StrictMode>,
)
