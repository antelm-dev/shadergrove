import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    // The real WASM front end is instantiated per suite; keep it in one process.
    pool: 'forks',
    testTimeout: 30_000,
  },
});
