import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end projects.
 *
 * Chromium is the reference. WebKit is included because iPhone is a first-class
 * target here, but Playwright's WebKit does not always register a service
 * worker in headless mode — the specs detect that and skip rather than fail, so
 * a genuine regression is never hidden behind an environment quirk.
 *
 * The shell suite runs on real device descriptors rather than a resized desktop
 * window, because the things it checks — safe areas, thumb reach, a four-column
 * dock at 320px, a landscape viewport barely taller than the dock — only exist
 * at those metrics. iPhone SE is the narrow case: an actual 320px device beats a
 * synthetic viewport.
 *
 * The two suites are split by testMatch so the update-lifecycle spec, which
 * builds twice and drives a real worker, does not repeat on four more projects.
 */
const UPDATE = /update-lifecycle\.spec\.ts/
const SHELL = /shell\.spec\.ts/

export default defineConfig({
  testDir: './e2e',
  // Each spec builds and drives a real worker; give it room.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', testMatch: UPDATE, use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', testMatch: UPDATE, use: { ...devices['Desktop Safari'] } },

    { name: 'mobile-safari', testMatch: SHELL, use: { ...devices['iPhone 13'] } },
    { name: 'mobile-chrome', testMatch: SHELL, use: { ...devices['Pixel 7'] } },
    // 320px wide, the narrowest phone still in use.
    { name: 'narrow', testMatch: SHELL, use: { ...devices['iPhone SE'] } },
    { name: 'landscape', testMatch: SHELL, use: { ...devices['iPhone 13 landscape'] } },
  ],
})
