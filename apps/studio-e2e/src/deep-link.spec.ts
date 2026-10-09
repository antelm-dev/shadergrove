import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';

// Regression: a cold load of `/shaders/<id>` read the URL before the router's
// initial navigation had run, so it opened the library's first shader and
// rewrote the address to it. Every test starts in a fresh browser context, so
// nothing remembered from an earlier visit can stand in for the link.

// CI runners have no GPU: every shader compiles and renders in software.
test.describe.configure({ timeout: 180_000 });

type Listed = { id: string; name: string };

async function library(page: Page): Promise<Listed[]> {
  const response = await page.request.get('/api/shaders');
  expect(response.ok()).toBe(true);
  const { shaders } = (await response.json()) as { shaders: Listed[] };
  expect(shaders.length).toBeGreaterThan(1);
  return shaders;
}

/** Paused before the app starts, so the preview does not compete with the page for the CPU. */
async function openCold(page: Page, path: string): Promise<void> {
  await page.addInitScript(() =>
    localStorage.setItem('shader-studio.preferences', JSON.stringify({ paused: true })),
  );
  await page.goto(path);
}

async function expectOpen(page: Page, shader: Listed): Promise<void> {
  await expect(page.locator('.doc-name')).toHaveText(shader.name);
  const current = page.locator('app-shader-browser .shader-row[aria-current="true"]');
  await expect(current).toHaveCount(1);
  await expect(current).toContainText(shader.name);
  await expect(page).toHaveURL(`/shaders/${encodeURIComponent(shader.id)}`);
}

test('a cold deep link opens a shader that is not the first one and keeps its URL', async ({
  page,
}) => {
  const shaders = await library(page);
  const target = shaders[1];

  await openCold(page, `/shaders/${encodeURIComponent(target.id)}`);
  await expectOpen(page, target);
});

test('a cold deep link opens a private shader the account just created', async ({ page }) => {
  const response = await page.request.post('/api/shaders', {
    // Sorted by name, last: never the shader the library would open anyway.
    data: { name: 'Zz Deep Link Private' },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const { shader } = (await response.json()) as { shader: Listed };
  const shaders = await library(page);
  expect(shaders[0].id).not.toBe(shader.id);

  await openCold(page, `/shaders/${encodeURIComponent(shader.id)}`);
  await expectOpen(page, shader);
});

test('a cold link to an unknown shader falls back to the first one', async ({ page }) => {
  const shaders = await library(page);

  await openCold(page, '/shaders/no-such-shader');
  await expectOpen(page, shaders[0]);
});

test('after a cold deep link, in-app navigation and history still follow the selection', async ({
  page,
}) => {
  const shaders = await library(page);
  const [first, deepLinked] = shaders;

  await openCold(page, `/shaders/${encodeURIComponent(deepLinked.id)}`);
  await expectOpen(page, deepLinked);

  await page.locator('app-shader-browser .shader-row', { hasText: first.name }).click();
  await expectOpen(page, first);

  await page.goBack();
  await expectOpen(page, deepLinked);
  await page.goForward();
  await expectOpen(page, first);
});
