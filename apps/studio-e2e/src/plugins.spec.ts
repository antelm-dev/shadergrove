// The official Shadertoy and Wallpaper Engine plugins, end to end in the
// browser: discovered under Available, installed (off), switched on, run from
// the editor's menus and from Installed — paste and API imports through the
// host's import dialog, a ZIP export of the open draft — kept
// across a reload, and removed. Their menu entries exist only while the plugin
// is installed and switched on, and use it then. Shadertoy itself is never
// contacted: the app's own provider routes are answered by the test, which is
// also how it sees exactly what the browser sent to the server.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';

test.describe.configure({ timeout: 300_000 });

const SHADERTOY = 'dev.shadergrove.shadertoy';
const WALLPAPER = 'dev.shadergrove.wallpaper-engine';
const IMPORTER = `${SHADERTOY}/shadertoy`;
const EXPORTER = `${WALLPAPER}/wallpaper-engine`;

const fixture = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../../plugins/official/shadertoy/fixtures/multipass.json'),
    'utf8',
  ),
) as unknown;

/**
 * Importing writes to the library, which an unverified account may not do.
 * The test account lives in the server's throwaway store (see `serve.ts`), so
 * it is verified there directly.
 */
test.beforeAll(() => {
  // `node:sqlite` is newer than this project's Node typings; only these calls are used.
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
    DatabaseSync: new (path: string) => {
      prepare(sql: string): { run(...values: unknown[]): unknown };
      close(): void;
    };
  };
  const db = new DatabaseSync(join(tmpdir(), 'shadergrove-e2e', 'shader-studio.sqlite'));
  try {
    db.prepare('UPDATE users SET email_verified = 1 WHERE email = ?').run('e2e@example.test');
  } finally {
    db.close();
  }
});

async function openStudio(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('mat-toolbar.toolbar')).toBeVisible();
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
}

async function menuItem(page: Page, name: RegExp): Promise<void> {
  await page.getByRole('button', { name: 'More actions' }).click();
  const direct = page.getByRole('menuitem', { name });
  if (!(await direct.isVisible())) {
    await page.getByRole('menuitem', { name: /Import & export/ }).click();
  }
  await page.getByRole('menuitem', { name }).click();
}

/** The rows of the More actions menu's Import & export section, as they are now. */
async function importExportItems(page: Page): Promise<string[]> {
  await page.getByRole('button', { name: 'More actions' }).click();
  const section = page.getByRole('menuitem', { name: /Import & export/ });
  if (await section.isVisible()) await section.click();
  await expect(page.getByRole('menuitem', { name: /Export shader/ }).first()).toBeVisible();
  const names = (await page.getByRole('menuitem').allTextContents()).map((name) => name.trim());
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  return names;
}

async function openPlugins(page: Page): Promise<void> {
  await page.getByTestId('open-plugins').click();
  await expect(page).toHaveURL(/\/plugins/);
}

async function backToEditor(page: Page): Promise<void> {
  await page.getByRole('link', { name: /back to the editor/i }).click();
  await expect(page.locator('mat-toolbar.toolbar')).toBeVisible();
}

/** Installs from Available: the package arrives switched off. */
async function installAvailable(page: Page, id: string): Promise<void> {
  await page.getByTestId(`install-available-${id}`).click();
  await expect(page.getByTestId(`plugin-${id}`)).toBeVisible();
  await expect(page.getByTestId(`available-installed-${id}`)).toBeVisible();
  await expect(page.getByTestId(`plugin-enable-${id}`).getByRole('switch')).not.toBeChecked();
}

async function setEnabled(page: Page, id: string, on: boolean): Promise<void> {
  const toggle = page.getByTestId(`plugin-enable-${id}`).getByRole('switch');
  await toggle.click();
  if (on) await expect(toggle).toBeChecked();
  else await expect(toggle).not.toBeChecked();
}

async function shaderNames(page: Page): Promise<string[]> {
  const response = await page.request.get('/api/shaders');
  const body = (await response.json()) as { shaders: { name: string }[] };
  return body.shaders.map((shader) => shader.name);
}

test('Shadertoy Import: discovered, installed off, paste and API imports, kept, removed', async ({
  page,
}) => {
  const sourceRequests: unknown[] = [];
  await page.route('**/api/import/shadertoy/source', async (route) => {
    sourceRequests.push(route.request().postDataJSON());
    await route.fulfill({ json: { sourceId: 'ParFix', source: fixture } });
  });
  await page.route('**/api/import/shadertoy/asset**', (route) =>
    route.fulfill({ status: 502, json: { error: { message: 'request failed (404)' } } }),
  );

  await openStudio(page);

  // Without the plugin, nothing offers to import from Shadertoy.
  expect(await importExportItems(page)).not.toContainEqual(expect.stringMatching(/Shadertoy/));
  await menuItem(page, /New shader/);
  await expect(page.getByRole('dialog')).toContainText('New shader');
  await expect(page.getByRole('dialog').getByRole('button', { name: /Shadertoy/ })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Installed but still off: still nothing.
  await openPlugins(page);
  await expect(page.getByTestId(`available-${WALLPAPER}`)).toBeVisible();
  await installAvailable(page, SHADERTOY);
  await backToEditor(page);
  expect(await importExportItems(page)).not.toContainEqual(expect.stringMatching(/Shadertoy/));

  // Switched on: the menu and the New shader dialog both open the importer's own dialog,
  // right where the user is — no trip to Plugins.
  await openPlugins(page);
  await setEnabled(page, SHADERTOY, true);
  await backToEditor(page);
  const editorUrl = new URL(page.url()).pathname;
  await menuItem(page, /New shader/);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Import from Shadertoy/ })
    .click();
  const dialog = page.getByRole('dialog', { name: /Import from Shadertoy/ });
  await expect(dialog).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(editorUrl);
  await expect(dialog.getByTestId('import-run')).toBeDisabled();
  await dialog.getByTestId('import-cancel').click();
  await expect(dialog).toHaveCount(0);

  await menuItem(page, /Import from Shadertoy/);
  await expect(dialog).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(editorUrl);
  // Escape closes it and gives the keyboard back to where the menu was opened from.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'More actions' })).toBeFocused();

  // Paste: one Image pass becomes a new shader, created whole.
  await menuItem(page, /Import from Shadertoy/);
  await dialog.getByTestId('import-mode-paste').check();
  await dialog.getByTestId('import-paste-name').fill('Pasted Waves');
  await dialog
    .getByTestId('import-paste-source')
    .fill('void mainImage(out vec4 c, in vec2 p) { c = vec4(p / iResolution.xy, 0.5, 1.0); }');
  await dialog.getByTestId('import-run').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.mat-mdc-snack-bar-container')).toContainText(
    'Imported “Pasted Waves”.',
  );
  expect(await shaderNames(page)).toContain('Pasted Waves');

  // Invalid source is refused with a readable error in the dialog, which stays; nothing is created.
  const before = (await shaderNames(page)).length;
  await menuItem(page, /Import from Shadertoy/);
  await dialog.getByTestId('import-mode-paste').check();
  await dialog.getByTestId('import-paste-source').fill('void main() {}');
  await dialog.getByTestId('import-run').click();
  await expect(dialog.getByTestId('import-message')).toContainText('mainImage');
  expect(await shaderNames(page)).toHaveLength(before);

  // API: the host fetches the document; the conversion's warnings stay until the user goes on.
  await dialog.getByTestId('import-mode-provider').check();
  await dialog.getByTestId('import-field-idOrUrl').fill('https://www.shadertoy.com/view/ParFix');
  await dialog.getByTestId('import-field-apiKey').fill('e2e-key');
  await dialog.getByTestId('import-run').click();
  await expect(dialog.getByTestId('import-done')).toContainText('Imported “Parity fixture”.');
  await expect(dialog.getByTestId('import-warnings')).toContainText('sound pass');
  await expect(dialog.getByTestId('import-warnings')).toContainText('Failed to download a texture');
  expect(sourceRequests).toEqual([{ idOrUrl: 'ParFix', apiKey: 'e2e-key' }]);
  expect(await shaderNames(page)).toContain('Parity fixture');
  await dialog.getByTestId('import-editor').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.doc-name')).toHaveText('Parity fixture');

  // The Installed page opens the very same dialog, in place, and says what happened itself.
  await openPlugins(page);
  await page.getByTestId(`open-import-${IMPORTER}`).click();
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/plugins/);
  await dialog.getByTestId('import-mode-paste').check();
  await dialog.getByTestId('import-paste-name').fill('Installed Waves');
  await dialog
    .getByTestId('import-paste-source')
    .fill('void mainImage(out vec4 c, in vec2 p) { c = vec4(p / iResolution.xy, 0.25, 1.0); }');
  await dialog.getByTestId('import-run').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('plugin-message')).toContainText('Imported “Installed Waves”.');
  expect(await shaderNames(page)).toContain('Installed Waves');

  // Kept across a reload, still on, with the key remembered by the host.
  await page.reload();
  const toggle = page.getByTestId(`plugin-enable-${SHADERTOY}`).getByRole('switch');
  await expect(toggle).toBeChecked();
  await page.getByTestId(`open-import-${IMPORTER}`).click();
  await dialog.getByTestId('import-mode-provider').check();
  await expect(dialog.getByTestId('import-field-apiKey')).toHaveValue('e2e-key');
  await dialog.getByTestId('import-cancel').click();
  await expect(dialog).toHaveCount(0);

  // Removing the plugin keeps what it imported.
  await page.getByTestId(`plugin-remove-${SHADERTOY}`).click();
  await expect(page.getByTestId(`plugin-${SHADERTOY}`)).toHaveCount(0);
  await expect(page.getByTestId(`install-available-${SHADERTOY}`)).toBeVisible();
  expect(await shaderNames(page)).toEqual(
    expect.arrayContaining(['Pasted Waves', 'Parity fixture', 'Installed Waves']),
  );
  // …and takes its menu entry with it.
  await backToEditor(page);
  expect(await importExportItems(page)).not.toContainEqual(expect.stringMatching(/Shadertoy/));
});

test('Shadertoy Import keeps the open draft: a declined replacement and a cancelled fetch import nothing', async ({
  page,
}) => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((done) => (release = done));
  let slow = false;
  await page.route('**/api/import/shadertoy/source', async (route) => {
    if (slow) await gate;
    await route.fulfill({ json: { sourceId: 'ParFix', source: fixture } }).catch(() => undefined);
  });
  await page.addInitScript(() => {
    // Not in the plugin sandbox's frames: they have no storage to give.
    if (window.top !== window) return;
    localStorage.setItem(
      'shader-studio.preferences',
      JSON.stringify({ paused: true, editorOpen: true, browserOpen: false }),
    );
  });
  await page.goto('/');
  const shell = page.locator('app-editor-shell');
  const dirty = shell.getByText('Unsaved changes', { exact: true });
  await expect(shell.locator('.monaco-editor')).toBeVisible();

  await openPlugins(page);
  await installAvailable(page, SHADERTOY);
  await setEnabled(page, SHADERTOY, true);
  await backToEditor(page);
  await expect(shell.locator('.monaco-editor')).toBeVisible();
  await shell.locator('.monaco-editor').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n// unsaved draft');
  await expect(dirty).toBeVisible();
  const before = await shaderNames(page);

  const dialog = page.getByRole('dialog', { name: /Import from Shadertoy/ });
  await menuItem(page, /Import from Shadertoy/);
  await dialog.getByTestId('import-mode-paste').check();
  await dialog.getByTestId('import-paste-name').fill('Declined');
  await dialog
    .getByTestId('import-paste-source')
    .fill('void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }');
  await dialog.getByTestId('import-run').click();

  // Replacing the open work asks first; declining keeps the draft, the form and the library as they were.
  const unsaved = page.getByRole('dialog', { name: 'Unsaved changes' });
  await expect(unsaved).toBeVisible();
  await unsaved.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog.getByTestId('import-message')).toContainText('Cancelled');
  await expect(dialog.getByTestId('import-paste-name')).toHaveValue('Declined');
  await expect(dirty).toBeVisible();
  expect(await shaderNames(page)).toEqual(before);

  // A fetch under way is cancelled by closing the dialog, which waits for it to end.
  slow = true;
  await dialog.getByTestId('import-mode-provider').check();
  await dialog.getByTestId('import-field-idOrUrl').fill('ParFix');
  await dialog.getByTestId('import-field-apiKey').fill('e2e-key');
  await dialog.getByTestId('import-run').click();
  await expect(dialog.getByTestId('import-step')).toBeVisible();
  await dialog.getByTestId('import-cancel').click();
  await expect(dialog).toHaveCount(0);
  release();
  await expect(unsaved).toHaveCount(0);
  await expect(dirty).toBeVisible();
  expect(await shaderNames(page)).toEqual(before);
});

test('Shadertoy Import: leaving with browser Back while a fetch runs cancels it and imports nothing', async ({
  page,
}) => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((done) => (release = done));
  let answered = false;
  await page.route('**/api/import/shadertoy/source', async (route) => {
    await gate;
    await route
      .fulfill({ json: { sourceId: 'BackNav', source: fixture } })
      .catch(() => undefined);
    answered = true;
  });
  await openStudio(page);
  await openPlugins(page);
  if (await page.getByTestId(`install-available-${SHADERTOY}`).isVisible()) {
    await installAvailable(page, SHADERTOY);
  }
  const toggle = page.getByTestId(`plugin-enable-${SHADERTOY}`).getByRole('switch');
  if (!(await toggle.isChecked())) await setEnabled(page, SHADERTOY, true);
  await backToEditor(page);
  const before = await shaderNames(page);

  const dialog = page.getByRole('dialog', { name: /Import from Shadertoy/ });
  await menuItem(page, /Import from Shadertoy/);
  await dialog.getByTestId('import-mode-provider').check();
  await dialog.getByTestId('import-field-idOrUrl').fill('BackNav');
  await dialog.getByTestId('import-field-apiKey').fill('e2e-key');
  await dialog.getByTestId('import-run').click();
  await expect(dialog.getByTestId('import-step')).toBeVisible();

  // Browser Back closes every open dialog (MatDialog closeOnNavigation). Closing the
  // dialog while it runs must cancel that run (AC-IMPORT-LIFECYCLE), as Cancel does.
  await page.goBack();
  await expect(dialog).toHaveCount(0);
  release();
  await expect.poll(() => answered).toBe(true);
  // Give an un-cancelled run time to convert, adopt and save.
  await page.waitForTimeout(5_000);
  expect(await shaderNames(page)).toEqual(before);
});

test('Wallpaper Engine Export: offered only while on, exports the open draft as a ZIP', async ({
  page,
}) => {
  await openStudio(page);

  expect(await importExportItems(page)).not.toContainEqual(
    expect.stringMatching(/Wallpaper Engine/),
  );
  await openPlugins(page);
  await installAvailable(page, WALLPAPER);
  await setEnabled(page, WALLPAPER, true);

  const download = page.waitForEvent('download');
  await page.getByTestId(`run-${EXPORTER}`).click();
  const zip = await download;
  expect(zip.suggestedFilename()).toMatch(/\.zip$/);
  const bytes = readFileSync(await zip.path());
  const listing = bytes.toString('latin1');
  const stem = zip.suggestedFilename().replace(/\.zip$/, '');
  expect(listing).toContain(`${stem}/index.html`);
  expect(listing).toContain(`${stem}/project.json`);
  expect(listing).toContain('"type": "web"');
  expect(listing).toContain('wallpaperPropertyListener');
  await expect(page.getByTestId('plugin-message')).toContainText(`Exported to ${stem}.zip.`);

  // With the plugin on, its menu entry runs it directly.
  await backToEditor(page);
  const again = page.waitForEvent('download');
  await menuItem(page, /Export to Wallpaper Engine/);
  expect((await again).suggestedFilename()).toBe(`${stem}.zip`);

  // Switched off, the entry is gone rather than leading anywhere.
  await openPlugins(page);
  await setEnabled(page, WALLPAPER, false);
  await backToEditor(page);
  expect(await importExportItems(page)).not.toContainEqual(
    expect.stringMatching(/Wallpaper Engine/),
  );
});
