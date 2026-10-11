/**
 * Public Explore over real HTTP: a live express server, a real Better Auth and
 * a real `PublicationLibrary` on one in-memory SQLite database, exactly as
 * `router.spec.ts` does for the private API.
 *
 * Four callers, because the claims are about the differences between them: the
 * owner (Alice), another verified account (Bob), a moderator, and nobody at all.
 * The same store is also mounted a second time with the feature off, and a
 * third time with throttling on.
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LOCAL_SCOPE, ShaderLibrary } from '@shadergrove/backend/library';
import { SqliteRepository } from '@shadergrove/backend/persistence/sqlite';
import { PublicationLibrary } from '@shadergrove/backend/publication';
import { parseBundle } from '@shadergrove/shared/validate';

import { createNestApi, type NestApi } from '../bootstrap';
import { silentAuditor } from '../auth/audit';
import { createAuth } from '../auth/auth';
import { readAuthConfig } from '../auth/auth-config';
import type { Mail, Mailer } from '../auth/mailer';
import { readExploreConfig } from './explore-config';

const PASSWORD = 'correct horse battery staple';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

interface TestUser {
  id: string;
  email: string;
  cookie: string;
}

let library: ShaderLibrary;
let server: Server;
let base: string;
const apis: NestApi[] = [];
const adminUserIds = new Set<string>();

const outbox: Mail[] = [];
const mailer: Mailer = {
  send: async (mail) => {
    outbox.push(mail);
  },
};

let alice: TestUser;
let bob: TestUser;
let moderator: TestUser;

beforeAll(async () => {
  const repo = new SqliteRepository({ location: ':memory:' });
  library = new ShaderLibrary(repo, LOCAL_SCOPE);
  await library.init();
  const publications = new PublicationLibrary(repo, library);

  const app = express();
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const auth = (rateLimit: '0' | '1') =>
    createAuth(
      repo.authDatabase(),
      readAuthConfig({
        NODE_ENV: 'test',
        BETTER_AUTH_SECRET: 'test-secret-not-used-anywhere-real',
        BETTER_AUTH_URL: base,
        AUTH_TRUSTED_ORIGINS: base,
        AUTH_CHECK_COMPROMISED_PASSWORDS: '0',
        AUTH_RATE_LIMIT: rateLimit,
      }),
      mailer,
      silentAuditor,
    );
  const mount = async (prefix: string, api: Promise<NestApi>) => {
    apis.push(await api);
    app.use(`${prefix}/api`, apis.at(-1)!.handler);
  };

  const on = { adminUserIds, publications };
  await mount('', createNestApi(library, auth('0'), silentAuditor, on));
  await mount('/off', createNestApi(library, auth('0'), silentAuditor, { adminUserIds }));
  await mount('/limited', createNestApi(library, auth('1'), silentAuditor, on));

  alice = await signUp('alice@example.test', 'Alice');
  bob = await signUp('bob@example.test', 'Bob');
  moderator = await signUp('mod@example.test', 'Mod');
  adminUserIds.add(moderator.id);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const api of apis) await api.app.close();
  await library.close();
});

// --- helpers ----------------------------------------------------------------

function call(user: TestUser | null, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('origin')) headers.set('origin', base);
  if (user) headers.set('cookie', user.cookie);
  return fetch(`${base}${path}`, { ...init, headers, redirect: 'manual' });
}

function send(user: TestUser | null, method: string, path: string, body: unknown = {}) {
  return call(user, path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function json<T = Record<string, never>>(response: Response | Promise<Response>): Promise<T> {
  return (await (await response).json()) as T;
}

const status = async (response: Promise<Response>) => (await response).status;

async function signUp(email: string, name: string): Promise<TestUser> {
  await send(null, 'POST', '/api/auth/sign-up/email', { email, name, password: PASSWORD });
  const link = new URL(outbox.at(-1)!.link);
  await call(null, `${link.pathname}${link.search}`);
  const signedIn = await send(null, 'POST', '/api/auth/sign-in/email', {
    email,
    password: PASSWORD,
  });
  expect(signedIn.status).toBe(200);
  const cookie = signedIn.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0])
    .join('; ');
  const { user } = await json<{ user: { id: string } }>(signedIn);
  return { id: user.id, email, cookie };
}

interface Shader {
  id: string;
  revision: number;
}

/** A private shader with a texture and a thumbnail, as its owner last saved it. */
async function textured(user: TestUser, name: string): Promise<Shader> {
  const { shader } = await json<{ shader: Shader }>(send(user, 'POST', '/api/shaders', { name }));
  const image = { method: 'PUT', headers: { 'content-type': 'image/png' }, body: PNG };
  await call(user, `/api/shaders/${shader.id}/textures/0?width=2&height=2`, image);
  await call(user, `/api/shaders/${shader.id}/thumbnail`, image);
  return (await json<{ shader: Shader }>(call(user, `/api/shaders/${shader.id}`))).shader;
}

const terms = (shader: Shader, extra: object = {}) => ({
  expectedRevision: shader.revision,
  authorLabel: 'Alice A.',
  license: 'CC-BY-4.0',
  rightsConfirmed: true,
  ...extra,
});

async function publish(user: TestUser, name: string): Promise<{ shader: Shader; id: string }> {
  const shader = await textured(user, name);
  const response = await send(user, 'PUT', `/api/shaders/${shader.id}/publication`, terms(shader));
  expect(response.status).toBe(201);
  return { shader, id: (await json<{ publication: { id: string } }>(response)).publication.id };
}

/** Every anonymous route to one publication, as status codes. */
const publicStatuses = (id: string) =>
  Promise.all(
    ['', '/thumbnail', '/textures/0', '/export'].map((suffix) =>
      status(call(null, `/api/publications/${id}${suffix}`)),
    ),
  );

const moderate = (id: string, hidden: boolean, user: TestUser = moderator) =>
  call(user, `/api/admin/publications/${id}`).then(async (response) => {
    const revision = response.ok
      ? (await json<{ publication: { moderationRevision: number } }>(response)).publication
          .moderationRevision
      : 1;
    return send(user, 'PUT', `/api/admin/publications/${id}/moderation`, {
      hidden,
      reason: 'Test',
      expectedModerationRevision: revision,
    });
  });

// --- the feature flag -------------------------------------------------------

describe('with PUBLIC_EXPLORE_ENABLED off', () => {
  it('reads the flag as off unless it is exactly 1, and nobody as moderator by default', () => {
    expect(readExploreConfig({})).toEqual({ enabled: false, adminUserIds: new Set() });
    expect(readExploreConfig({ PUBLIC_EXPLORE_ENABLED: 'true' }).enabled).toBe(false);
    expect(
      readExploreConfig({ PUBLIC_EXPLORE_ENABLED: '1', PUBLIC_EXPLORE_ADMIN_USER_IDS: ' a, ,b ' }),
    ).toEqual({ enabled: true, adminUserIds: new Set(['a', 'b']) });
  });

  it('has no publication or moderation routes, and leaves the private API as it was', async () => {
    const { id } = await publish(alice, 'Flagged');

    expect(await json(call(moderator, '/off/api/capabilities'))).toEqual({
      publicExplore: false,
      admin: false,
    });
    const gone: readonly [string, string][] = [
      ['GET', '/off/api/publications'],
      ['GET', `/off/api/publications/${id}`],
      ['GET', `/off/api/publications/${id}/thumbnail`],
      ['GET', `/off/api/publications/${id}/export`],
      ['POST', `/off/api/publications/${id}/copy`],
      ['POST', `/off/api/publications/${id}/reports`],
      ['GET', '/off/api/shaders/flagged/publication'],
      ['PUT', '/off/api/shaders/flagged/publication'],
      ['DELETE', '/off/api/shaders/flagged/publication'],
      ['GET', '/off/api/admin/publications'],
      ['GET', '/off/api/admin/reports'],
      ['GET', '/off/api/admin/audit'],
    ];
    for (const [method, path] of gone) {
      const response = await call(moderator, path, { method });
      expect(`${method} ${path} → ${response.status}`).toBe(`${method} ${path} → 404`);
      expect((await json<{ error: { code: string } }>(response)).error.code).toBe('not_found');
    }
    expect(await status(call(alice, '/off/api/shaders/flagged'))).toBe(200);
  });
});

// --- AC-PRIVACY -------------------------------------------------------------

describe('anonymous Explore', () => {
  it('reports capabilities without ever granting an anonymous caller moderation', async () => {
    const capabilities = (user: TestUser | null) => json(call(user, '/api/capabilities'));
    expect(await capabilities(null)).toEqual({ publicExplore: true, admin: false });
    expect(await capabilities(alice)).toEqual({ publicExplore: true, admin: false });
    expect(await capabilities(moderator)).toEqual({ publicExplore: true, admin: true });
    expect((await call(null, '/api/capabilities')).headers.get('cache-control')).toBe('no-store');
  });

  it('serves a published snapshot to nobody in particular, uncached and without identities', async () => {
    const { shader, id } = await publish(alice, 'Open Work');

    const paths = ['', '/thumbnail', '/textures/0', '/export'].map(
      (suffix) => `/api/publications/${id}${suffix}`,
    );
    for (const path of ['/api/publications', '/api/publications?search=open', ...paths]) {
      const response = await fetch(base + path);
      expect(`${path} → ${response.status}`).toBe(`${path} → 200`);
      expect(`${path}: ${response.headers.get('cache-control')}`).toBe(`${path}: no-store`);
    }
    expect(new Uint8Array(await (await fetch(base + paths[2])).arrayBuffer())).toEqual(PNG);

    const detail = await (await fetch(base + paths[0])).text();
    const listing = await (await fetch(`${base}/api/publications`)).text();
    const bundle = await json<{ publication: object }>(fetch(base + paths[3]));
    for (const body of [detail, listing, JSON.stringify(bundle)]) {
      for (const secret of [alice.email, alice.id, shader.id]) expect(body).not.toContain(secret);
    }
    expect(bundle.publication).toMatchObject({ id, authorLabel: 'Alice A.', license: 'CC-BY-4.0' });
    const parsed = parseBundle(bundle);
    expect(parsed.ok && parsed.value[0].channels[0].data).toBe(Buffer.from(PNG).toString('base64'));

    // The private library is exactly as closed as before.
    expect(await status(call(null, '/api/shaders'))).toBe(401);
    expect(await status(call(null, `/api/shaders/${shader.id}`))).toBe(401);
    expect(await status(call(bob, `/api/shaders/${shader.id}`))).toBe(404);
  });

  it('asks for a verified session before anything is written', async () => {
    const { shader, id } = await publish(alice, 'Guarded');
    const writes: readonly [string, string][] = [
      ['GET', `/api/shaders/${shader.id}/publication`],
      ['PUT', `/api/shaders/${shader.id}/publication`],
      ['DELETE', `/api/shaders/${shader.id}/publication`],
      ['POST', `/api/publications/${id}/copy`],
      ['POST', `/api/publications/${id}/reports`],
      ['GET', '/api/admin/publications'],
      ['PUT', `/api/admin/publications/${id}/moderation`],
      ['GET', '/api/admin/reports'],
      ['PUT', `/api/admin/publishers/${alice.id}/restriction`],
      ['GET', '/api/admin/audit'],
    ];
    for (const [method, path] of writes) {
      const response = await call(null, path, { method });
      expect(`${method} ${path} → ${response.status}`).toBe(`${method} ${path} → 401`);
    }
  });

  it('answers a hidden, an unpublished and a made-up id identically', async () => {
    const hidden = await publish(alice, 'Hidden One');
    const unpublished = await publish(alice, 'Unpublished One');
    expect((await moderate(hidden.id, true)).status).toBe(200);
    await call(alice, `/api/shaders/${unpublished.shader.id}/publication`, { method: 'DELETE' });

    const bodies = await Promise.all(
      [hidden.id, unpublished.id, 'a'.repeat(20), 'not-an-id'].map(async (id) => {
        expect(await publicStatuses(id)).toEqual([404, 404, 404, 404]);
        return (await fetch(`${base}/api/publications/${id}`)).text();
      }),
    );
    expect(new Set(bodies).size).toBe(1);
    const titles = (
      await json<{ publications: { title: string }[] }>(fetch(`${base}/api/publications?limit=50`))
    ).publications.map((entry) => entry.title);
    expect(titles).not.toContain('Hidden One');
    expect(titles).not.toContain('Unpublished One');
  });
});

// --- AC-SNAPSHOT / AC-LIFECYCLE ---------------------------------------------

describe('publishing', () => {
  it('publishes only on request, conflicts on a stale revision, and keeps its URL on update', async () => {
    const { shader, id } = await publish(alice, 'Versioned');
    const path = `/api/shaders/${shader.id}/publication`;

    await send(alice, 'PUT', `/api/shaders/${shader.id}`, { name: 'Versioned II' });
    const title = async () =>
      (await json<{ publication: { title: string } }>(fetch(`${base}/api/publications/${id}`)))
        .publication.title;
    expect(await title()).toBe('Versioned');

    const stale = await send(alice, 'PUT', path, terms(shader));
    expect(stale.status).toBe(409);
    expect((await json<{ error: { code: string } }>(stale)).error.code).toBe('conflict');
    expect(await status(send(alice, 'PUT', path, terms(shader, { rightsConfirmed: false })))).toBe(
      400,
    );
    expect(await status(send(alice, 'PUT', path, terms(shader, { license: 'proprietary' })))).toBe(
      400,
    );

    const updated = await send(
      alice,
      'PUT',
      path,
      terms({ ...shader, revision: shader.revision + 1 }),
    );
    expect(updated.status).toBe(200);
    expect(await json(updated)).toMatchObject({ publication: { id, revision: 2 } });
    expect(await title()).toBe('Versioned II');

    expect(await json(call(alice, path))).toMatchObject({
      publication: { id, ownerVisible: true, moderatorHidden: false },
      origin: null,
      restricted: false,
    });
  });

  it('lets nobody but the owner publish, unpublish or inspect a shader’s publication', async () => {
    const { shader, id } = await publish(alice, 'Owned');
    const path = `/api/shaders/${shader.id}/publication`;

    expect(await status(call(bob, path))).toBe(404);
    expect(await status(send(bob, 'PUT', path, terms(shader)))).toBe(404);
    expect(await status(call(bob, path, { method: 'DELETE' }))).toBe(404);
    expect(await publicStatuses(id)).toEqual([200, 200, 200, 200]);
  });

  it('removes the publication with its source', async () => {
    const { shader, id } = await publish(alice, 'Short Lived');
    expect(await status(call(alice, `/api/shaders/${shader.id}`, { method: 'DELETE' }))).toBe(204);
    expect(await publicStatuses(id)).toEqual([404, 404, 404, 404]);
    expect(await status(call(moderator, `/api/admin/publications/${id}`))).toBe(404);
  });

  it('copies into the caller’s own library and carries the credit along', async () => {
    const { id } = await publish(alice, 'Shared');

    const copied = await call(bob, `/api/publications/${id}/copy`, { method: 'POST' });
    expect(copied.status).toBe(201);
    const { shader } = await json<{ shader: Shader & { author: string } }>(copied);
    expect(shader.author).toBe('Alice A.');
    const texture = await call(bob, `/api/shaders/${shader.id}/textures/0`);
    expect(new Uint8Array(await texture.arrayBuffer())).toEqual(PNG);
    expect(await status(call(alice, `/api/shaders/${shader.id}`))).toBe(404);
    expect(await json(call(bob, `/api/shaders/${shader.id}/publication`))).toMatchObject({
      publication: null,
      origin: { publicationId: id, authorLabel: 'Alice A.', license: 'CC-BY-4.0' },
    });
  });
});

// --- cross-site requests ----------------------------------------------------

describe('trusted origins', () => {
  it('refuses a cookie-authenticated write from another origin, or from none', async () => {
    const { shader, id } = await publish(alice, 'Targeted');
    const evil = { origin: 'https://evil.example', 'content-type': 'application/json' };
    const attempts: readonly [TestUser, string, string, unknown][] = [
      [alice, 'DELETE', `/api/shaders/${shader.id}/publication`, {}],
      [alice, 'PUT', `/api/shaders/${shader.id}/publication`, terms(shader)],
      [bob, 'POST', `/api/publications/${id}/copy`, {}],
      [bob, 'POST', `/api/publications/${id}/reports`, { reason: 'spam' }],
      [
        moderator,
        'PUT',
        `/api/admin/publications/${id}/moderation`,
        { hidden: true, reason: 'Forged', expectedModerationRevision: 1 },
      ],
      [
        moderator,
        'PUT',
        `/api/admin/publishers/${alice.id}/restriction`,
        { restricted: true, reason: 'Forged', expectedRevision: 0 },
      ],
    ];
    for (const [user, method, path, body] of attempts) {
      const init = { method, body: JSON.stringify(body) };
      const crossSite = await call(user, path, { ...init, headers: evil });
      expect(`${method} ${path} → ${crossSite.status}`).toBe(`${method} ${path} → 403`);
      const noOrigin = await fetch(base + path, {
        ...init,
        headers: { cookie: user.cookie, 'content-type': 'application/json' },
      });
      expect(`${method} ${path} → ${noOrigin.status}`).toBe(`${method} ${path} → 403`);
    }

    // None of it happened.
    expect(await publicStatuses(id)).toEqual([200, 200, 200, 200]);
    expect(await json(call(moderator, `/api/admin/publishers/${alice.id}/restriction`))).toEqual({
      restriction: {
        userId: alice.id,
        restricted: false,
        revision: 0,
        reason: '',
        updatedAt: null,
      },
    });
    const audit = await json<{ entries: { reason: string }[] }>(
      call(moderator, '/api/admin/audit'),
    );
    expect(audit.entries.map((entry) => entry.reason)).not.toContain('Forged');
  });
});

// --- AC-MODERATION ----------------------------------------------------------

describe('moderation', () => {
  it('is open to configured moderators only', async () => {
    const { id } = await publish(alice, 'Watched');
    const routes: readonly [string, string][] = [
      ['GET', '/api/admin/publications'],
      ['GET', `/api/admin/publications/${id}`],
      ['GET', `/api/admin/publications/${id}/thumbnail`],
      ['PUT', `/api/admin/publications/${id}/moderation`],
      ['GET', '/api/admin/reports'],
      ['POST', '/api/admin/reports/anything/resolution'],
      ['GET', `/api/admin/publishers/${alice.id}/restriction`],
      ['PUT', `/api/admin/publishers/${alice.id}/restriction`],
      ['GET', '/api/admin/audit'],
    ];
    for (const [method, path] of routes) {
      const response = await (method === 'GET' ? call(bob, path) : send(bob, method, path));
      expect(`${method} ${path} → ${response.status}`).toBe(`${method} ${path} → 403`);
      expect((await json<{ error: { code: string } }>(response)).error.code).toBe('forbidden');
    }
    // The owner is not a moderator of their own work either.
    expect((await moderate(id, true, alice)).status).toBe(403);
    expect(await publicStatuses(id)).toEqual([200, 200, 200, 200]);
  });

  it('hides a publication under load without an owner being able to bring it back', async () => {
    const { shader, id } = await publish(alice, 'Contested');

    // Readers mid-flight while the hide lands see it or a 404 — never an error.
    const racing = Array.from({ length: 24 }, () => publicStatuses(id));
    const hidden = await moderate(id, true);
    expect(hidden.status).toBe(200);
    for (const statuses of await Promise.all(racing)) {
      for (const code of statuses) expect([200, 404]).toContain(code);
    }
    expect(await publicStatuses(id)).toEqual([404, 404, 404, 404]);
    expect(await status(call(bob, `/api/publications/${id}/copy`, { method: 'POST' }))).toBe(404);
    // A moderator still reads it, bytes included.
    expect(await status(call(moderator, `/api/admin/publications/${id}/textures/0`))).toBe(200);

    const path = `/api/shaders/${shader.id}/publication`;
    expect(await json(send(alice, 'PUT', path, terms(shader)))).toMatchObject({
      publication: { id, moderatorHidden: true },
    });
    await call(alice, path, { method: 'DELETE' });
    await send(alice, 'PUT', path, terms(shader));
    expect(await publicStatuses(id)).toEqual([404, 404, 404, 404]);

    // Restoring does not undo the owner's own unpublish.
    await call(alice, path, { method: 'DELETE' });
    expect((await moderate(id, false)).status).toBe(200);
    expect(await publicStatuses(id)).toEqual([404, 404, 404, 404]);
    await send(alice, 'PUT', path, terms(shader));
    expect(await publicStatuses(id)).toEqual([200, 200, 200, 200]);

    const stale = await send(moderator, 'PUT', `/api/admin/publications/${id}/moderation`, {
      hidden: true,
      reason: 'Late',
      expectedModerationRevision: 1,
    });
    expect(stale.status).toBe(409);
    const audit = await json<{ entries: { action: string; actorUserId: string }[] }>(
      call(moderator, `/api/admin/audit?targetId=${id}`),
    );
    expect(audit.entries.map((entry) => entry.action).sort()).toEqual([
      'publication.hide',
      'publication.restore',
    ]);
    expect(audit.entries.every((entry) => entry.actorUserId === moderator.id)).toBe(true);
  });

  it('takes one open report per account and resolves it with a reason', async () => {
    const { id } = await publish(alice, 'Reported');
    const report = () =>
      send(bob, 'POST', `/api/publications/${id}/reports`, { reason: 'copyright', body: 'Mine' });

    expect(await status(report())).toBe(201);
    expect(await status(report())).toBe(409);
    expect(
      await status(send(bob, 'POST', `/api/publications/${id}/reports`, { reason: 'nope' })),
    ).toBe(400);

    const { reports } = await json<{ reports: { id: string; reporterUserId: string }[] }>(
      call(moderator, `/api/admin/reports?publicationId=${id}`),
    );
    expect(reports).toMatchObject([{ reporterUserId: bob.id, reason: 'copyright', body: 'Mine' }]);
    // Who reported is the moderators' business only.
    expect(await (await fetch(`${base}/api/publications/${id}`)).text()).not.toContain(bob.id);

    const resolve = (body: object) =>
      send(moderator, 'POST', `/api/admin/reports/${reports[0].id}/resolution`, body);
    expect(await status(resolve({ expectedRevision: 1 }))).toBe(400);
    expect(await status(resolve({ reason: 'Checked', expectedRevision: 1 }))).toBe(200);
    expect(await status(resolve({ reason: 'Again', expectedRevision: 1 }))).toBe(409);
    expect(await status(report())).toBe(201);
  });

  it('restricts a publisher: nothing public, no publishing, private editing intact', async () => {
    const carol = await signUp('carol@example.test', 'Carol');
    const { shader, id } = await publish(carol, 'Carols');
    const path = `/api/admin/publishers/${carol.id}/restriction`;
    const restrict = (restricted: boolean, expectedRevision: number) =>
      send(moderator, 'PUT', path, { restricted, reason: 'Abuse', expectedRevision });

    expect(await status(restrict(true, 0))).toBe(200);
    expect(await status(restrict(true, 0))).toBe(409);
    expect(await publicStatuses(id)).toEqual([404, 404, 404, 404]);

    const blocked = await send(
      carol,
      'PUT',
      `/api/shaders/${shader.id}/publication`,
      terms(shader),
    );
    expect(blocked.status).toBe(403);
    expect((await json<{ error: { code: string } }>(blocked)).error.code).toBe('forbidden');
    expect(await json(call(carol, `/api/shaders/${shader.id}/publication`))).toMatchObject({
      restricted: true,
      publication: { moderatorHidden: true },
    });
    expect(await status(send(carol, 'PUT', `/api/shaders/${shader.id}`, { name: 'Edited' }))).toBe(
      200,
    );

    expect(await status(restrict(false, 1))).toBe(200);
    expect(await publicStatuses(id)).toEqual([404, 404, 404, 404]);
    expect((await moderate(id, false)).status).toBe(200);
    expect(await publicStatuses(id)).toEqual([200, 200, 200, 200]);
    expect(await status(call(moderator, '/api/admin/publishers/no-such-account/restriction'))).toBe(
      404,
    );
  });
});

// --- limits -----------------------------------------------------------------

describe('request limits', () => {
  it('throttles reports per account', async () => {
    const { id } = await publish(alice, 'Flooded');
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      statuses.push(
        await status(
          send(bob, 'POST', `/limited/api/publications/${id}/reports`, { reason: 'spam' }),
        ),
      );
    }
    expect(statuses[0]).toBe(201);
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.filter((code) => code === 201)).toHaveLength(1);
  });

  it('caps a page at 50 and rejects a malformed page request', async () => {
    const page = await json<{ publications: unknown[]; nextCursor: string | null }>(
      fetch(`${base}/api/publications?limit=2`),
    );
    expect(page.publications).toHaveLength(2);
    const next = await json<{ publications: unknown[] }>(
      fetch(`${base}/api/publications?limit=2&cursor=${page.nextCursor}`),
    );
    expect(next.publications).toHaveLength(2);
    expect(next.publications).not.toEqual(page.publications);

    for (const query of ['limit=0', 'limit=abc', 'cursor=%7B', `search=${'x'.repeat(65)}`]) {
      expect(await status(fetch(`${base}/api/publications?${query}`))).toBe(400);
    }
  });

  it('sorts by update or first publication, with cursors bound to their query', async () => {
    const list = (query: string) => fetch(`${base}/api/publications?${query}`);
    for (const sort of ['', 'sort=updated', 'sort=published']) {
      const response = await list(`limit=1&${sort}`);
      expect(`${sort} → ${response.status} ${response.headers.get('cache-control')}`).toBe(
        `${sort} → 200 no-store`,
      );
    }

    const page = await json<{ nextCursor: string }>(list('limit=1&sort=published'));
    expect(await status(list(`limit=1&sort=published&cursor=${page.nextCursor}`))).toBe(200);
    for (const query of [
      `sort=updated&cursor=${page.nextCursor}`,
      `sort=published&search=x&cursor=${page.nextCursor}`,
      'sort=oldest',
      'sort=updated&sort=published',
      `cursor=${'a'.repeat(1025)}`,
    ]) {
      const response = await list(query);
      expect(`${query.slice(0, 40)} → ${response.status}`).toBe(`${query.slice(0, 40)} → 400`);
      expect((await json<{ error: { code: string } }>(response)).error.code).toBe('invalid');
    }

    // A cursor an older server handed out still continues the default order.
    const [first] = (
      await json<{ publications: { id: string; updatedAt: string }[] }>(list('limit=1'))
    ).publications;
    const legacy = Buffer.from(JSON.stringify({ at: first.updatedAt, id: first.id })).toString(
      'base64url',
    );
    const rest = await json<{ publications: { id: string }[] }>(list(`cursor=${legacy}`));
    expect(rest.publications.map((entry) => entry.id)).not.toContain(first.id);
    expect(await status(list(`sort=published&cursor=${legacy}`))).toBe(400);

    const doc = await json<{
      paths: Record<string, { get?: { parameters?: { name: string; schema?: object }[] } }>;
    }>(fetch(`${base}/api/docs-json`));
    const parameters = doc.paths['/publications']?.get?.parameters ?? [];
    expect(parameters.find((parameter) => parameter.name === 'sort')?.schema).toMatchObject({
      enum: ['updated', 'published'],
    });
  });
});
