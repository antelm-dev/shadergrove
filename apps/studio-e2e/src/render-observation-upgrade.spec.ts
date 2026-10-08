import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test } from './fixtures';

// The language journey spans a reload and a catalogue update: same budget as the other plugin workflows.
test.describe.configure({ timeout: 300_000 });

const FRENCH = 'dev.shadergrove.language-fr';
// Exact shipped 1.0.2 bytes from this task's launch base, before the observation keys.
const OLD_FRENCH = readFileSync(
  resolve(import.meta.dirname, 'review-fixtures/language-fr-pre-observation-1.0.2.sgplugin.json'),
);

test('the old French 1.0.2 fixture is the exact shipped immutable package', () => {
  expect(OLD_FRENCH.length).toBe(58989);
  expect(createHash('sha256').update(OLD_FRENCH).digest('hex')).toBe(
    'd90dab292e6c936c7a48e3d26daaea714d156e34e3a101ea8c2e7e0c8aadf4b2',
  );
});

test('an existing French 1.0.2 profile can update to the observation translations', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('mat-toolbar.toolbar')).toBeVisible();
  // Plugins is laid over the live preview: software-rendered, it would starve the default-pack
  // seeding the install below waits for, as in the other plugin journeys. Kept across reloads.
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await page.getByTestId('open-plugins').click();
  await page.getByTestId('plugin-file').setInputFiles({
    name: 'language-fr-pre-observation-1.0.2.sgplugin.json',
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
  // The stored old pack survived seeding: the inspection strings are French, the
  // new observation strings fall back to the built-in English.
  await expect(page.locator('app-render-inspection-panel .capture')).toHaveText(
    'Capturer une frame',
  );
  await page.locator('app-render-inspection-panel .capture').click();
  await expect(page.locator('app-render-observation .find')).toHaveText('Find variables');
  await page.locator('app-render-inspection-panel .release').click();
  await page.getByTestId('open-plugins').click();
  await expect(toggle).toBeChecked();
  // Seeding must preserve the old installed package, but the catalogue must offer
  // a newer immutable version containing the observation French strings.
  const update = page.getByTestId(`install-available-${FRENCH}`);
  await expect(update).toBeVisible();
  await update.click();
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await page.getByRole('link', { name: /retour.*[ée]diteur/i }).click();
  await page.locator('#bottom-panel-tab-inspection').click();
  await page.locator('app-render-inspection-panel .capture').click();
  await expect(page.locator('app-render-observation .find')).toHaveText('Trouver les variables');
});
