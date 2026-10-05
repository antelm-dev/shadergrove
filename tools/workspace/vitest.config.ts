import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['src/release/**/*.spec.ts'], environment: 'node' },
});
