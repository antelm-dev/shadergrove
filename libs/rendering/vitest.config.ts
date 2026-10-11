import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    // The engine specs stand canvases up in a DOM; WebGL itself is faked (src/testing).
    environment: 'jsdom',
  },
});
