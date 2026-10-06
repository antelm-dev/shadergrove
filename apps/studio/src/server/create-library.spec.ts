import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

import { createLibrary } from './create-library';

it('starts with an empty library even when an old deployment still enables seeding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shadergrove-empty-'));
  vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('SHADER_DATA_DIR', dir);
  vi.stubEnv('SHADER_SEED', '1');
  let store: Awaited<ReturnType<typeof createLibrary>> | undefined;
  try {
    store = await createLibrary();
    expect(await store.library.list()).toEqual([]);
    expect(await store.library.as({ userId: 'new-account' }).list()).toEqual([]);
  } finally {
    await store?.library.close();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
});
