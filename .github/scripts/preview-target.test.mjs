import assert from 'node:assert/strict';
import test from 'node:test';
import { eligible, repository, resolvePreview, validateSource } from './preview-target.mjs';

const head = 'a'.repeat(40),
  base = 'b'.repeat(40),
  commit = 'c'.repeat(40);
const pr = {
  number: 52,
  state: 'open',
  draft: false,
  labels: [{ name: 'preview' }],
  head: { sha: head, repo: { full_name: repository } },
  base: { ref: 'develop', sha: base, repo: { full_name: repository } },
  merge_commit_sha: commit,
};
const run = {
  id: 123,
  event: 'pull_request',
  path: '.github/workflows/ci.yml',
  status: 'completed',
  conclusion: 'success',
  head_sha: head,
  head_repository: { full_name: repository },
};
const source = { repository, pr: 52, run: 123, head, base, commit };
function fixture({
  currentPR = pr,
  currentRun = run,
  artifacts = [{ id: 456, name: 'preview-source', expired: false }],
} = {}) {
  return async (path) => {
    if (path === 'pulls/52') return currentPR;
    if (path.startsWith('commits/')) return [currentPR];
    if (path === 'actions/runs/123') return currentRun;
    if (path.startsWith('actions/workflows/')) return { workflow_runs: [currentRun] };
    if (path.startsWith('actions/runs/123/artifacts')) return { artifacts };
    assert.fail(`Unexpected request: ${path}`);
  };
}

test('only labelled, non-draft, same-repository PRs into develop qualify', () => {
  assert.equal(eligible(pr), true);
  for (const change of [
    { draft: true },
    { state: 'closed' },
    { labels: [] },
    { head: { ...pr.head, repo: { full_name: 'someone/fork' } } },
    { base: { ...pr.base, ref: 'master' } },
  ])
    assert.ok(!eligible({ ...pr, ...change }));
});

test('a label applied after CI deploys exactly the recorded merge commit', async () => {
  const target = await resolvePreview(
    'pull_request_target',
    { number: 52 },
    fixture(),
    async () => source,
  );
  assert.deepEqual(target, { action: 'deploy', pr: 52, run: 123, head, base, commit });
});

test('CI completion finds the PR even when workflow_run.pull_requests is empty', async () => {
  assert.equal(
    (
      await resolvePreview(
        'workflow_run',
        { workflow_run: { id: 123, pull_requests: [] } },
        fixture(),
        async () => source,
      )
    ).action,
    'deploy',
  );
});

test('failed, pending, missing-artifact and expired-artifact runs never deploy', async () => {
  for (const options of [
    { currentRun: { ...run, conclusion: 'failure' } },
    { currentRun: { ...run, status: 'in_progress' } },
    { artifacts: [] },
    { artifacts: [{ id: 456, name: 'preview-source', expired: true }] },
  ]) {
    assert.equal(
      (
        await resolvePreview('pull_request_target', { number: 52 }, fixture(options), () =>
          assert.fail('No artifact read'),
        )
      ).action,
      'none',
    );
  }
});

test('stale heads, bases, merge commits, run IDs and substituted records are refused', () => {
  for (const changes of [
    { repository: 'someone/fork' },
    { pr: 53 },
    { run: 124 },
    { head: 'd'.repeat(40) },
    { base: 'd'.repeat(40) },
    { commit: head },
  ]) {
    assert.throws(() => validateSource(pr, run, { ...source, ...changes }), /does not match/);
  }
  assert.throws(() => validateSource(pr, { ...run, event: 'push' }, source), /does not match/);
});

test('cleanup uses current API state, including a label removed after CI', async () => {
  for (const changes of [{ state: 'closed' }, { labels: [] }, { draft: true }]) {
    assert.deepEqual(
      await resolvePreview(
        'pull_request_target',
        { number: 52, label: { name: 'preview' } },
        fixture({ currentPR: { ...pr, ...changes } }),
        () => assert.fail(),
      ),
      { action: 'delete', pr: 52 },
    );
  }
  assert.deepEqual(
    await resolvePreview(
      'schedule',
      {},
      () => assert.fail(),
      () => assert.fail(),
    ),
    { action: 'prune' },
  );
});
