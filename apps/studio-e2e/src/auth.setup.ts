import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  for (const id of ['aurora-veil', 'hex-pulse', 'warp-tunnel']) {
    const directory = resolve(import.meta.dirname, '../../../examples/shaders', id);
    const meta = JSON.parse(readFileSync(join(directory, 'meta.json'), 'utf8'));
    const created = await request.post('/api/shaders', {
      data: {
        name: meta.name,
        controls: meta.controls,
        render: meta.render,
        fragment: readFileSync(join(directory, 'fragment.glsl'), 'utf8'),
        vertex: readFileSync(join(directory, 'vertex.glsl'), 'utf8'),
      },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const { presets } = JSON.parse(readFileSync(join(directory, 'presets.json'), 'utf8'));
    for (const preset of presets) {
      const saved = await request.post(`/api/shaders/${id}/presets`, { data: preset });
      expect(saved.ok(), await saved.text()).toBe(true);
    }
  }
  await request.storageState({ path: STORAGE_STATE });
});
