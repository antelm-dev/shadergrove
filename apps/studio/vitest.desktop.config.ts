import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/desktop/main/**/*.spec.ts'],
    environment: 'node',
    // Inlined so a spec's `vi.mock('electron')` also reaches the IPC module's runtime.
    server: { deps: { inline: ['electron-ipc-module'] } },
  },
});
