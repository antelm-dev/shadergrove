import { pathToFileURL } from 'node:url';
import {
  compareStable,
  highestPublishedStable,
  listReleases,
  readGitHub,
  readReleasePage,
} from './releases.mjs';

export const KEEP_BETAS = 5;
const betaTag = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-beta\.(0|[1-9]\d*)$/;

// Published betas to delete: every beta of a cycle that a published stable closed, and
// all but the newest `keep` of each open cycle. The newest stays so numbering never
// restarts below an installed beta; drafts are publications in flight and are kept.
export function betasToPrune(releases, keep = KEEP_BETAS) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('Expected to keep at least one beta');
  const stable = highestPublishedStable(releases);
  const open = new Map();
  const prune = [];
  for (const release of releases) {
    const match = release.tag_name.match(betaTag);
    if (!match || release.draft || !release.prerelease) continue;
    const [, base, number] = match;
    if (stable && compareStable(base, stable) <= 0) prune.push(release.tag_name);
    else open.set(base, [...(open.get(base) ?? []), { tag: release.tag_name, n: BigInt(number) }]);
  }
  for (const betas of open.values()) {
    betas.sort((a, b) => (a.n < b.n ? 1 : -1));
    prune.push(...betas.slice(keep).map((beta) => beta.tag));
  }
  return prune;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tags = betasToPrune(await listReleases(readReleasePage(readGitHub)));
  if (tags.length) console.log(tags.join('\n'));
}
