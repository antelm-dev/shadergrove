import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readGitHub } from './beta-release.mjs';

export const repository = 'antelm-dev/shadergrove';
const sha = /^[a-f0-9]{40}$/;
const number = (value) => Number.isSafeInteger(value) && value > 0;

export function eligible(pr) {
  return (
    pr.state === 'open' &&
    !pr.draft &&
    pr.base?.ref === 'develop' &&
    pr.base?.repo?.full_name === repository &&
    pr.head?.repo?.full_name === repository &&
    pr.labels?.some((label) => label.name === 'preview')
  );
}

export function validateSource(pr, run, source) {
  if (
    run.event !== 'pull_request' ||
    run.path !== '.github/workflows/ci.yml' ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    run.head_repository?.full_name !== repository ||
    run.head_sha !== pr.head.sha ||
    source.repository !== repository ||
    source.pr !== pr.number ||
    source.run !== run.id ||
    source.head !== pr.head.sha ||
    source.base !== pr.base.sha ||
    source.commit !== pr.merge_commit_sha ||
    !sha.test(source.commit) ||
    !sha.test(source.head) ||
    !sha.test(source.base)
  ) {
    throw new Error('Preview source does not match the current PR and successful CI run');
  }
}

export async function resolvePreview(eventName, event, read, readSource) {
  if (eventName === 'schedule') return { action: 'prune' };
  let prNumber = event.number || Number(event.inputs?.pr);
  let triggeredRun;
  if (eventName === 'workflow_run') {
    triggeredRun = await read(`actions/runs/${event.workflow_run.id}`);
    if (triggeredRun.event !== 'pull_request' || triggeredRun.path !== '.github/workflows/ci.yml')
      return { action: 'none' };
    const prs = await read(`commits/${triggeredRun.head_sha}/pulls?per_page=100`);
    prNumber = prs.find(eligible)?.number;
    if (!prNumber) return { action: 'none' };
  } else if (!['pull_request_target', 'workflow_dispatch'].includes(eventName)) {
    throw new Error('Unsupported preview trigger');
  }
  if (!number(prNumber)) throw new Error('Expected a PR number');
  const pr = await read(`pulls/${prNumber}`);
  if (!pr || pr.base.repo.full_name !== repository) throw new Error('Unknown repository PR');
  if (!eligible(pr)) {
    const requested =
      eventName === 'workflow_dispatch' ||
      event.label?.name === 'preview' ||
      event.pull_request?.labels?.some((label) => label.name === 'preview');
    return requested ? { action: 'delete', pr: prNumber } : { action: 'none' };
  }
  const runs = await read(
    `actions/workflows/ci.yml/runs?event=pull_request&head_sha=${pr.head.sha}&per_page=20`,
  );
  const run = runs.workflow_runs[0];
  const pending = {
    action: 'none',
    pr: prNumber,
    reason: 'Waiting for successful CI on the current PR commit.',
  };
  if (!run || run.status !== 'completed' || run.conclusion !== 'success') return pending;
  if (triggeredRun && triggeredRun.id !== run.id) return pending;
  const artifacts = await read(`actions/runs/${run.id}/artifacts?per_page=100`);
  const artifact = artifacts.artifacts.find(
    (item) => item.name === 'preview-source' && !item.expired,
  );
  if (!artifact)
    return {
      ...pending,
      reason: 'CI has no preview source record; rerun CI to enable this preview.',
    };
  const source = await readSource(artifact.id);
  validateSource(pr, run, source);
  return {
    action: 'deploy',
    pr: prNumber,
    run: run.id,
    head: source.head,
    base: source.base,
    commit: source.commit,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.GITHUB_REPOSITORY !== repository)
    throw new Error('Unexpected preview repository');
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const readSource = (id) => {
    if (!number(id)) throw new Error('Invalid artifact ID');
    const archive = execFileSync('gh', ['api', `repos/${repository}/actions/artifacts/${id}/zip`], {
      maxBuffer: 1024 * 1024,
    });
    const source = execFileSync('python3', ['.github/scripts/read-preview-source.py'], {
      input: archive,
      maxBuffer: 4096,
    });
    return JSON.parse(source);
  };
  const target = await resolvePreview(process.env.GITHUB_EVENT_NAME, event, readGitHub, readSource);
  for (const [key, value] of Object.entries(target))
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  console.log(JSON.stringify(target));
}
