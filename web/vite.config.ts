import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { buildPwaOptions } from './pwa.config'

// Project-site Pages deploy: assets are served from /coffee-sub-tracker/.
// Routing is HashRouter, so every route lives in the fragment and the service
// worker's navigation fallback is simply the app shell.
const BASE = '/coffee-sub-tracker/'

export default defineConfig(({ mode }) => {
  const apiBaseUrl =
    process.env.VITE_API_BASE_URL ??
    'https://simo-digitalassets-svc-coffee-sub.azurewebsites.net'

  // Vitest loads this config too, and the PWA plugin would regenerate a dev
  // stub over dist/sw.js — destroying the very artifact tests/pwa/generated-sw
  // inspects. Keep it out of the test run.
  const underTest = Boolean(process.env.VITEST)

  return {
    base: BASE,
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
