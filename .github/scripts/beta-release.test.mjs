import assert from 'node:assert/strict';
import test from 'node:test';
import { readGitHub, resolveBetaRelease } from './beta-release.mjs';

const sha = 'a'.repeat(40);
const input = { event: 'push', ref: 'refs/heads/develop', sha, base: '2.0.0', runNumber: '42' };
const remote =
  (release = null, tagSha = null) =>
  async (path) => {
    if (path.startsWith('releases/')) return release;
    if (path.startsWith('git/ref/')) return tagSha ? { object: { sha: tagSha } } : null;
    if (path.startsWith('commits/')) return { sha: tagSha };
    throw new Error(`Unexpected API path: ${path}`);
  };

test('automatic numbering is stable across retries and does not use the attempt number', async () => {
  const target = { version: '2.0.0-beta.42', tag: 'v2.0.0-beta.42', sha, publish: true };
  assert.deepEqual(await resolveBetaRelease(input, remote()), target);
  assert.deepEqual(await resolveBetaRelease({ ...input, attempt: '2' }, remote()), target);
});

test('manual dispatch accepts an explicit beta version or generates one', async () => {
  const manual = { ...input, event: 'workflow_dispatch', version: '2.1.0-beta.7' };
  assert.equal((await resolveBetaRelease(manual, remote())).version, manual.version);
  assert.equal(
    (await resolveBetaRelease({ ...manual, version: '' }, remote())).version,
    '2.0.0-beta.42',
  );
});

test('draft recovery requires the original commit, with or without an existing tag', async () => {
  const draft = { draft: true, prerelease: true, target_commitish: sha };
  for (const tagSha of [null, sha]) {
    assert.equal((await resolveBetaRelease(input, remote(draft, tagSha))).publish, true);
  }
  await assert.rejects(
    resolveBetaRelease(input, remote({ ...draft, target_commitish: 'develop' })),
    /another commit/,
  );
});

test('published prereleases at the same commit are skipped', async () => {
  const published = { draft: false, prerelease: true, target_commitish: 'develop' };
  assert.equal((await resolveBetaRelease(input, remote(published, sha))).publish, false);
  await assert.rejects(resolveBetaRelease(input, remote(published)), /another commit/);
});

test('tag collisions and releases in the wrong channel are refused', async () => {
  await assert.rejects(resolveBetaRelease(input, remote(null, 'b'.repeat(40))), /another commit/);
  await assert.rejects(
    resolveBetaRelease(input, remote({ draft: false, prerelease: false }, sha)),
    /prerelease/,
  );
});

test('a published stable version requires a new beta base, while its draft does not', async () => {
  const read = (draft) => async (path) =>
    path === 'releases/tags/v2.0.0' ? { draft, prerelease: false } : null;
  await assert.rejects(resolveBetaRelease(input, read(false)), /already released/);
  assert.equal((await resolveBetaRelease(input, read(true))).publish, true);
});

test('invalid versions and non-develop events fail before reading GitHub', async () => {
  for (const change of [
    { ref: 'refs/heads/master' },
    { event: 'pull_request' },
    { sha: 'develop' },
    { base: '2.0.0-beta.1' },
    { runNumber: '0' },
    { runNumber: '01' },
    { version: '2.0.0' },
    { version: '2.0.0-beta.01' },
    { version: '2.0.0-beta.1\npublish=true' },
  ]) {
    await assert.rejects(
      resolveBetaRelease({ ...input, ...change }, () => assert.fail('Must not read GitHub')),
    );
  }
});

test('only HTTP 404 means absent; permission and server errors abort publication', async () => {
  assert.equal(
    await readGitHub(
      'releases/tags/v2.0.0-beta.42',
      async () => new Response(null, { status: 404 }),
    ),
    null,
  );
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(
      readGitHub('releases/tags/v2.0.0-beta.42', async () => new Response(null, { status })),
      new RegExp(`HTTP ${status}`),
    );
  }
});
