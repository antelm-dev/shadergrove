import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { root } from './lib/paths.js';
import { createLogger } from './lib/logger.js';

const log = createLogger('ssr-smoke');
const dataRoot = await mkdtemp(join(tmpdir(), 'shader-studio-ssr-smoke-'));

for (const failing of [false, true]) {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const data = join(dataRoot, failing ? 'blocked' : 'healthy');
  // A file where a directory is needed forces the real lazy initializer to fail.
  if (failing) await writeFile(data, 'blocked');

  const child = spawn(process.execPath, [join(root, 'dist/shadergrove/server/server.mjs')], {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      DATABASE_URL: '',
      SHADER_DATA_DIR: data,
      SHADER_SEED: '0',
      BETTER_AUTH_SECRET: 'ssr-smoke-secret-not-used-in-deployment',
      BETTER_AUTH_URL: 'https://ssr-smoke.example.test',
      MAIL_SMTP_URL: 'smtp://127.0.0.1:1',
      AUTH_CHECK_COMPROMISED_PASSWORDS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let spawnError: Error | undefined;
  child.on('error', (error) => {
    spawnError = error;
  });
  child.stdout.on('data', (bytes: Buffer) => {
    output += bytes.toString();
  });
  child.stderr.on('data', (bytes: Buffer) => {
    output += bytes.toString();
  });

  try {
    const base = 'http://127.0.0.1:' + port;
    let response: Response | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error('SSR server exited: ' + output.slice(-2000));
      try {
        response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(2000) });
        break;
      } catch {
        await delay(100);
      }
    }
    assert.ok(response, 'Built SSR server must start');
    assert.equal(response.status, failing ? 503 : 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(
      await response.json(),
      failing ? { error: { code: 'internal', message: 'Service unavailable' } } : { status: 'ok' },
    );

    if (failing) {
      await unlink(data);
      const recovered = await fetch(base + '/api/health', { signal: AbortSignal.timeout(5000) });
      assert.equal(recovered.status, 200);
      assert.deepEqual(await recovered.json(), { status: 'ok' });
      log.info('initialization failure returns sanitized 503; next probe recovers to 200');
    }
    const library = await fetch(base + '/api/shaders', { signal: AbortSignal.timeout(5000) });
    assert.equal(library.status, 401);

    // An emailed link carries its token in the query; a server-side redirect
    // would drop it before the app could read it.
    for (const path of ['/reset-password?token=smoke', '/verify-email?token=smoke']) {
      const page = await fetch(base + path, {
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(page.status, 200, path + ' must reach the app, not redirect');
    }
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill();
      await stopped;
    }
  }
}
log.info(
  'production SSR starts; public readiness works, the library remains protected and email links reach the app',
);
