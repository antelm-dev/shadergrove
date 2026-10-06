import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = new URL('../../', import.meta.url);

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'shadergrove-dependencies-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const path of [
    'package.json',
    'ops/runtime-deps/package.json',
    'ops/runtime-deps/package-lock.json',
    '.github/scripts/check-runtime-deps.mjs',
    '.github/scripts/prepare-sbom.mjs',
  ]) {
    cpSync(new URL(path, root), join(dir, path), { recursive: true });
  }
  return dir;
}

const run = (dir, script, ...args) =>
  spawnSync(process.execPath, [join(dir, '.github/scripts', script), ...args], {
    encoding: 'utf8',
  });

function update(dir, path, change) {
  const file = join(dir, path);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  change(data);
  writeFileSync(file, JSON.stringify(data));
}

test('SSR inventory rejects a runtime version drifting from the workspace', (t) => {
  const dir = fixture(t);
  assert.equal(run(dir, 'check-runtime-deps.mjs').status, 0);
  update(dir, 'ops/runtime-deps/package.json', (data) => {
    data.dependencies.pg = '0.0.0';
  });
  const result = run(dir, 'check-runtime-deps.mjs');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SSR runtime versions must match/);
});

test('SSR inventory rejects a stale npm lockfile', (t) => {
  const dir = fixture(t);
  update(dir, 'ops/runtime-deps/package-lock.json', (data) => {
    data.packages[''].dependencies.pg = '0.0.0';
  });
  const result = run(dir, 'check-runtime-deps.mjs');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Regenerate the runtime lockfile/);
});

test('release inventory rejects a production-only SBOM that omits Electron', (t) => {
  const dir = fixture(t);
  const path = join(dir, 'production-only.cdx.json');
  writeFileSync(
    path,
    JSON.stringify({
      bomFormat: 'CycloneDX',
      components: [{ type: 'library', name: 'pg', version: '8.22.0' }],
    }),
  );
  const result = run(dir, 'prepare-sbom.mjs', path);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Workspace SBOM must include Electron/);
});
