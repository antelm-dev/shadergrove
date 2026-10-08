import { defineConfig } from 'vitest/config';

// Analysis tests that need `node:` (the real compiled front end, three.js sources).
// The ng unit-test builder excludes them; see angular.json.
export default defineConfig({
  test: {
    include: ['src/**/*.node.spec.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
