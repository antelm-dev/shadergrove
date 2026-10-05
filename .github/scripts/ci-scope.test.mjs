import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { changedPaths, classifyChanges } from './ci-scope.mjs';

test('website changes skip all studio workloads', () => {
  for (const path of [
    'apps/website/src/app/page.tsx',
    'libs/brand/src/shader.ts',
    'ops/website/nginx.conf',
    'Dockerfile.website',
    'tools/workspace/src/website-smoke.ts',
  ]) {
    assert.deepEqual(classifyChanges([path]), { studio: false, website: true }, path);
  }
});

test('studio dependencies, assets and tooling skip website workloads', () => {
  for (const path of [
    'apps/studio/src/server/index.ts',
    'apps/studio-e2e/test.spec.ts',
    'libs/backend/src/index.ts',
    'libs/future-library/src/index.ts',
    'tools/mcp/src/index.ts',
    'tools/workspace/src/smoke.ts',
    'plugins/official/default-theme.ts',
    'examples/demo.fs',
    'i18n/en.json',
    'ops/staging/docker-firewall.sh',
    'Dockerfile',
    'docker-compose.yml',
  ]) {
    assert.deepEqual(classifyChanges([path]), { studio: true, website: false }, path);
  }
});

test('shared configuration and CI changes validate both applications', () => {
  for (const path of [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'nx.json',
    'tsconfig.json',
    'libs/shared/src/model/releases.ts',
    'libs/shared/src/version.ts',
    '.dockerignore',
    '.oxlintrc.json',
    '.github/workflows/ci.yml',
    '.github/scripts/ci-scope.mjs',
    '.github/scripts/queue-deploy.sh',
    '.github/scripts/deploy-on-vps.test.sh',
    'ops/staging/deploy-on-vps.sh',
    'future-app/src/index.ts',
  ]) {
    assert.deepEqual(classifyChanges([path]), { studio: true, website: true }, path);
  }
});

test('docs-only changes skip app jobs; manual or initial runs validate everything', () => {
  const docs = ['docs/website-vps.md', 'README.md', '.bruno/collection.bru', 'LICENSE'];
  assert.deepEqual(classifyChanges(docs), { studio: false, website: false });
  assert.deepEqual(classifyChanges([]), { studio: false, website: false });
  assert.deepEqual(classifyChanges(docs, true), { studio: true, website: true });
});

test('the full base-to-head diff includes earlier changes, deletes and cross-app renames', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'shadergrove-ci-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    git('init', '--quiet');
    git('config', 'user.name', 'CI test');
    git('config', 'user.email', 'ci@example.invalid');
    git('config', 'core.autocrlf', 'false');
    mkdirSync(join(cwd, 'apps/studio'), { recursive: true });
    mkdirSync(join(cwd, 'apps/website'), { recursive: true });
    writeFileSync(join(cwd, 'apps/studio/moved.ts'), 'export const moved = true;\n');
    writeFileSync(join(cwd, 'apps/website/deleted.ts'), 'export const deleted = true;\n');
    git('add', '.');
    git('commit', '--quiet', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    renameSync(join(cwd, 'apps/studio/moved.ts'), join(cwd, 'apps/website/moved.ts'));
    rmSync(join(cwd, 'apps/website/deleted.ts'));
    git('add', '.');
    git('commit', '--quiet', '-m', 'earlier change');
    writeFileSync(join(cwd, 'README.md'), 'Later docs-only commit\n');
    git('add', '.');
    git('commit', '--quiet', '-m', 'latest change');
    const paths = changedPaths(base, 'HEAD', cwd);
    assert.ok(paths.includes('apps/studio/moved.ts'));
    assert.ok(paths.includes('apps/website/moved.ts'));
    assert.ok(paths.includes('apps/website/deleted.ts'));
    assert.deepEqual(classifyChanges(paths), { studio: true, website: true });
    assert.throws(() => changedPaths(undefined, 'HEAD', cwd), /NX_BASE/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
