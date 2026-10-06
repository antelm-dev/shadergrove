// The `evaluate` callback below runs in the page.
/// <reference lib="dom" />

import { expect, test } from './fixtures';

// Regression: Monaco colours the whole document only in idle callbacks, and a
// shader rendering on every frame can leave none. The editor opened on plain,
// uncoloured text until the first scroll — the lines on screen were never
// tokenized after the panel took its size.

test.describe.configure({ timeout: 180_000 });

test('the editor colours GLSL on screen without waiting for a scroll', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('mat-toolbar.toolbar')).toBeVisible();
  if ((await page.getByRole('button', { name: 'Hide editor' }).count()) === 0) {
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: /Show editor$/ }).click();
  }
  const editor = page.locator('.monaco-editor').first();
  await expect(editor).toBeVisible();

  // Every shader declares its uniforms near the top; `uniform` is a keyword.
  const keyword = editor.locator('.view-line span span', { hasText: /^uniform$/ }).first();
  await expect(keyword).toBeVisible();
  await expect
    .poll(() =>
      keyword.evaluate((span) => {
        // Applying the profile's theme can replace this line between polls.
        const editor = span.closest('.monaco-editor');
        if (!editor) return false;
        const plain = getComputedStyle(editor).color;
        return getComputedStyle(span).color !== plain && getComputedStyle(span).color !== '';
      }),
    )
    .toBe(true);
});
