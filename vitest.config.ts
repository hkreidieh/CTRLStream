import { defineConfig } from 'vitest/config';

// Unit tests run against the mock obs-websocket server and need no OBS.
// Integration tests live in test/integration and skip themselves unless
// OBS_INTEGRATION=1 (see `pnpm test:integration`).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
});
