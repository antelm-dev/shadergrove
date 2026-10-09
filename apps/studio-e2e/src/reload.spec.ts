import type { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures';

// Regression: the server renders anonymously, so its own request for the
// library is refused. That `401` used to raise the sign-in prompt on the
// server, and when the render outlived the session check the dialog shipped in
// the HTML: an inert backdrop over the hydrated page, for a signed-in user,
// until something else happened to open an overlay.

test.describe.configure({ timeout: 120_000 });

// What a user would click next on each page.
const pages: Record<string, (page: Page) => Locator> = {
  '/': (page) => page.getByTestId('open-plugins'),
  '/plugins': (page) => page.getByRole('link', { name: /back to the editor/i }),
};

for (const [path, next] of Object.entries(pages)) {
  test(`reloading ${path} never leaves a dialog over the page of a signed-in user`, async ({
    page,
  }) => {
    // Paused, so the preview does not compete with the page for the CPU.
    await page.addInitScript(() =>
      localStorage.setItem('shader-studio.preferences', JSON.stringify({ paused: true })),
    );
    await page.goto(path);
    for (let reload = 0; reload < 3; reload++) {
      const html = await (await page.request.get(path)).text();
      expect(html, 'a server-rendered overlay').not.toContain('class="cdk-overlay-container"');

      await page.reload();
      await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible();
      await expect(page.locator('.cdk-overlay-backdrop')).toHaveCount(0);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      // Only the actionability checks, the pointer hit test among them.
      await next(page).click({ trial: true });
    }
  });
}
