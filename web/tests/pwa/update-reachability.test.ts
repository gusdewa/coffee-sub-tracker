import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The update control must be reachable from every state the app can be in.
 *
 * `App.tsx` returns early for auth-loading, signed-out and claim-binding. An
 * update control mounted inside it is therefore invisible to exactly the person
 * whose build is broken — and if the broken build is what prevents sign-in, the
 * update that fixes it can never be applied. A benchmark app hit precisely this
 * and recorded it: the fix became undeliverable to the people who needed it.
 *
 * These are source-level assertions on purpose. The failure is a placement
 * decision, not a runtime behaviour, so this is where it can be pinned.
 */

const read = (path: string) => readFileSync(resolve(__dirname, '../../', path), 'utf8')

describe('update prompt reachability', () => {
  test('mounts as a sibling of <App/>, not inside it', () => {
    const main = read('src/main.tsx')
    expect(main).toContain("import { UpdatePrompt } from './components/UpdatePrompt'")
    // Sibling, so no branch inside App can hide it.
    expect(main).toMatch(/<App\s*\/>\s*<UpdatePrompt\s*\/>/)
  })

  test('App.tsx owns no part of the update UI', () => {
    const app = read('src/App.tsx')
    expect(app).not.toContain('UpdateBanner')
    expect(app).not.toContain('UpdatePrompt')
    // The hook moves with the component; leaving it here would re-couple the
    // download to a tree that early-returns.
    expect(app).not.toContain('useServiceWorker')
  })

  test('the gates that make the placement matter still exist', () => {
    // A tripwire, not a rule. If App stops early-returning, re-read the two
    // tests above before moving the prompt back inside — they exist because
    // these branches render *instead of* the application shell.
    const app = read('src/App.tsx')
    expect(app).toMatch(/if \(loading\) return/)
    expect(app).toMatch(/if \(!user && !qaActive && !isQaRoute\) return <SignIn \/>/)
    expect(app).toMatch(/if \(unbound\) \{/)
  })

  test('the prompt does not import anything auth-shaped', () => {
    // Reachability is only real if the component can render with no auth
    // context at all — no user, no token, no roster.
    const prompt = read('src/components/UpdatePrompt.tsx')
    for (const forbidden of ['useAuth', 'firebase', 'api/client', './api']) {
      expect(prompt, `UpdatePrompt must not depend on ${forbidden}`).not.toContain(forbidden)
    }
  })
})
