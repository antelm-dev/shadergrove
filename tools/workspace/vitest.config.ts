import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/release/**/*.spec.ts', 'src/generate/**/*.spec.ts', 'src/check/**/*.spec.ts'],
    environment: 'node',
  },
});
