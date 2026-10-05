import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Keep application inputs here, including assets and tools outside the Nx graph.
// Unknown paths conservatively validate both applications.
export function classifyChanges(paths, full = false) {
  let studio = full;
  let website = full;
  for (const path of paths) {
    if (
      path.startsWith('apps/website/') ||
      path.startsWith('libs/brand/') ||
      path.startsWith('ops/website/') ||
      path === 'tools/workspace/src/website-smoke.ts' ||
      path === 'Dockerfile.website'
    ) {
      website = true;
    } else if (
      path.startsWith('libs/shared/') ||
      path === '.github/workflows/ci.yml' ||
      path.startsWith('.github/scripts/ci-scope') ||
      path === '.github/scripts/queue-deploy.sh' ||
      path === '.github/scripts/deploy-on-vps.test.sh' ||
      path === 'ops/staging/deploy-on-vps.sh'
    ) {
      studio = website = true;
    } else if (
      path.startsWith('apps/studio/') ||
      path.startsWith('apps/studio-e2e/') ||
      path.startsWith('libs/') ||
      path.startsWith('tools/') ||
      path.startsWith('plugins/') ||
      path.startsWith('examples/') ||
      path.startsWith('i18n/') ||
      path.startsWith('ops/staging/') ||
      path.startsWith('.github/') ||
      path === 'Dockerfile' ||
      path === 'docker-compose.yml'
    ) {
      studio = true;
    } else if (
      path.startsWith('docs/') ||
      path.startsWith('.bruno/') ||
      /^[^/]+\.md$/.test(path) ||
      path === 'LICENSE' ||
      path === 'NOTICE'
    ) {
      // Documentation does not change either application artifact.
    } else {
      studio = website = true;
    }
  }
  return { studio, website };
}

export function changedPaths(base, head, cwd) {
  if (!base || !head) throw new Error('NX_BASE and NX_HEAD are required');
  // Treat renames as deletion + addition so moving a file between apps checks both.
  return execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', base, head], {
    cwd,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const full = process.env.FULL_CI === 'true';
  const paths = full ? [] : changedPaths(process.env.NX_BASE, process.env.NX_HEAD);
  const scope = classifyChanges(paths, full);
  console.log(JSON.stringify({ paths, ...scope }, null, 2));
  for (const [name, value] of Object.entries(scope)) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}
