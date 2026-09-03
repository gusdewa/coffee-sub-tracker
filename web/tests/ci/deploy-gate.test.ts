import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * A deploy that no test can stop is not a safety net.
 *
 * `deploy-web.yml` published to GitHub Pages on every push to main with no
 * `needs:` on any test job, so a red suite shipped anyway. `deploy-api.yml`
 * already gates itself this way; the web deploy now matches it.
 *
 * Source-level assertions on purpose: this is a pipeline shape, not a runtime
 * behaviour, and the shape is what regressed.
 */

const workflow = (name: string) =>
  readFileSync(resolve(__dirname, '../../../.github/workflows/', name), 'utf8')

describe('web deploy pipeline', () => {
  test('the Pages build is gated on a test job', () => {
    const deploy = workflow('deploy-web.yml')
    expect(deploy).toMatch(/^ {2}test:$/m)
    // The build must not start until the tests have passed.
    expect(deploy).toMatch(/^ {2}build:\n(?: {4}.*\n)*? {4}needs: test$/m)
  })

  test('the deploy gate actually runs the web suite', () => {
    const deploy = workflow('deploy-web.yml')
    expect(deploy).toContain('npm test -w @coffee-sub/web')
    expect(deploy).toContain('npm run test:e2e -w @coffee-sub/web')
  })

  test('CI builds before running the web tests', () => {
    // `generated-sw.test.ts` reads dist/sw.js and skips when it is absent, so
    // running the web tests before the build made that guard silently vacuous.
    const ci = workflow('ci.yml')
    const build = ci.indexOf('npm run build -w @coffee-sub/web')
    const webTests = ci.indexOf('npm test -w @coffee-sub/web')
    expect(build).toBeGreaterThan(-1)
    expect(webTests).toBeGreaterThan(-1)
    expect(build).toBeLessThan(webTests)
  })
})
