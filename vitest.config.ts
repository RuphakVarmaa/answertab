import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    // Each file boots an in-memory PGlite (WASM Postgres); under load that can take >10 s.
    hookTimeout: 60000,
    pool: 'forks',
    maxWorkers: 4,
  },
})
