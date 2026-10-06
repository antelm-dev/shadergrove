import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const pr = event.pull_request;
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const parents = execFileSync('git', ['cat-file', '-p', commit], { encoding: 'utf8' })
  .split('\n')
  .filter((line) => line.startsWith('parent '))
  .map((line) => line.slice(7));
if (parents.join(' ') !== `${pr.base.sha} ${pr.head.sha}`) {
  throw new Error('Preview source must be the CI-tested PR merge commit');
}
writeFileSync(
  join(process.env.RUNNER_TEMP, 'preview-source.json'),
  JSON.stringify({
    repository: process.env.GITHUB_REPOSITORY,
    pr: pr.number,
    run: Number(process.env.GITHUB_RUN_ID),
    head: pr.head.sha,
    base: pr.base.sha,
    commit,
  }),
);
