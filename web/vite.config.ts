import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { buildPwaOptions } from './pwa.config'
import { resolveBasePath } from './basePath'

/*
 * Where this build will be served from.
 *
 * `/coffee-sub-tracker/` for the GitHub Pages project site, `/` for Cloudflare
 * Pages — declared by the deploying workflow rather than hard-coded here, and
 * validated so a malformed value fails the build instead of producing a worker
 * whose scope quietly does not match the site. Routing stays HashRouter, so
 * every route lives in the fragment and the navigation fallback is just the
 * app shell.
 */
const BASE = resolveBasePath(process.env.VITE_BASE_PATH)

export default defineConfig(({ mode }) => {
  const apiBaseUrl =
    process.env.VITE_API_BASE_URL ??
    'https://simo-digitalassets-svc-coffee-sub.azurewebsites.net'

  // Vitest loads this config too, and the PWA plugin would regenerate a dev
  // stub over dist/sw.js — destroying the very artifact tests/pwa/generated-sw
  // inspects. Keep it out of the test run.
  const underTest = Boolean(process.env.VITEST)

  // Build identity: the git SHA in CI, 'dev' locally. Rendered in the update
  // prompt so a two-deploy verification can prove the reload actually landed
  // on the new build rather than re-rendering the old one.
  const buildId = (process.env.GITHUB_SHA ?? 'dev').slice(0, 7)

  return {
    base: BASE,
    define: { __APP_VERSION__: JSON.stringify(buildId) },
    resolve: underTest
      ? {
          // The virtual module only exists while the plugin runs, and the
          // plugin is excluded under test. Alias it so the hook is importable
          // and suites can vi.mock it.
          alias: { 'virtual:pwa-register': '/tests/stubs/pwa-register.ts' },
        }
      : undefined,
    plugins: [
      react(),
      ...(underTest ? [] : [VitePWA(buildPwaOptions({ base: BASE, apiBaseUrl }))]),
    ],
    build: {
      outDir: 'dist',
      // A 1.5 MB source map is dead weight on a phone, and this bundle ships
      // from a public repo where the sources are already readable.
      sourcemap: mode !== 'production' ? true : false,
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./tests/setup.ts'],
      include: ['tests/**/*.test.{ts,tsx}'],
    },
  }
})
