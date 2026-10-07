import { pathToFileURL } from 'node:url';

export const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

export async function readGitHub(path, fetcher = fetch) {
  const response = await fetcher(
    `${process.env.GITHUB_API_URL || 'https://api.github.com'}/repos/${process.env.GITHUB_REPOSITORY}/${path}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub ${path} returned HTTP ${response.status}`);
  return response.json();
}

export function compareStable(a, b) {
  const [x, y] = [a, b].map((version) => {
    if (!stableVersion.test(version)) throw new Error(`Expected a stable version, got ${version}`);
    return version.split('.').map(BigInt);
  });
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

// Every release, drafts included when the token has push access. Any unreadable
// or truncated listing throws: release decisions are never made on a partial list.
export async function listReleases(readPage) {
  const releases = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await readPage(page, PAGE_SIZE);
    if (
      !Array.isArray(batch) ||
      batch.some(
        (release) =>
          typeof release?.tag_name !== 'string' ||
          typeof release.draft !== 'boolean' ||
          typeof release.prerelease !== 'boolean',
      )
    ) {
      throw new Error(`Unexpected GitHub releases listing on page ${page}`);
    }
    releases.push(...batch);
    if (batch.length < PAGE_SIZE) return releases;
  }
  throw new Error(`More than ${MAX_PAGES * PAGE_SIZE} releases; refusing to use a partial list`);
}

export const readReleasePage = (read) => (page, size) =>
  read(`releases?per_page=${size}&page=${page}`);

export function findRelease(releases, tag) {
  const matches = releases.filter((release) => release.tag_name === tag);
  if (matches.length > 1) throw new Error(`Several releases use ${tag}`);
  return matches[0] ?? null;
}

export function highestPublishedStable(releases) {
  let highest = null;
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    const version = release.tag_name.slice(1);
    if (!release.tag_name.startsWith('v') || !stableVersion.test(version)) {
      throw new Error(`Published stable release ${release.tag_name} is not tagged vX.Y.Z`);
    }
    if (!highest || compareStable(version, highest) > 0) highest = version;
  }
  return highest;
}

function requireStableTag(tag) {
  if (!tag?.startsWith('v') || !stableVersion.test(tag.slice(1))) {
    throw new Error(`Expected a vX.Y.Z tag, got ${tag}`);
  }
}

// GitHub otherwise picks Latest by date, which promotes a recovered older draft.
export function shouldBeLatest(tag, releases) {
  requireStableTag(tag);
  const highest = highestPublishedStable(releases.filter((release) => release.tag_name !== tag));
  return !highest || compareStable(tag.slice(1), highest) > 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, tag] = process.argv.slice(2);
  if (command !== 'latest') throw new Error('Usage: releases.mjs latest <vX.Y.Z>');
  requireStableTag(tag);
  console.log(shouldBeLatest(tag, await listReleases(readReleasePage(readGitHub))));
}
