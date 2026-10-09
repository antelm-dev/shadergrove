import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  compareStable,
  findRelease,
  highestPublishedStable,
  listReleases,
  readGitHub,
  readReleasePage,
  stableVersion,
} from './releases.mjs';

export { readGitHub };

const betaVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/;

// The commit's own beta of this base when it has one, so reruns resume it; otherwise
// one past the highest beta of this base, starting at 0 for each new base.
export function nextBetaVersion(releases, base, sha) {
  const prefix = `v${base}-beta.`;
  let next = 0;
  for (const release of releases) {
    const version = release.tag_name.slice(1);
    if (!release.tag_name.startsWith(prefix) || !betaVersion.test(version)) continue;
    if (release.target_commitish === sha) return version;
    next = Math.max(next, Number(release.tag_name.slice(prefix.length)) + 1);
  }
  return `${base}-beta.${next}`;
}

export async function resolveBetaRelease(input, read = readGitHub) {
  if (!['push', 'workflow_dispatch'].includes(input.event) || input.ref !== 'refs/heads/develop') {
    throw new Error('Beta releases must run from develop');
  }
  if (!/^[a-f0-9]{40}$/.test(input.sha)) throw new Error('Expected an immutable commit SHA');
  if (input.version && !betaVersion.test(input.version)) {
    throw new Error('Expected a version such as 2.0.0-beta.0');
  }
  if (!input.version && !stableVersion.test(input.base))
    throw new Error('Expected a stable beta base');
  // The tags endpoint hides drafts, so look betas up in the full listing.
  const releases = await listReleases(readReleasePage(read));
  const version = input.version || nextBetaVersion(releases, input.base, input.sha);
  const tag = `v${version}`;
  const release = findRelease(releases, tag);
  const ref = await read(`git/ref/tags/${tag}`);
  const commit = ref ? await read(`commits/${tag}`) : null;
  if (ref && commit?.sha !== input.sha) throw new Error('Beta tag points at another commit');
  if (release) {
    // An existing beta is recovered or skipped as-is, even after its stable cycle ended.
    if (!release.prerelease) throw new Error('Existing beta release must be a prerelease');
    if (!ref && (!release.draft || release.target_commitish !== input.sha)) {
      throw new Error('Beta release targets another commit');
    }
  } else {
    const base = version.split('-beta.')[0];
    const stable = highestPublishedStable(releases);
    if (stable && compareStable(base, stable) <= 0) {
      throw new Error(
        `Beta base ${base} is not newer than published stable ${stable}; update .github/beta-release.json or choose a newer manual version`,
      );
    }
  }
  return { version, tag, sha: input.sha, publish: !release || release.draft };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { version: base } = JSON.parse(readFileSync('.github/beta-release.json', 'utf8'));
  const target = await resolveBetaRelease({
    event: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    sha: process.env.GITHUB_SHA,
    version: process.env.INPUT_VERSION,
    base,
  });
  for (const [key, value] of Object.entries(target)) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
  console.log(`${target.publish ? 'Prepare' : 'Already published'} ${target.tag} at ${target.sha}`);
}
