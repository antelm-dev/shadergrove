// The `evaluate` callbacks below run in the page.
/// <reference lib="dom" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Locator, Page, TestInfo } from '@playwright/test';

import { expect, test } from './fixtures';

// Plugin themes end to end: the official Light/Dark pack every profile starts
// with, and a real `.sgplugin.json` picked in Plugins, switched on, worn from
// the Theme menu and the editor settings, kept across a reload, updated, and
// taken away again — asserting the colours the browser actually computes for
// the chrome and for Monaco, not just a stored preference.

// Each test is one long journey through Plugins, menus, dialogs and reloads.
test.describe.configure({ timeout: 300_000 });

/** An official package's text, as this release's catalogue lists it. */
const official = resolve(import.meta.dirname, '../../studio/src/plugins');
function officialText(id: string): string {
  const { packages } = JSON.parse(readFileSync(resolve(official, 'catalogue.json'), 'utf8')) as {
    packages: { id: string; file: string }[];
  };
  return readFileSync(resolve(official, packages.find((p) => p.id === id)!.file), 'utf8');
}

const AMBER = 'dev.shadergrove.grove-amber';
const AMBER_TEXT = officialText(AMBER);
// ISF stays a protocol 1 package: one from before themes.
const ISF_TEXT = officialText('dev.shadergrove.isf');
const DARK = `plugin:${AMBER}/amber-dark`;
const LIGHT = `plugin:${AMBER}/amber-light`;
const DEFAULTS = 'dev.shadergrove.default-themes';
const OFFICIAL_LIGHT = `plugin:${DEFAULTS}/light`;
const OFFICIAL_DARK = `plugin:${DEFAULTS}/dark`;
const SYSTEM = `${DEFAULTS}/default`;

/** `#rrggbb` as `getComputedStyle` reports it. */
function rgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

// The house Light/Dark (the official pack, and the fallback painted without it)
// and the two Grove Amber palettes.
const BUILTIN_DARK_TEXT = rgb('#e6e6e8');
const BUILTIN_LIGHT_TEXT = rgb('#1b1b1d');
const BUILTIN_PRIMARY = 'light-dark(#276c00, #71df3e)';
const AMBER_DARK = { text: rgb('#ede4d8'), toolbar: rgb('#1c1813'), menu: rgb('#2b251e') };
const AMBER_LIGHT = { text: rgb('#231b12'), toolbar: rgb('#f6efe5') };
const EDITOR = {
  amberDark: rgb('#1a1611'),
  amberLight: rgb('#fdf9f3'),
  midnight: rgb('#0b0a14'),
  studioDark: rgb('#10141c'),
  studioLight: rgb('#fbfcfe'),
};

const style = (locator: Locator, property: string) =>
  locator.evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property);
const textColour = (page: Page) => style(page.locator('body'), 'color');
const token = (page: Page, name: string) => style(page.locator('html'), name);
const toolbar = (page: Page) => style(page.locator('mat-toolbar.toolbar'), 'background-color');
const editorBackground = (page: Page) =>
  style(page.locator('.monaco-editor .monaco-editor-background').first(), 'background-color');

/**
 * Opens the studio with playback paused: a software-rendered shader would
 * otherwise take most of the CPU these long tests need. Kept across reloads.
 */
async function openStudio(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('mat-toolbar.toolbar')).toBeVisible();
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
}

async function openPlugins(page: Page): Promise<void> {
  await page.getByTestId('open-plugins').click();
  await expect(page).toHaveURL('/plugins');
}

async function backToEditor(page: Page): Promise<void> {
  await page.getByRole('link', { name: /back to the editor/i }).click();
  await expect(page.locator('mat-toolbar.toolbar')).toBeVisible();
}

/** Picks the file in Plugins, reviews it and installs it — which leaves it off. */
async function install(page: Page, name: string, text: string, id: string): Promise<void> {
  await page.getByTestId('plugin-file').setInputFiles({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(text),
  });
  await expect(page.getByTestId('plugin-review')).toBeVisible();
  await page.getByTestId('plugin-install').click();
  await expect(page.getByTestId(`plugin-${id}`)).toBeVisible();
  await expect(page.getByTestId(`plugin-enable-${id}`).getByRole('switch')).not.toBeChecked();
}

async function setEnabled(page: Page, id: string, enabled: boolean): Promise<void> {
  const toggle = page.getByTestId(`plugin-enable-${id}`).getByRole('switch');
  await toggle.click();
  await expect(toggle).toBeChecked({ checked: enabled });
}

async function openThemeMenu(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /Theme$/ }).click();
}

async function openEditor(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /Show editor$/ }).click();
  await expect(page.locator('.monaco-editor').first()).toBeVisible();
}

async function screenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, { body: await page.screenshot(), contentType: 'image/png' });
}

test('Grove Amber is installed, worn by the app and the editor, kept, and removed', async ({
  page,
}, testInfo) => {
  await openStudio(page);
  expect(await textColour(page)).toBe(BUILTIN_DARK_TEXT);

  // Installing and switching on selects nothing.
  await openPlugins(page);
  await install(page, 'grove-amber.sgplugin.json', AMBER_TEXT, AMBER);
  await setEnabled(page, AMBER, true);
  await expect(page.getByTestId(`use-theme-${AMBER}/amber-dark`)).toBeVisible();
  expect(await textColour(page)).toBe(BUILTIN_DARK_TEXT);

  await page.getByTestId(`use-theme-${AMBER}/amber-dark`).click();
  await expect(page.getByTestId(`theme-in-use-${AMBER}/amber-dark`)).toBeVisible();
  await expect.poll(() => textColour(page)).toBe(AMBER_DARK.text);

  await backToEditor(page);
  expect(await toolbar(page)).toBe(AMBER_DARK.toolbar);
  await openEditor(page);
  await expect.poll(() => editorBackground(page)).toBe(EDITOR.amberDark);
  await screenshot(page, testInfo, 'amber-dark');

  // The same menu lists the installed themes beside the built-in, in an overlay
  // painted from the theme, and is driven from the keyboard.
  await openThemeMenu(page);
  const darkItem = page.getByTestId(`theme-option-${DARK}`);
  await expect(darkItem).toHaveAttribute('aria-checked', 'true');
  await expect(darkItem).toHaveAttribute('role', 'menuitemradio');
  await expect(page.getByTestId(`theme-option-${OFFICIAL_DARK}`)).toHaveAttribute(
    'aria-checked',
    'false',
  );
  expect(await style(page.locator('.mat-mdc-menu-panel').last(), 'background-color')).toBe(
    AMBER_DARK.menu,
  );
  // From the keyboard alone: back out to the Theme row, into the submenu again,
  // past the official Light, Dark and System, onto the light variant.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menuitem', { name: /Theme$/ })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId(`theme-option-${OFFICIAL_LIGHT}`)).toBeFocused();
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId(`theme-option-${LIGHT}`)).toBeFocused();
  await page.keyboard.press('Enter');

  await expect.poll(() => toolbar(page)).toBe(AMBER_LIGHT.toolbar);
  expect(await textColour(page)).toBe(AMBER_LIGHT.text);
  expect(await style(page.locator('html'), 'color-scheme')).toBe('light');
  await expect.poll(() => editorBackground(page)).toBe(EDITOR.amberLight);
  await screenshot(page, testInfo, 'amber-light');

  // A reload — the plugins load from the profile's store, the choice from the preferences.
  await page.reload();
  await expect.poll(() => toolbar(page)).toBe(AMBER_LIGHT.toolbar);
  await expect.poll(() => editorBackground(page)).toBe(EDITOR.amberLight);

  // The editor settings preview another palette live, and cancelling puts it back.
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /Editor appearance/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Colour scheme' }).click();
  await expect(dialog.getByText('Follows the studio’s Grove Amber Light theme')).toBeVisible();
  await dialog.getByRole('radio', { name: /Midnight/ }).click();
  await expect.poll(() => editorBackground(page)).toBe(EDITOR.midnight);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(() => editorBackground(page)).toBe(EDITOR.amberLight);

  // An explicit plugin palette for the editor, kept over the app's.
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /Editor appearance/ }).click();
  await dialog.getByRole('tab', { name: 'Colour scheme' }).click();
  await dialog.getByTestId(`editor-theme-${DARK}`).click();
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => editorBackground(page)).toBe(EDITOR.amberDark);
  expect(await toolbar(page)).toBe(AMBER_LIGHT.toolbar);

  // Removed: the fallback is painted in the scheme last worn, in the app and the
  // editor, and the choice is kept for if the package comes back.
  await openPlugins(page);
  await page.getByTestId(`plugin-remove-${AMBER}`).click();
  await expect(page.getByTestId(`plugin-${AMBER}`)).toHaveCount(0);
  await expect.poll(() => textColour(page)).toBe(BUILTIN_LIGHT_TEXT);
  await backToEditor(page);
  await expect.poll(() => editorBackground(page)).toBe(EDITOR.studioLight);
  // The stylesheet's own pair again, not a value left inline.
  expect(await token(page, '--mat-sys-primary')).toBe(BUILTIN_PRIMARY);
  await openThemeMenu(page);
  await expect(page.getByTestId(`theme-option-${OFFICIAL_LIGHT}`)).toHaveAttribute(
    'aria-checked',
    'false',
  );
});

test('an update, a partial palette, an older package and another profile', async ({ page }) => {
  await openStudio(page);
  await openPlugins(page);
  await install(page, 'grove-amber.sgplugin.json', AMBER_TEXT, AMBER);
  await setEnabled(page, AMBER, true);

  // A complete palette, then one that leaves roles to the built-in: none of the first stays.
  await page.getByTestId(`use-theme-${AMBER}/amber-dark`).click();
  await expect.poll(() => token(page, '--mat-sys-secondary')).toBe('#d9b98c');
  await page.getByTestId(`use-theme-${AMBER}/amber-light`).click();
  await expect.poll(() => textColour(page)).toBe(AMBER_LIGHT.text);
  expect(await token(page, '--mat-sys-secondary')).not.toBe('#d9b98c');
  expect(await token(page, '--mat-sys-error')).not.toBe('#ffb4a8');
  expect(await token(page, '--mat-sys-error')).toContain('light-dark(');

  // A new release under the same id: installing it switches it off, so the
  // fallback is back, light like the theme last worn; switched on again, its new
  // colours are worn.
  const update = JSON.parse(AMBER_TEXT);
  update.manifest.version = '1.1.0';
  update.manifest.contributions[1].ui.primary = '#1d6b3a';
  update.manifest.contributions[1].ui['on-surface'] = '#14301f';
  await install(page, 'grove-amber-1.1.0.sgplugin.json', JSON.stringify(update), AMBER);
  await expect(page.getByText('1.1.0').first()).toBeVisible();
  await expect.poll(() => textColour(page)).toBe(BUILTIN_LIGHT_TEXT);
  await setEnabled(page, AMBER, true);
  await expect.poll(() => token(page, '--mat-sys-primary')).toBe('#1d6b3a');
  expect(await textColour(page)).toBe(rgb('#14301f'));

  // A package from before themes still installs and runs beside it.
  await install(page, 'isf.sgplugin.json', ISF_TEXT, 'dev.shadergrove.isf');
  await setEnabled(page, 'dev.shadergrove.isf', true);
  await expect(page.getByTestId('import-dev.shadergrove.isf/isf-import')).toBeEnabled();
  expect(await textColour(page)).toBe(rgb('#14301f'));

  // Signed out, the anonymous profile has no such package: the fallback is
  // painted, and the choice is still there for when the account comes back.
  await page.context().clearCookies();
  await page.goto('/');
  await expect(page.locator('mat-toolbar.toolbar')).toBeVisible();
  await expect.poll(() => textColour(page)).toBe(BUILTIN_LIGHT_TEXT);
  const stored = await page.evaluate(
    () => JSON.parse(localStorage.getItem('shader-studio.preferences') ?? '{}').appThemeId,
  );
  expect(stored).toBe(LIGHT);
});

test('the official Light and Dark: a default pack, System mode, parity and removal', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await openStudio(page);
  const menuPanel = () => style(page.locator('.mat-mdc-menu-panel').last(), 'background-color');

  // A fresh profile has it installed and switched on, beside the other defaults.
  await openPlugins(page);
  await expect(page.getByTestId(`plugin-enable-${DEFAULTS}`).getByRole('switch')).toBeChecked();
  await backToEditor(page);

  // The legacy built-in Dark became the official Dark: one row per theme, no duplicate.
  await openThemeMenu(page);
  await expect(page.getByTestId(`theme-option-${OFFICIAL_DARK}`)).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.getByTestId(`theme-option-${OFFICIAL_LIGHT}`)).toBeVisible();
  await expect(page.getByTestId(`theme-system-${SYSTEM}`)).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('theme-option-dark')).toHaveCount(0);
  await expect(page.getByTestId('theme-option-light')).toHaveCount(0);
  await expect(page.getByTestId('theme-option-system')).toHaveCount(0);
  const worn = {
    text: await textColour(page),
    toolbar: await toolbar(page),
    menu: await menuPanel(),
  };
  expect(worn.text).toBe(BUILTIN_DARK_TEXT);
  await closeMenus(page);
  await openEditor(page);
  await expect.poll(() => editorBackground(page)).toBe(EDITOR.studioDark);
  await screenshot(page, testInfo, 'official-dark');

  // System follows the OS, in the chrome and in Monaco, both ways.
  await openThemeMenu(page);
  await page.getByTestId(`theme-system-${SYSTEM}`).click();
  await closeMenus(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => textColour(page)).toBe(BUILTIN_LIGHT_TEXT);
  expect(await style(page.locator('html'), 'color-scheme')).toBe('light');
  await expect.poll(() => editorBackground(page)).toBe(EDITOR.studioLight);
  await screenshot(page, testInfo, 'official-light-system');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => textColour(page)).toBe(BUILTIN_DARK_TEXT);
  await expect.poll(() => editorBackground(page)).toBe(EDITOR.studioDark);
  await page.reload();
  await openThemeMenu(page);
  await expect(page.getByTestId(`theme-system-${SYSTEM}`)).toHaveAttribute('aria-checked', 'true');
  await closeMenus(page);

  // Switched off, the fallback paints exactly what the pack did, and nothing stays inline.
  await openPlugins(page);
  await setEnabled(page, DEFAULTS, false);
  await backToEditor(page);
  expect(await token(page, '--mat-sys-primary')).toBe(BUILTIN_PRIMARY);
  await openThemeMenu(page);
  await expect(page.getByTestId('theme-none')).toBeVisible();
  expect({
    text: await textColour(page),
    toolbar: await toolbar(page),
    menu: await menuPanel(),
  }).toEqual(worn);
  await closeMenus(page);
  await screenshot(page, testInfo, 'fallback-dark');

  // Removed, it stays removed across a reload; reinstalling it is explicit, and leaves it off.
  await openPlugins(page);
  await page.getByTestId(`plugin-remove-${DEFAULTS}`).click();
  await expect(page.getByTestId(`plugin-${DEFAULTS}`)).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId(`install-available-${DEFAULTS}`)).toBeVisible();
  await expect(page.getByTestId(`plugin-${DEFAULTS}`)).toHaveCount(0);
  await page.getByTestId(`install-available-${DEFAULTS}`).click();
  await expect(page.getByTestId(`plugin-enable-${DEFAULTS}`).getByRole('switch')).not.toBeChecked();
  await setEnabled(page, DEFAULTS, true);
  // The choice was kept all along: System, now dark like the OS.
  await expect.poll(() => token(page, '--mat-sys-surface')).toBe('#141416');
});

/** Closes every open menu, the Theme submenu and the menu it came from. */
async function closeMenus(page: Page): Promise<void> {
  const panels = page.locator('.mat-mdc-menu-panel');
  // One Escape per menu level, each once the one above has closed.
  await expect(async () => {
    if ((await panels.count()) > 0) await page.keyboard.press('Escape');
    await expect(panels).toHaveCount(0, { timeout: 500 });
  }).toPass();
}
