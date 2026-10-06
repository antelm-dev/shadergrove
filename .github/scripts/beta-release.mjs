import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const betaVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/;

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

export async function resolveBetaRelease(input, read = readGitHub) {
  if (!['push', 'workflow_dispatch'].includes(input.event) || input.ref !== 'refs/heads/develop') {
    throw new Error('Beta releases must run from develop');
  }
  if (!/^[a-f0-9]{40}$/.test(input.sha)) throw new Error('Expected an immutable commit SHA');
  let version = input.version;
  if (!version) {
    if (!stableVersion.test(input.base) || !/^[1-9]\d*$/.test(input.runNumber)) {
      throw new Error('Expected a stable beta base and a positive workflow run number');
    }
    version = `${input.base}-beta.${input.runNumber}`;
  }
  if (!betaVersion.test(version)) throw new Error('Expected a version such as 2.0.0-beta.1');
  const tag = `v${version}`;
  const release = await read(`releases/tags/${tag}`);
  const ref = await read(`git/ref/tags/${tag}`);
  const commit = ref ? await read(`commits/${tag}`) : null;
  if (ref && commit?.sha !== input.sha) throw new Error('Beta tag points at another commit');
  if (release) {
    if (!release.prerelease) throw new Error('Existing beta release must be a prerelease');
    if (!ref && (!release.draft || release.target_commitish !== input.sha)) {
      throw new Error('Beta release targets another commit');
    }
  } else {
    const base = version.split('-beta.')[0];
    const stable = await read(`releases/tags/v${base}`);
    if (stable && !stable.draft && !stable.prerelease) {
      throw new Error(
        `Beta base ${base} is already released; update .github/beta-release.json or choose a newer manual version`,
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
    runNumber: process.env.GITHUB_RUN_NUMBER,
    base,
  });
  for (const [key, value] of Object.entries(target)) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
  console.log(`${target.publish ? 'Prepare' : 'Already published'} ${target.tag} at ${target.sha}`);
}
