import assert from 'node:assert/strict';
import test from 'node:test';
import { betasToPrune } from './prune-betas.mjs';

const stable = (version, draft = false) => ({ tag_name: `v${version}`, draft, prerelease: false });
const beta = (version, draft = false) => ({ tag_name: `v${version}`, draft, prerelease: true });
const cycle = (base, count) => Array.from({ length: count }, (_, i) => beta(`${base}-beta.${i}`));

test('betas of cycles closed by a published stable are all pruned', () => {
  const releases = [
    stable('2.8.0'),
    ...cycle('2.8.0', 2),
    ...cycle('2.7.0', 1),
    ...cycle('2.9.0', 2),
  ];
  assert.deepEqual(betasToPrune(releases).sort(), [
    'v2.7.0-beta.0',
    'v2.8.0-beta.0',
    'v2.8.0-beta.1',
  ]);
});

test('open cycles keep their newest five betas, compared numerically', () => {
  const releases = [...cycle('2.9.0', 12), ...cycle('3.0.0', 3)];
  assert.deepEqual(
    betasToPrune(releases).sort(),
    [0, 1, 2, 3, 4, 5, 6].map((n) => `v2.9.0-beta.${n}`).sort(),
  );
});

test('drafts, unpublished stables, stables and foreign tags are never pruned', () => {
  const releases = [
    stable('2.9.0', true),
    stable('2.8.0'),
    beta('2.8.0-beta.3', true),
    beta('2.9.0-beta.5', true),
    { tag_name: 'v2.8.0-beta.x', draft: false, prerelease: true },
    { tag_name: 'nightly', draft: false, prerelease: true },
    ...cycle('2.9.0', 5),
  ];
  assert.deepEqual(betasToPrune(releases), []);
});

test('at least one beta is always kept', () => {
  assert.throws(() => betasToPrune([], 0), /at least one/);
});
