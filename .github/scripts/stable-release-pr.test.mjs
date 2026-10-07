import assert from 'node:assert/strict';
import test from 'node:test';
import {
  requireTestedCandidate,
  requireVersionOnlyChanges,
  validateReleasePullRequest,
  prepareReleasePullRequest,
  mergeReleasePullRequest,
} from './stable-release-pr.mjs';

const repository = 'antelm-dev/shadergrove';
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const pr = {
  number: 51,
  state: 'open',
  draft: false,
  merged: false,
  base: { ref: 'master', sha: base, repo: { full_name: repository } },
  head: { ref: 'release-please--branches--master', sha: head, repo: { full_name: repository } },
  labels: [{ name: 'autorelease: pending' }],
};

test('accepts the pending repository release PR and its tested merge parents', () => {
  assert.deepEqual(validateReleasePullRequest(pr, repository), {
    number: 51,
    head_sha: head,
    base_sha: base,
  });
  requireTestedCandidate(pr, repository, head, base, base);
  validateReleasePullRequest(
    {
      ...pr,
      head: { ...pr.head, ref: 'release-please--branches--master--components--shadergrove' },
    },
    repository,
  );
});

const stable = (version, draft = false) => ({ tag_name: `v${version}`, draft, prerelease: false });
const betas = Array.from({ length: 100 }, (_, i) => ({
  tag_name: `v2.1.0-beta.${i + 1}`,
  draft: false,
  prerelease: true,
}));

function prepareFixture({ manifest = '2.0.0', releases = [stable('2.0.0')] } = {}) {
  return (...args) => {
    const path = args[1];
    if (path.includes('/pulls?')) return JSON.stringify([pr]);
    if (path.endsWith('/pulls/51')) return JSON.stringify(pr);
    if (path.includes('/files?'))
      return JSON.stringify([{ filename: 'package.json', status: 'modified' }]);
    if (path.endsWith(`/contents/.release-please-manifest.json?ref=${base}`))
      return JSON.stringify({
        content: Buffer.from(JSON.stringify({ '.': manifest })).toString('base64'),
      });
    // Stable releases sit behind a full page of betas.
    if (path.endsWith('/releases?per_page=100&page=1')) return JSON.stringify(betas);
    if (path.endsWith('/releases?per_page=100&page=2')) return JSON.stringify(releases);
    assert.fail(`Unexpected gh call: ${args}`);
  };
}

test('a rerun finds the unchanged pending PR even without Release Please outputs', async () => {
  assert.deepEqual(await prepareReleasePullRequest(repository, '', prepareFixture()), {
    number: 51,
    head_sha: head,
    base_sha: base,
    merge: true,
  });
  assert.deepEqual(await prepareReleasePullRequest(repository, '', () => '[]'), {
    merge: false,
  });
});

test('another release is not promoted until master is the newest published stable', async () => {
  for (const [manifest, releases] of [
    // 2.0.0 still awaiting desktop recovery: the 2.1.0 incident.
    ['2.0.0', [stable('2.0.0', true), stable('1.5.0')]],
    // A tag or draft with no published release.
    ['2.0.0', [stable('1.5.0')]],
    // master's manifest regressed below what is already published.
    ['2.0.0', [stable('2.0.0'), stable('2.1.0')]],
    ['2.0', [stable('2.0.0')]],
  ]) {
    await assert.rejects(
      prepareReleasePullRequest(repository, '', prepareFixture({ manifest, releases })),
      /not the newest published stable/,
    );
  }
  // Recovered 2.0.0 published after 2.1.0 does not block the 2.2.0 cycle.
  const recovered = [stable('2.1.0'), stable('2.0.0')];
  assert.equal(
    (
      await prepareReleasePullRequest(
        repository,
        '',
        prepareFixture({ manifest: '2.1.0', releases: recovered }),
      )
    ).merge,
    true,
  );
});

test('an unreadable manifest or release listing refuses the merge', async () => {
  const gh = prepareFixture();
  for (const broken of ['/contents/', '/releases?per_page=100&page=2']) {
    await assert.rejects(
      prepareReleasePullRequest(repository, '', (...args) => {
        if (args[1].includes(broken)) throw new Error('gh: HTTP 403');
        return gh(...args);
      }),
      /HTTP 403/,
    );
  }
});

function mergeFixture({ failedChecks = false, master = base, broken, ...releaseState } = {}) {
  const calls = [];
  let merged = false;
  const releaseApi = prepareFixture(releaseState);
  const gh = (...args) => {
    calls.push(args);
    if (args[0] === 'api') {
      if (args[1].endsWith('/pulls/51')) return JSON.stringify({ ...pr, merged });
      if (args[1].endsWith('/branches/master')) return JSON.stringify({ commit: { sha: master } });
      if (broken && args[1].includes(broken)) throw new Error('gh: HTTP 502');
      return releaseApi(...args);
    }
    if (args[1] === 'view') return JSON.stringify({ statusCheckRollup: [{}] });
    if (args[1] === 'checks') {
      if (failedChecks) throw new Error('CI failed');
      return '';
    }
    if (args[1] === 'merge') {
      merged = true;
      return '';
    }
    assert.fail(`Unexpected gh call: ${args}`);
  };
  return { gh, calls };
}

const mergeInput = { repository, number: '51', head, base };

test('merges the pinned head only after independent checks pass and verifies completion', async () => {
  const { gh, calls } = mergeFixture();
  assert.deepEqual(await mergeReleasePullRequest(mergeInput, gh), { merged: true });
  const merge = calls.find((args) => args[1] === 'merge');
  assert.deepEqual(merge.slice(-3), ['--squash', '--match-head-commit', head]);
  const checks = calls.findIndex((args) => args[1] === 'checks');
  assert.ok(checks < calls.indexOf(merge));
  // The predecessor is re-read after the checks, from the pinned base, on every page.
  for (const path of [`/contents/.release-please-manifest.json?ref=${base}`, '&page=2']) {
    const read = calls.findIndex((args) => args[1].endsWith(path));
    assert.ok(checks < read && read < calls.indexOf(merge), path);
  }
});

test('failed CI, a moved master or a changed predecessor never invoke merge', async () => {
  for (const options of [
    { failedChecks: true },
    { master: 'c'.repeat(40) },
    // Predecessor deleted, withdrawn to draft, or overtaken during validation.
    { releases: [stable('1.5.0')] },
    { releases: [stable('2.0.0', true)] },
    { releases: [stable('2.0.0'), stable('2.0.1')] },
    // The fresh read itself fails.
    { broken: '/contents/' },
    { broken: '/releases?per_page=100&page=2' },
  ]) {
    const { gh, calls } = mergeFixture(options);
    await assert.rejects(
      mergeReleasePullRequest(mergeInput, gh),
      /CI failed|changed during validation|not the newest published stable|HTTP 502/,
    );
    assert.equal(
      calls.some((args) => args[1] === 'merge'),
      false,
    );
  }
});

test('rejects other PRs, forks, drafts and missing release labels', () => {
  for (const change of [
    { state: 'closed' },
    { draft: true },
    { merged: true },
    { labels: [] },
    { head: { ...pr.head, ref: 'feature/example' } },
    { head: { ...pr.head, repo: { full_name: 'someone/fork' } } },
    { base: { ...pr.base, ref: 'develop' } },
    { head: { ...pr.head, sha: 'develop' } },
    { number: '51' },
  ])
    assert.throws(
      () => validateReleasePullRequest({ ...pr, ...change }, repository),
      /Release Please PR/,
    );
});

test('refuses a changed head, merge base, or master after validation', () => {
  const moved = 'c'.repeat(40);
  for (const [candidate, master] of [
    [{ ...pr, head: { ...pr.head, sha: moved } }, base],
    [{ ...pr, base: { ...pr.base, sha: moved } }, base],
    [pr, moved],
  ])
    assert.throws(
      () => requireTestedCandidate(candidate, repository, head, base, master),
      /changed during validation/,
    );
});

test('only release metadata changes can be automatically merged', () => {
  requireVersionOnlyChanges(
    [
      'package.json',
      '.release-please-manifest.json',
      'CHANGELOG.md',
      'libs/shared/src/version.ts',
    ].map((filename) => ({ filename, status: 'modified' })),
  );
  for (const files of [
    [],
    [{ filename: 'apps/studio/src/main.ts', status: 'modified' }],
    [{ filename: 'package.json', status: 'removed' }],
  ]) {
    assert.throws(() => requireVersionOnlyChanges(files), /only accept/);
  }
});
