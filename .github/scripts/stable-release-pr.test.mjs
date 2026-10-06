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
});

test('a rerun finds the unchanged pending PR even without Release Please outputs', () => {
  const gh = (...args) => {
    const path = args[1];
    if (path.includes('/pulls?')) return JSON.stringify([pr]);
    if (path.endsWith('/pulls/51')) return JSON.stringify(pr);
    if (path.includes('/files?'))
      return JSON.stringify([{ filename: 'package.json', status: 'modified' }]);
    assert.fail(`Unexpected gh call: ${args}`);
  };
  assert.deepEqual(prepareReleasePullRequest(repository, '', gh), {
    number: 51,
    head_sha: head,
    base_sha: base,
    merge: true,
  });
  assert.deepEqual(
    prepareReleasePullRequest(repository, '', () => '[]'),
    { merge: false },
  );
});

function mergeFixture({ failedChecks = false, master = base } = {}) {
  const calls = [];
  let merged = false;
  const gh = (...args) => {
    calls.push(args);
    if (args[0] === 'api') {
      if (args[1].endsWith('/pulls/51')) return JSON.stringify({ ...pr, merged });
      if (args[1].endsWith('/branches/master')) return JSON.stringify({ commit: { sha: master } });
      if (args[1].includes('/files?'))
        return JSON.stringify([{ filename: 'package.json', status: 'modified' }]);
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

test('merges the pinned head only after independent checks pass and verifies completion', () => {
  const { gh, calls } = mergeFixture();
  assert.deepEqual(mergeReleasePullRequest(mergeInput, gh), { merged: true });
  const merge = calls.find((args) => args[1] === 'merge');
  assert.deepEqual(merge.slice(-3), ['--squash', '--match-head-commit', head]);
  assert.ok(calls.findIndex((args) => args[1] === 'checks') < calls.indexOf(merge));
});

test('failed independent CI and a moved master never invoke merge', () => {
  for (const options of [{ failedChecks: true }, { master: 'c'.repeat(40) }]) {
    const { gh, calls } = mergeFixture(options);
    assert.throws(
      () => mergeReleasePullRequest(mergeInput, gh),
      /CI failed|changed during validation/,
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
