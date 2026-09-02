import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Project-site Pages deploy: assets are served from /coffee-sub-tracker/.
// Routing is HashRouter (plan §10.1), so no 404.html fallback is required.
export default defineConfig({
  base: '/coffee-sub-tracker/',
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: true },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
  },
})
