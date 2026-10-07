import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareStable,
  highestPublishedStable,
  listReleases,
  readReleasePage,
  shouldBeLatest,
} from './releases.mjs';

const stable = (version, draft = false) => ({ tag_name: `v${version}`, draft, prerelease: false });
const betas = (count) =>
  Array.from({ length: count }, (_, i) => ({
    tag_name: `v2.2.0-beta.${i + 1}`,
    draft: false,
    prerelease: true,
  }));

test('versions compare numerically, not lexically', () => {
  assert.equal(compareStable('2.10.0', '2.9.0'), 1);
  assert.equal(compareStable('2.0.0', '10.0.0'), -1);
  assert.equal(compareStable('2.1.0', '2.1.0'), 0);
  assert.equal(compareStable('9007199254740993.0.0', '9007199254740992.0.0'), 1);
  assert.throws(() => compareStable('2.1', '2.1.0'), /stable version/);
});

test('listing follows every page so stable releases behind many betas are seen', async () => {
  const pages = [betas(100), betas(100), [stable('2.1.0')]];
  const paths = [];
  const releases = await listReleases(
    readReleasePage(async (path) => {
      paths.push(path);
      return pages[paths.length - 1];
    }),
  );
  assert.equal(releases.length, 201);
  assert.deepEqual(paths.at(-1), 'releases?per_page=100&page=3');
  assert.equal(highestPublishedStable(releases), '2.1.0');
});

test('missing, malformed and unbounded listings fail closed', async () => {
  for (const page of [null, {}, [{ tag_name: 'v1.0.0', draft: 'false', prerelease: false }]]) {
    await assert.rejects(
      listReleases(async () => page),
      /Unexpected GitHub releases/,
    );
  }
  await assert.rejects(
    listReleases(async () => betas(100)),
    /partial list/,
  );
});

test('only published stable releases count, and their tags must be canonical', () => {
  assert.equal(highestPublishedStable([]), null);
  assert.equal(
    highestPublishedStable([stable('2.0.0'), stable('3.0.0', true), ...betas(2)]),
    '2.0.0',
  );
  for (const tag_name of ['2.0.0', 'v2.0', 'v2.0.0-rc.1', 'v02.0.0'])
    assert.throws(
      () => highestPublishedStable([{ tag_name, draft: false, prerelease: false }]),
      /vX\.Y\.Z/,
    );
});

test('Latest follows semver, not publication date', () => {
  const published = [stable('2.0.0', true), stable('2.1.0'), ...betas(3)];
  // Recovering the 2.0.0 draft after 2.1.0 must not take Latest from 2.1.0.
  assert.equal(shouldBeLatest('v2.0.0', published), false);
  assert.equal(shouldBeLatest('v2.2.0', [...published, stable('2.2.0', true)]), true);
  assert.equal(shouldBeLatest('v1.0.0', []), true);
  assert.equal(shouldBeLatest('v2.0.1', [stable('2.0.1', true), stable('2.0.0')]), true);
  for (const tag of ['2.2.0', 'v2.2.0-beta.1'])
    assert.throws(() => shouldBeLatest(tag, []), /vX\.Y\.Z tag/);
});
