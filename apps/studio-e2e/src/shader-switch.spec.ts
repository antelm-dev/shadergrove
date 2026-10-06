import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';

// Regression: picking a shader in the library retriggered the routing
// coordinator's selection effect on its own navigation, which redirected
// forever and froze the page (`RoutingCoordinator.onStandalonePage`).

// CI runners have no GPU: every switch compiles and renders a shader in
// software, around 20 s each, so five navigations need more than the default.
test.describe.configure({ timeout: 180_000 });

test('switching shaders keeps the URL, the selection and the page in step', async ({ page }) => {
  const response = await page.request.get('/api/shaders');
  expect(response.ok()).toBe(true);
  const { shaders } = (await response.json()) as { shaders: { id: string; name: string }[] };
  const idOf = (name: string) => {
    const shader = shaders.find((candidate) => candidate.name === name);
    if (!shader) throw new Error(`"${name}" is not in the test library`);
    return shader.id;
  };
  const expectOpen = (name: string) => expectShaderOpen(page, name, idOf(name), shaders.length);

  await page.goto(`/shaders/${encodeURIComponent(idOf('Aurora Veil'))}`);
  // Paused, the preview stops competing with the page for the CPU. Playback
  // has nothing to do with routing, and the pause holds across in-app navigation.
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
  await expectOpen('Aurora Veil');

  for (const name of ['Hex Pulse', 'Warp Tunnel']) {
    await page.locator('app-shader-browser .shader-row', { hasText: name }).click();
    await expectOpen(name);
  }

  await page.goBack();
  await expectOpen('Hex Pulse');
  await page.goBack();
  await expectOpen('Aurora Veil');
  await page.goForward();
  await expectOpen('Hex Pulse');
});

/** The URL, the library's current row and the document title all name the shader, and the page still answers. */
async function expectShaderOpen(page: Page, name: string, id: string, total: number) {
  await expect(page).toHaveURL(`/shaders/${encodeURIComponent(id)}`);
  const current = page.locator('app-shader-browser .shader-row[aria-current="true"]');
  await expect(current).toHaveCount(1);
  await expect(current).toContainText(name);
  await expect(page.locator('.doc-name')).toHaveText(name);

  // A frozen page cannot filter the library.
  const rows = page.locator('app-shader-browser .shader-row');
  const filter = page.locator('app-shader-browser .search-input');
  await filter.fill(name);
  await expect(rows).toHaveCount(1);
  await filter.fill('');
  await expect(rows).toHaveCount(total);
}
