import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';

// glslang analysis runs in a Worker beside the renderer. Its status chip and
// its squiggles are separate from the driver's compile diagnostics.

test.describe.configure({ timeout: 180_000 });

const WASM = '**/glsl-analysis/glsl-analysis.wasm';
const chip = (page: Page) => page.locator('.analysis-chip');

async function openEditor(page: Page) {
  await page.addInitScript(() => {
    // Paused: the preview must not starve the page on software-rendered runners.
    localStorage.setItem(
      'shader-studio.preferences',
      JSON.stringify({ paused: true, editorOpen: true }),
    );
  });
  await page.goto('/');
  await expect(page.locator('.monaco-editor').first()).toBeVisible();
}

async function typeAtEnd(page: Page, text: string) {
  await page.locator('.monaco-editor').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text);
}

test('a valid buffer analyses clean, an incomplete one reports, undo recovers', async ({
  page,
}) => {
  await openEditor(page);
  await expect(chip(page)).toHaveAttribute('data-analysis', 'ready');
  await expect(page.locator('.monaco-editor .squiggly-error')).toHaveCount(0);

  await typeAtEnd(page, '\nvoid broken( {');
  await expect(chip(page)).toHaveAttribute('data-analysis', 'problems');
  await expect(page.locator('.monaco-editor .squiggly-error').first()).toBeVisible();

  for (let i = 0; i < 3; i++) await page.keyboard.press('Control+z');
  await expect(chip(page)).toHaveAttribute('data-analysis', 'ready');
  await expect(page.locator('.monaco-editor .squiggly-error')).toHaveCount(0);
  // Rendering is authoritative and unaffected by analysis state.
  await expect(page.locator('canvas').first()).toBeVisible();
});

test('a project switch discards the previous project’s analysis', async ({ page }) => {
  const response = await page.request.get('/api/shaders');
  const { shaders } = (await response.json()) as { shaders: { id: string; name: string }[] };
  await openEditor(page);
  await expect(chip(page)).toHaveAttribute('data-analysis', 'ready');
  await typeAtEnd(page, '\nvoid broken( {');
  await expect(chip(page)).toHaveAttribute('data-analysis', 'problems');

  const other = shaders.find((s) => s.name === 'Hex Pulse') ?? shaders[1];
  await page.locator('app-shader-browser .shader-row', { hasText: other.name }).click();
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page).toHaveURL(`/shaders/${encodeURIComponent(other.id)}`);
  await expect(chip(page)).toHaveAttribute('data-analysis', /ready|problems/);
  await expect(page.locator('.monaco-editor .squiggly-error')).toHaveCount(0);
});

test.describe('worker failures are recoverable and distinct from shader errors', () => {
  test('missing WASM reports unavailable, retry recovers', async ({ page }) => {
    await page.route(WASM, (route) => route.fulfill({ status: 404 }));
    await openEditor(page);
    await expect(chip(page)).toHaveAttribute('data-analysis', 'unavailable');
    await expect(page.locator('.monaco-editor .squiggly-error')).toHaveCount(0);

    await page.unroute(WASM);
    await chip(page).click();
    await expect(chip(page)).toHaveAttribute('data-analysis', 'ready');
  });

  test('corrupt WASM fails the integrity check, retry recovers', async ({ page }) => {
    await page.route(WASM, (route) =>
      route.fulfill({ status: 200, contentType: 'application/wasm', body: 'not wasm' }),
    );
    await openEditor(page);
    await expect(chip(page)).toHaveAttribute('data-analysis', 'unavailable');

    await page.unroute(WASM);
    await chip(page).click();
    await expect(chip(page)).toHaveAttribute('data-analysis', 'ready');
  });

  test('a hung start-up trips the watchdog, retry recovers', async ({ page }) => {
    await page.route(WASM, () => new Promise<void>(() => {}));
    await openEditor(page);
    await expect(chip(page)).toHaveAttribute('data-analysis', 'unavailable', { timeout: 60_000 });

    await page.unroute(WASM);
    await chip(page).click();
    await expect(chip(page)).toHaveAttribute('data-analysis', 'ready');
  });
});

test('nothing is fetched while the editor stays closed', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('glsl-analysis')) requests.push(request.url());
  });
  await page.addInitScript(() => {
    localStorage.setItem(
      'shader-studio.preferences',
      JSON.stringify({ paused: true, editorOpen: false }),
    );
  });
  await page.goto('/');
  await expect(page.locator('mat-toolbar.toolbar')).toBeVisible();
  await page.waitForTimeout(2_000);
  expect(requests).toEqual([]);
});
