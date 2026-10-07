import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  findRelease,
  highestPublishedStable,
  listReleases,
  readReleasePage,
  stableVersion,
} from './releases.mjs';

export function validateReleasePullRequest(pr, repository) {
  if (
    pr.state !== 'open' ||
    pr.draft ||
    pr.merged ||
    pr.base?.ref !== 'master' ||
    pr.base?.repo?.full_name !== repository ||
    ![
      'release-please--branches--master',
      'release-please--branches--master--components--shadergrove',
    ].includes(pr.head?.ref) ||
    pr.head?.repo?.full_name !== repository ||
    !pr.labels?.some((label) => label.name === 'autorelease: pending') ||
    !Number.isSafeInteger(pr.number) ||
    pr.number <= 0 ||
    !/^[a-f0-9]{40}$/.test(pr.head.sha) ||
    !/^[a-f0-9]{40}$/.test(pr.base.sha)
  ) {
    throw new Error('Expected an open Release Please PR from this repository into master');
  }
  return { number: pr.number, head_sha: pr.head.sha, base_sha: pr.base.sha };
}

export function requireTestedCandidate(pr, repository, head, base, master) {
  const target = validateReleasePullRequest(pr, repository);
  if (target.head_sha !== head || target.base_sha !== base || master !== base) {
    throw new Error('Release PR or master changed during validation; rerun the release workflow');
  }
}

export function requireVersionOnlyChanges(files) {
  const allowed = new Set([
    'package.json',
    '.release-please-manifest.json',
    'CHANGELOG.md',
    'libs/shared/src/version.ts',
  ]);
  if (
    !files.length ||
    files.some((file) => !allowed.has(file.filename) || file.status !== 'modified')
  ) {
    throw new Error(
      'Automatic release PR merges only accept release version and changelog changes',
    );
  }
}

// master's committed version must be the newest published stable release. A
// draft (unverified assets), missing release or regressed manifest blocks
// promotion until that release is recovered or the branch is corrected.
export function requirePublishedPredecessor(version, releases) {
  const release = stableVersion.test(version) ? findRelease(releases, `v${version}`) : null;
  if (
    !release ||
    release.draft ||
    release.prerelease ||
    highestPublishedStable(releases) !== version
  ) {
    throw new Error(
      `master is at ${version}, which is not the newest published stable release; publish it (gh workflow run release.yml --ref master -f tag=v${version}) or correct master before promoting another release`,
    );
  }
}

// Reads the manifest at the exact base commit and a fresh, complete release list.
async function requirePublishedPredecessorAt(api, sha) {
  const manifest = api(`contents/.release-please-manifest.json?ref=${sha}`);
  requirePublishedPredecessor(
    JSON.parse(Buffer.from(manifest.content, 'base64').toString('utf8'))['.'],
    await listReleases(readReleasePage(api)),
  );
}

export async function prepareReleasePullRequest(repository, releasePr, gh) {
  const api = (path) => JSON.parse(gh('api', `repos/${repository}/${path}`));
  // Release Please may leave an unchanged PR out of its outputs on a rerun.
  const result = releasePr
    ? JSON.parse(releasePr)
    : api('pulls?state=open&base=master&per_page=100').find((pr) =>
        [
          'release-please--branches--master',
          'release-please--branches--master--components--shadergrove',
        ].includes(pr.head?.ref),
      );
  if (!result) return { merge: false };
  const pr = api(`pulls/${result.number}`);
  const target = validateReleasePullRequest(pr, repository);
  requireVersionOnlyChanges(api(`pulls/${target.number}/files?per_page=100`));
  await requirePublishedPredecessorAt(api, target.base_sha);
  return { ...target, merge: true };
}

export async function mergeReleasePullRequest({ repository, number, head, base }, gh) {
  const api = (path) => JSON.parse(gh('api', `repos/${repository}/${path}`));
  if (!/^[1-9]\d*$/.test(number)) throw new Error('Expected a release PR number');
  const checks = JSON.parse(
    gh('pr', 'view', number, '--repo', repository, '--json', 'statusCheckRollup'),
  ).statusCheckRollup;
  // GITHUB_TOKEN-created PRs may have no independent CI runs. The workflow
  // always validates their merge commit itself; also wait for any other checks.
  if (checks.length)
    gh('pr', 'checks', number, '--repo', repository, '--watch', '--fail-fast', '--interval', '10');
  requireTestedCandidate(
    api(`pulls/${number}`),
    repository,
    head,
    base,
    api('branches/master').commit.sha,
  );
  requireVersionOnlyChanges(api(`pulls/${number}/files?per_page=100`));
  // The predecessor may have been withdrawn or overtaken during validation.
  await requirePublishedPredecessorAt(api, base);
  gh('pr', 'merge', number, '--repo', repository, '--squash', '--match-head-commit', head);
  if (!api(`pulls/${number}`).merged)
    throw new Error('Release PR has not merged; refusing to create a release');
  return { merged: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repository = process.env.GITHUB_REPOSITORY;
  const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' }).trim();
  let result;
  if (process.argv[2] === 'prepare') {
    result = await prepareReleasePullRequest(repository, process.env.RELEASE_PR, gh);
  } else if (process.argv[2] === 'merge') {
    result = await mergeReleasePullRequest(
      {
        repository,
        number: process.env.PR_NUMBER,
        head: process.env.HEAD_SHA,
        base: process.env.BASE_SHA,
      },
      gh,
    );
  } else {
    throw new Error('Usage: stable-release-pr.mjs <prepare|merge>');
  }
  for (const [key, value] of Object.entries(result))
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}
