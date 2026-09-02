import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end projects.
 *
 * Chromium is the reference. WebKit is included because iPhone is a first-class
 * target here, but Playwright's WebKit does not always register a service
 * worker in headless mode — the specs detect that and skip rather than fail, so
 * a genuine regression is never hidden behind an environment quirk.
 */
export default defineConfig({
  testDir: './e2e',
  // Each spec builds twice and drives a real worker; give it room.
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
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
})
