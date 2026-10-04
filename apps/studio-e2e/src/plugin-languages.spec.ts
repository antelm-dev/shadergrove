// The `evaluate` callbacks below run in the page.
/// <reference lib="dom" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';

// Languages end to end: the English and French packs every profile starts
// with, a third-party Spanish pack (a partial test fixture), the bundled
// English that needs none — chosen from the Language menu and from Plugins,
// kept across reloads, and lost to a switch or a removal without losing the
// choice. Asserts the text, dates and numbers the page actually shows.

test.describe.configure({ timeout: 300_000 });

const SPANISH_TEXT = readFileSync(
  resolve(
    import.meta.dirname,
    '../../../tools/workspace/fixtures/plugins/languages/spanish-test.sgplugin.json',
  ),
  'utf8',
);
const SPANISH = 'dev.shadergrove.test-spanish';
const ENGLISH_PACK = 'dev.shadergrove.language-en';
const FRENCH_PACK = 'dev.shadergrove.language-fr';
const option = (ref: string) => `language-option-${ref}`;
const REFS = {
  english: `plugin:${ENGLISH_PACK}/english`,
  french: `plugin:${FRENCH_PACK}/french`,
  spanish: `plugin:${SPANISH}/spanish`,
  fallback: 'fallback-en',
};

async function openStudio(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('mat-toolbar.toolbar')).toBeVisible();
  await page.getByRole('button', { name: /^(Pause|Pausa)$/ }).click();
}

/** Opens More → Language, by position: its label is in whatever language is worn. */
async function openLanguageMenu(page: Page): Promise<void> {
  // "More actions" is a key the Spanish fixture leaves in English.
  await page.getByRole('button', { name: /^(More actions|Plus d’actions)$/ }).click();
  await page
    .locator('.mat-mdc-menu-panel button', {
      has: page.locator('mat-icon', { hasText: /^language$/ }),
    })
    .first()
    .click();
}

async function closeMenus(page: Page): Promise<void> {
  const panels = page.locator('.mat-mdc-menu-panel');
  await expect(async () => {
    if ((await panels.count()) > 0) await page.keyboard.press('Escape');
    await expect(panels).toHaveCount(0, { timeout: 500 });
  }).toPass();
}

async function choose(page: Page, ref: string): Promise<void> {
  await openLanguageMenu(page);
  await page.getByTestId(option(ref)).click();
  await closeMenus(page);
}

test('languages are packs: defaults, a partial third-party pack, fallback and formatting', async ({
  page,
}) => {
  await openStudio(page);

  // A fresh profile speaks English through the English pack, beside French and the bundled English.
  await openLanguageMenu(page);
  await expect(page.getByTestId(option(REFS.english))).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId(option(REFS.french))).toHaveText(/Français/);
  await expect(page.getByTestId(option(REFS.fallback))).toHaveText(/English \(built-in\)/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await closeMenus(page);

  // French, everywhere at once, and after a reload.
  await choose(page, REFS.french);
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page.getByPlaceholder('Filtrer')).toBeVisible();
  await page.reload();
  await expect(page.getByPlaceholder('Filtrer')).toBeVisible();

  // A third-party pack installs switched off, and switching it on selects nothing.
  await page.getByTestId('open-plugins').click();
  await page.getByTestId('plugin-file').setInputFiles({
    name: 'spanish-test.sgplugin.json',
    mimeType: 'application/json',
    buffer: Buffer.from(SPANISH_TEXT),
  });
  await page.getByTestId('plugin-install').click();
  const toggle = page.getByTestId(`plugin-enable-${SPANISH}`).getByRole('switch');
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page.getByTestId(`plugin-${SPANISH}`)).toContainText('Español (es)');

  // Chosen from Plugins: what it translates reads in Spanish, the rest in English.
  await page.getByTestId(`use-language-${SPANISH}/spanish`).click();
  await expect(page.getByTestId(`language-in-use-${SPANISH}/spanish`)).toHaveText(
    'En uso como idioma de la app',
  );
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await page.getByRole('link', { name: /back to the editor/i }).click();
  await expect(page.getByPlaceholder('Filtrar')).toBeVisible();
  // Interpolated and translated beside a key the pack leaves to English.
  await expect(page.getByText('17 controles · 3 presets').first()).toBeVisible();

  // Numbers follow the language worn: the bloom strength of the open shader.
  await page.getByLabel('Post-processing').first().click();
  const strength = page.locator('app-post-processing-panel .value').first();
  await expect(strength).toHaveText('0,45');
  await choose(page, REFS.fallback);
  await expect(strength).toHaveText('0.45');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await choose(page, REFS.spanish);
  await expect(strength).toHaveText('0,45');

  // Dates too: the account's sessions, in Spanish then in English.
  const month = (locale: string) =>
    page.evaluate(
      (tag) => new Intl.DateTimeFormat(tag, { month: 'short' }).format(new Date()),
      locale,
    );
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page
    .locator('.mat-mdc-menu-panel button', {
      has: page.locator('mat-icon', { hasText: 'devices' }),
    })
    .first()
    .click();
  const dates = page.locator('.sessions .dates').first();
  await expect(dates).toContainText(await month('es'));
  await page.keyboard.press('Escape');

  // Switched off, the chosen pack gives way to English at once; the choice waits for it.
  await page.getByTestId('open-plugins').click();
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');

  // Removing the official French pack leaves French out of the menu and keeps it removed.
  await page.getByTestId(`plugin-remove-${FRENCH_PACK}`).click();
  await expect(page.getByTestId(`plugin-${FRENCH_PACK}`)).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId(`install-available-${FRENCH_PACK}`)).toBeVisible();
  await page.getByRole('link', { name: /back to the editor/i }).click();
  await openLanguageMenu(page);
  await expect(page.getByTestId(option(REFS.french))).toHaveCount(0);
  await expect(page.getByTestId(option(REFS.spanish))).toHaveAttribute('aria-checked', 'true');
});
