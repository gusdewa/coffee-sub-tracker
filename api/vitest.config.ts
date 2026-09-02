import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Integration tests drive real concurrency against Azurite; a shared
    // emulator means suites must not race each other for the same tables.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
