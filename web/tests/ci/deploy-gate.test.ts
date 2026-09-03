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

  test('the Cloudflare deploy is gated the same way', () => {
    const cf = workflow('deploy-cloudflare.yml')
    expect(cf).toMatch(/^ {2}test:$/m)
    expect(cf).toMatch(/^ {2}deploy:\n(?: {4}.*\n)*? {4}needs: test$/m)
    expect(cf).toContain('npm test -w @coffee-sub/web')
    expect(cf).toContain('npm run test:e2e -w @coffee-sub/web')
  })

  test('Cloudflare is manual until the migration is verified', () => {
    const cf = workflow('deploy-cloudflare.yml')
    // Two hosts racing to be production is worse than one stale host.
    expect(cf).toContain('workflow_dispatch')
    expect(cf).not.toMatch(/^on:\n(?:.*\n)*? {2}push:/m)
  })

  test('each host builds with its own base, and says which', () => {
    expect(workflow('deploy-web.yml')).toContain('VITE_BASE_PATH: /coffee-sub-tracker/')
    expect(workflow('deploy-cloudflare.yml')).toContain('VITE_BASE_PATH: /')
  })

  test('Cloudflare credentials come from secrets and are never echoed', () => {
    const cf = workflow('deploy-cloudflare.yml')
    expect(cf).toContain('secrets.CLOUDFLARE_API_TOKEN')
    expect(cf).toContain('secrets.CLOUDFLARE_ACCOUNT_ID')
    // No `echo $TOKEN`, no token in a URL.
    expect(cf).not.toMatch(/echo[^\n]*CLOUDFLARE_API_TOKEN/)
    expect(cf).not.toMatch(/CLOUDFLARE_API_TOKEN[^\n]*curl/)
  })

  test('the upload is verified as a root build before it is published', () => {
    const cf = workflow('deploy-cloudflare.yml')
    const verify = cf.indexOf('Verify the artifact is a root build')
    const publish = cf.indexOf('wrangler-action')
    expect(verify).toBeGreaterThan(-1)
    expect(publish).toBeGreaterThan(-1)
    expect(verify).toBeLessThan(publish)
  })
})

