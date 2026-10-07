import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test } from './fixtures';

// The language journey spans a reload and a catalogue update: same budget as the other plugin workflows.
test.describe.configure({ timeout: 300_000 });

const FRENCH = 'dev.shadergrove.language-fr';
// Exact shipped bytes from task02's immutable launch base, before inspection keys.
const OLD_FRENCH = readFileSync(
  resolve(import.meta.dirname, 'review-fixtures/language-fr-pre-inspection-1.0.1.sgplugin.json'),
);

test('an existing French 1.0.1 profile can update to the inspector translations', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('mat-toolbar.toolbar')).toBeVisible();
  await page.getByTestId('open-plugins').click();
  await page.getByTestId('plugin-file').setInputFiles({
    name: 'language-fr-pre-inspection-1.0.1.sgplugin.json',
    mimeType: 'application/json',
    buffer: OLD_FRENCH,
  });
  await page.getByTestId('plugin-install').click();
  const toggle = page.getByTestId(`plugin-enable-${FRENCH}`).getByRole('switch');
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await page.getByTestId(`use-language-${FRENCH}/french`).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await page.reload();
  await expect(toggle).toBeChecked();
  await page.getByRole('link', { name: /retour.*[ée]diteur/i }).click();
  await page.keyboard.press('Control+j');
  await page.locator('#bottom-panel-tab-inspection').click();
  // This establishes that the stored old pack survived seeding and the new
  // feature currently uses the built-in English fallback in a French profile.
  await expect(page.locator('app-render-inspection-panel .capture')).toHaveText('Capture frame');
  await page.getByTestId('open-plugins').click();
  await expect(toggle).toBeChecked();
  await expect(page.getByTestId(`available-${FRENCH}`)).toBeVisible();
  // Seeding must preserve the old installed package, but the catalogue must offer
  // a newer immutable version containing the feature's French strings.
  const update = page.getByTestId(`install-available-${FRENCH}`);
  await expect(update).toBeVisible();
  await update.click();
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await page.getByRole('link', { name: /retour.*[ée]diteur/i }).click();
  await page.locator('#bottom-panel-tab-inspection').click();
  await expect(page.locator('app-render-inspection-panel .capture')).toHaveText(
    'Capturer une frame',
  );
});
