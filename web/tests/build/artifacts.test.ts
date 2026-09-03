import { describe, test, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The same source, built for both hosts, asserted as artifacts.
 *
 * GitHub Pages serves a project site at /coffee-sub-tracker/ and Cloudflare
 * Pages serves the root. Everything base-derived — asset URLs, manifest
 * start_url and scope, the worker's navigation fallback and the recovery route
 * — has to be right in both, and the security properties that already had
 * tests must survive both. A config-level assertion cannot prove this; only
 * the built output can, which is the same reason generated-sw.test.ts exists.
 */

const WEB = resolve(__dirname, '../..')
const API = 'https://api.build-test.invalid'

interface Built {
  base: string
  dir: string
  html: string
  manifest: Record<string, unknown>
  sw: string
}

const built: Record<string, Built> = {}

function build(name: string, basePath: string): Built {
  const dir = resolve(WEB, `.build-test/${name}`)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  execFileSync('npx', ['vite', 'build', '--outDir', dir, '--emptyOutDir'], {
    cwd: WEB,
    env: {
      ...process.env,
      VITEST: '',
      VITE_BASE_PATH: basePath,
      VITE_API_BASE_URL: API,
      GITHUB_SHA: 'basetest',
    },
    stdio: 'pipe',
  })
  return {
    base: basePath === '' ? '/' : basePath,
    dir,
    html: readFileSync(resolve(dir, 'index.html'), 'utf8'),
    manifest: JSON.parse(readFileSync(resolve(dir, 'manifest.webmanifest'), 'utf8')),
    sw: readFileSync(resolve(dir, 'sw.js'), 'utf8'),
  }
}

beforeAll(() => {
  built['pages'] = build('pages', '/coffee-sub-tracker/')
  built['root'] = build('root', '/')
}, 180_000)

describe.each([
  ['GitHub Pages subpath', 'pages'],
  ['Cloudflare root', 'root'],
])('%s', (_label, key) => {
  test('assets are addressed from the base it was built for', () => {
    const b = built[key]!
    const srcs = [...b.html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]!)
    const local = srcs.filter((s) => s.startsWith('/'))
    expect(local.length).toBeGreaterThan(0)
    for (const src of local) expect(src, src).toMatch(new RegExp(`^${b.base}`))
  })

  test('the manifest is installable at that base', () => {
    const b = built[key]!
    expect(b.manifest['start_url']).toBe(b.base)
    expect(b.manifest['scope']).toBe(b.base)
    expect(b.manifest['id']).toBe(b.base)
    const icons = b.manifest['icons'] as Array<{ src: string; purpose?: string }>
    expect(icons.length).toBeGreaterThanOrEqual(3)
    for (const icon of icons) expect(icon.src, icon.src).toMatch(new RegExp(`^${b.base}icons/`))
    expect(icons.some((i) => i.purpose === 'maskable')).toBe(true)
  })

  test('the worker falls back to that base, and never to the recovery page', () => {
    const b = built[key]!
    expect(b.sw).toContain(`${b.base}index.html`)
    // The page that unregisters the worker must never be served by it.
    expect(b.sw).toMatch(/unregister/)
  })

  test('the API is still NetworkOnly, and nothing of it is precached', () => {
    const b = built[key]!
    // The origin is embedded as an escaped RegExp source, so its dots appear as
    // "\." in the artifact — match the host label, not the literal URL.
    expect(b.sw).toContain('build-test')
    expect(b.sw).not.toMatch(/\bapiOrigin\b/)
    expect(b.sw).not.toMatch(/\bapiBaseUrl\b/)

    // The single security property this whole PWA turns on: every route that
    // governs the API is NetworkOnly and none pairs it with a caching strategy.
    const routes = b.sw.match(/registerRoute\([^;]*/g) ?? []
    const apiRoutes = routes.filter((r) => r.includes('build-test'))
    expect(apiRoutes.length, 'expected a route governing the API').toBeGreaterThan(0)
    for (const route of apiRoutes) {
      expect(route).toContain('NetworkOnly')
      for (const caching of ['CacheFirst', 'StaleWhileRevalidate', 'NetworkFirst', 'CacheOnly']) {
        expect(route, `API route must not use ${caching}`).not.toContain(caching)
      }
    }

    const precache = b.sw.match(/precacheAndRoute\(\[[\s\S]*?\]\)/)?.[0] ?? ''
    expect(precache).not.toMatch(/\/api\//)
    expect(precache).not.toMatch(/\.json"/)
  })

  test('the worker does not claim clients or skip waiting on its own', () => {
    const b = built[key]!
    expect(b.sw).toMatch(/SKIP_WAITING/)
    expect(b.sw).not.toContain('clientsClaim()')
  })
})

describe('the two builds differ only where the base requires', () => {
  test('the subpath build never emits a root-absolute asset URL', () => {
    const pages = built['pages']!
    const srcs = [...pages.html.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map((m) => m[1]!)
    expect(srcs.every((s) => s.startsWith('/coffee-sub-tracker/'))).toBe(true)
  })

  test('the root build never leaks the project-site path', () => {
    const root = built['root']!
    expect(root.html).not.toContain('/coffee-sub-tracker/')
    expect(JSON.stringify(root.manifest)).not.toContain('/coffee-sub-tracker/')
    expect(root.sw).not.toContain('/coffee-sub-tracker/')
  })

  test('the Cloudflare headers file ships, and never lets the shell go immutable', () => {
    const headers = readFileSync(resolve(built['root']!.dir, '_headers'), 'utf8')

    // Hashed assets may be cached forever…
    expect(headers).toMatch(/\/assets\/\*/)
    expect(headers).toMatch(/immutable/)

    // …but nothing that decides which hashes to use. A cached sw.js or
    // index.html strands people on a build that can never offer them a newer
    // one, which is the exact failure the update lifecycle exists to prevent.
    for (const path of ['/index.html', '/sw.js', '/manifest.webmanifest']) {
      const block = headers.slice(headers.indexOf(`${path}\n`))
      expect(block.slice(0, 120), path).toMatch(/no-cache/)
    }
    const recovery = headers.slice(headers.indexOf('/unregister.html\n'))
    expect(recovery.slice(0, 120)).toMatch(/no-store/)

    expect(headers).toContain('X-Content-Type-Options: nosniff')
  })

  test('the headers file ships from the subpath build too', () => {
    expect(existsSync(resolve(built['pages']!.dir, '_headers'))).toBe(true)
  })
})

