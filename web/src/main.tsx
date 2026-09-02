import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { App } from './App'
import './styles/tokens.css'
import './styles/app.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* HashRouter: every route lives in the fragment, so GitHub Pages needs
        no 404.html fallback and deep links always resolve. */}
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
)
