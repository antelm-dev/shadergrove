import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_SCOPE, ShaderLibrary } from '@shadergrove/backend/library';
import { SqliteRepository } from '@shadergrove/backend/persistence/sqlite';
import { createAuth } from '../auth/auth';
import { readAuthConfig } from '../auth/auth-config';
import { createNestApi, type NestApi } from '../bootstrap';

const realFetch = globalThis.fetch;
let api: NestApi;
let server: Server;
let library: ShaderLibrary;
let base: string;
const github = vi.fn<typeof fetch>();

beforeEach(async () => {
  github.mockReset();
  vi.stubGlobal('fetch', (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    String(input).startsWith('https://api.github.com/')
      ? github(input, init)
      : realFetch(input, init),
  );
  const repository = new SqliteRepository({ location: ':memory:' });
  library = new ShaderLibrary(repository, LOCAL_SCOPE);
  await library.init();
  const app = express();
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = createAuth(
    repository.authDatabase(),
    readAuthConfig({
      NODE_ENV: 'test',
      BETTER_AUTH_SECRET: 'release-test-secret-not-for-production',
      BETTER_AUTH_URL: base,
      AUTH_TRUSTED_ORIGINS: base,
      AUTH_CHECK_COMPROMISED_PASSWORDS: '0',
    }),
  );
  api = await createNestApi(library, auth);
  app.use('/api', api.handler);
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await api.app.close();
  await library.close();
  vi.unstubAllGlobals();
});

describe('public releases HTTP API', () => {
  it('allows anonymous cross-origin catalogue reads without opening account or shader routes', async () => {
    github.mockResolvedValue(new Response('[]'));
    const response = await fetch(`${base}/api/releases`, {
      headers: { Origin: 'https://website.example' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    expect(await response.json()).toEqual({ releases: [], nextPage: null });
    const protectedResponse = await fetch(`${base}/api/shaders`, {
      headers: { Origin: 'https://website.example' },
    });
    expect(protectedResponse.status).toBe(401);
    expect(protectedResponse.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects invalid channels, pages and versions before contacting GitHub', async () => {
    for (const path of [
      '?channel=nightly',
      '?page=0',
      '?page=101',
      '?page=1&page=2',
      '/bad-version',
      '/latest?channel=nightly',
    ]) {
      expect((await fetch(`${base}/api/releases${path}`)).status).toBe(400);
    }
    expect(github).not.toHaveBeenCalled();
  });

  it('returns a sanitized, uncached error that remains readable by the website', async () => {
    github.mockRejectedValue(new Error('private upstream details'));
    const response = await fetch(`${base}/api/releases/latest`);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(await response.json()).toEqual({
      error: { code: 'internal', message: 'Release information is temporarily unavailable' },
    });
  });

  it('distinguishes no latest release from a missing version', async () => {
    github.mockResolvedValue(new Response('', { status: 404 }));
    const latest = await fetch(`${base}/api/releases/latest`);
    expect(latest.status).toBe(200);
    expect(await latest.json()).toEqual({ release: null });
    expect((await fetch(`${base}/api/releases/99.0.0`)).status).toBe(404);
  });
});
