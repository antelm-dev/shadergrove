import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as setup, expect } from '@playwright/test';

import { STORAGE_STATE } from './fixtures';

// The store is fresh on every run, so the account is always new. With
// verification off, the sign-up response sets the session cookie.
setup('sign up the test account', async ({ request, baseURL }) => {
  const response = await request.post('/api/auth/sign-up/email', {
    headers: { origin: baseURL! },
    data: { name: 'E2E', email: 'e2e@example.test', password: 'e2e-test-password' },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const library = await request.get('/api/shaders');
  expect(library.ok()).toBe(true);
  expect(await library.json()).toEqual({ shaders: [] });

  // Library writes still require a verified address. Verify only the account
  // in serve.ts's throwaway database before creating its fixtures.
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
    DatabaseSync: new (path: string) => {
      prepare(sql: string): { run(...values: unknown[]): unknown };
      close(): void;
    };
  };
  const db = new DatabaseSync(join(tmpdir(), 'shadergrove-e2e', 'shader-studio.sqlite'));
  try {
    db.prepare('UPDATE users SET email_verified = 1 WHERE email = ?').run('e2e@example.test');
  } finally {
    db.close();
  }

  // Routing tests use explicit, account-owned fixtures, not startup examples.
  for (const name of ['Aurora Veil', 'Hex Pulse', 'Warp Tunnel']) {
    const created = await request.post('/api/shaders', { data: { name } });
    expect(created.ok(), await created.text()).toBe(true);
  }
  await request.storageState({ path: STORAGE_STATE });
});
