import { defineConfig, devices } from '@playwright/test';

import { STORAGE_STATE } from './src/fixtures';

// Not the smoke's 4321, so both can run at once.
const PORT = 4322;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Real Chromium rather than the headless shell, so the preview canvas renders.
const chromium = { ...devices['Desktop Chrome'], channel: 'chromium' };

export default defineConfig({
  testDir: './src',
  outputDir: './test-results',
  // Every test shares one server and one database.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: !!process.env['CI'],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /\.setup\.ts$/, use: chromium },
    {
      name: 'chromium',
      dependencies: ['setup'],
      use: { ...chromium, storageState: STORAGE_STATE },
    },
  ],
  webServer: {
    command: `node src/serve.ts --port=${PORT} --host=127.0.0.1 --no-hmr --no-live-reload`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    stdout: 'pipe',
    env: {
      FORCE_COLOR: '0',
      // A set DATABASE_URL would win over the throwaway SQLite store serve.ts makes.
      DATABASE_URL: '',
      BETTER_AUTH_URL: BASE_URL,
      AUTH_TRUSTED_ORIGINS: BASE_URL,
      // Sign up and sign in without a mailbox, Have I Been Pwned or a throttle.
      AUTH_REQUIRE_VERIFIED_EMAIL: '0',
      AUTH_CHECK_COMPROMISED_PASSWORDS: '0',
      AUTH_RATE_LIMIT: '0',
    },
  },
});
