import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = (path) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const workspace = read('package.json');
const runtime = read('ops/runtime-deps/package.json');
const lock = read('ops/runtime-deps/package-lock.json');

assert.deepEqual(
  runtime.dependencies,
  workspace.dependencies,
  'SSR runtime versions must match the root manifest; update both in the same PR.',
);
assert.deepEqual(
  lock.packages[''].dependencies,
  runtime.dependencies,
  'Regenerate the runtime lockfile with npm install --package-lock-only.',
);
console.log('SSR runtime manifest and lockfile match the workspace.');
