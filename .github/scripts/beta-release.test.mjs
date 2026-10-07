import assert from 'node:assert/strict';
import test from 'node:test';
import { readGitHub, resolveBetaRelease } from './beta-release.mjs';

const sha = 'a'.repeat(40);
const input = { event: 'push', ref: 'refs/heads/develop', sha, base: '2.0.0', runNumber: '42' };
const stable = (version, draft = false) => ({ tag_name: `v${version}`, draft, prerelease: false });
const beta = (release) => ({
  tag_name: 'v2.0.0-beta.42',
  draft: false,
  prerelease: true,
  ...release,
});
const remote =
  ({ releases = [], tagSha = null } = {}) =>
  async (path) => {
    if (path.startsWith('releases?')) return path.endsWith('&page=1') ? releases : [];
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
  const draft = beta({ draft: true, target_commitish: sha });
  for (const tagSha of [null, sha]) {
    assert.equal(
      (await resolveBetaRelease(input, remote({ releases: [draft], tagSha }))).publish,
      true,
    );
  }
  await assert.rejects(
    resolveBetaRelease(input, remote({ releases: [{ ...draft, target_commitish: 'develop' }] })),
    /another commit/,
  );
});

test('existing betas are still recovered or skipped after their stable cycle advanced', async () => {
  const later = [stable('2.0.0'), stable('2.1.0')];
  const draft = beta({ draft: true, target_commitish: sha });
  assert.equal(
    (await resolveBetaRelease(input, remote({ releases: [draft, ...later] }))).publish,
    true,
  );
  assert.equal(
    (await resolveBetaRelease(input, remote({ releases: [beta(), ...later], tagSha: sha })))
      .publish,
    false,
  );
});

test('published prereleases at the same commit are skipped', async () => {
  const published = beta({ target_commitish: 'develop' });
  assert.equal(
    (await resolveBetaRelease(input, remote({ releases: [published], tagSha: sha }))).publish,
    false,
  );
  await assert.rejects(
    resolveBetaRelease(input, remote({ releases: [published] })),
    /another commit/,
  );
});

test('tag collisions, duplicate releases and releases in the wrong channel are refused', async () => {
  await assert.rejects(
    resolveBetaRelease(input, remote({ tagSha: 'b'.repeat(40) })),
    /another commit/,
  );
  await assert.rejects(
    resolveBetaRelease(input, remote({ releases: [beta({ prerelease: false })], tagSha: sha })),
    /prerelease/,
  );
  await assert.rejects(
    resolveBetaRelease(input, remote({ releases: [beta(), beta({ draft: true })], tagSha: sha })),
    /Several releases/,
  );
});

test('new beta bases must be strictly newer than the highest published stable', async () => {
  for (const [base, releases] of [
    ['2.0.0', [stable('2.0.0')]],
    ['2.1.0', [stable('2.0.0'), stable('2.1.0')]],
    ['2.1.0', [stable('2.2.0')]],
    ['1.9.0', [stable('2.0.0', true), stable('1.10.0')]],
  ]) {
    await assert.rejects(resolveBetaRelease({ ...input, base }, remote({ releases })), /not newer/);
  }
  // A bare tag without a release is not an existing beta and gets no exemption.
  await assert.rejects(
    resolveBetaRelease(input, remote({ releases: [stable('2.0.0')], tagSha: sha })),
    /not newer/,
  );
  // Manual versions are held to the same rule.
  await assert.rejects(
    resolveBetaRelease(
      { ...input, event: 'workflow_dispatch', version: '2.1.0-beta.3' },
      remote({ releases: [stable('2.1.0')] }),
    ),
    /not newer/,
  );
  // Drafts and prereleases do not end a cycle.
  const pending = [stable('2.1.0'), stable('2.2.0', true), beta({ tag_name: 'v3.0.0-beta.1' })];
  assert.equal(
    (await resolveBetaRelease({ ...input, base: '2.2.0' }, remote({ releases: pending }))).version,
    '2.2.0-beta.42',
  );
});

test('unreadable or malformed release listings abort before publication', async () => {
  for (const releases of [null, { message: 'nope' }, [{ tag_name: 'v1.0.0' }], [stable('2')]]) {
    await assert.rejects(resolveBetaRelease(input, remote({ releases })));
  }
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
