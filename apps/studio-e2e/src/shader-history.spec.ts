// The `evaluate` callbacks below run in the page.
/// <reference lib="dom" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { APIRequestContext, Page } from '@playwright/test';

import { expect, test } from './fixtures';

// Shader History, phase 1, over the HTTP-backed web app: the timeline, inline
// checkpoints, the unsaved-changes guard in front of a restore, a stale head
// refused, out-of-scope data left alone, and a French profile holding the
// language pack from before History.

test.describe.configure({ timeout: 300_000 });

const VERTEX = readFileSync(
  resolve(import.meta.dirname, '../../../examples/shaders/hex-pulse/vertex.glsl'),
  'utf8',
);
const PIXEL = readFileSync(resolve(import.meta.dirname, '../../../.bruno/fixtures/one-pixel.png'));
const fragment = (blue: string) =>
  `precision highp float;\nvarying vec2 vUv;\nvoid main() {\n  gl_FragColor = vec4(vUv, ${blue}, 1.0);\n}\n`;

interface Entry {
  revision: number;
  cause: string;
  checkpointName: string | null;
  restoredFromRevision: number | null;
}

interface Record {
  revision: number;
  fragment: string;
  presets: { name: string }[];
  channels: { ext: string | null; wrap: string }[];
}

/** The preview paused and the editor open: heavy UI work starves a software-rendered preview. */
async function preferences(page: Page, overrides: { [key: string]: unknown } = {}): Promise<void> {
  await page.addInitScript((extra) => {
    localStorage.setItem(
      'shader-studio.preferences',
      JSON.stringify({
        paused: true,
        browserOpen: true,
        guiVisible: false,
        fileExplorerOpen: false,
        editorOpen: true,
        ...extra,
      }),
    );
  }, overrides);
}

async function api<T>(response: ReturnType<APIRequestContext['get']>): Promise<T> {
  const answered = await response;
  expect(answered.ok(), await answered.text()).toBe(true);
  const body = await answered.text();
  return (body ? JSON.parse(body) : undefined) as T;
}

async function createShader(page: Page, name: string): Promise<string> {
  const { shader } = await api<{ shader: { id: string } }>(
    page.request.post('/api/shaders', {
      data: { name, fragment: fragment('0.1'), vertex: VERTEX },
    }),
  );
  return shader.id;
}

/** A save from somewhere else: another tab, another device. */
async function saveElsewhere(page: Page, id: string, blue: string): Promise<void> {
  await api(page.request.put(`/api/shaders/${id}`, { data: { fragment: fragment(blue) } }));
}

const head = (page: Page, id: string) =>
  api<{ shader: Record }>(page.request.get(`/api/shaders/${id}`)).then(({ shader }) => shader);
const history = (page: Page, id: string) =>
  api<{ history: Entry[] }>(page.request.get(`/api/shaders/${id}/history`)).then(
    ({ history }) => history,
  );

async function open(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.locator('app-shader-browser .shader-row', { hasText: name }).click();
  await expect(page.locator('.doc-name')).toHaveText(name);
  await expect(page.locator('app-editor-shell .monaco-editor')).toHaveCount(1, {
    timeout: 30_000,
  });
}

const dialog = (page: Page) => page.locator('app-history-dialog');
const rows = (page: Page) => dialog(page).locator('ol.entries > li');
const row = (page: Page, revision: number) =>
  rows(page).filter({ hasText: new RegExp(`Revision ${revision}\\b`) });
const dirtyMark = (page: Page) => page.locator('app-editor-shell .dirty');

async function openHistory(page: Page, label = 'History…'): Promise<void> {
  await page.locator('app-editor-shell .editor-toolbar').click({ button: 'right' });
  await page.getByRole('menuitem', { name: label }).click();
  await expect(dialog(page)).toBeVisible();
}

async function type(page: Page, text: string): Promise<void> {
  await page.locator('app-editor-shell .monaco-editor').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text);
}

test('timeline, checkpoints, guarded restore and a stale head over HTTP', async ({
  page,
}, testInfo) => {
  await preferences(page);
  const name = 'History timeline';
  const id = await createShader(page, name);
  await saveElsewhere(page, id, '0.2');
  await saveElsewhere(page, id, '0.3');
  await open(page, name);

  // Newest first, the head marked, every row labelled.
  await openHistory(page);
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).nth(0)).toContainText('Revision 3');
  await expect(rows(page).nth(0)).toContainText('Current');
  await expect(rows(page).nth(1)).toContainText('Saved');
  await expect(rows(page).nth(2)).toContainText('Created');
  await expect(dialog(page)).toContainText('source, settings and presets');
  await expect(dialog(page)).toContainText('not part of history');
  await expect(row(page, 3).getByRole('button', { name: 'Restore revision 3' })).toBeDisabled();

  // Name, rename and clear a checkpoint inline; the head does not move.
  await row(page, 1).getByRole('button', { name: 'Name checkpoint' }).click();
  await row(page, 1).getByLabel('Checkpoint name').fill('   ');
  await row(page, 1).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(row(page, 1)).toContainText('Use 1 to 64 characters');
  await row(page, 1).getByLabel('Checkpoint name').fill('First light');
  await row(page, 1).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(row(page, 1)).toContainText('First light');
  await row(page, 1).getByRole('button', { name: 'Rename checkpoint' }).click();
  await row(page, 1).getByLabel('Checkpoint name').fill('Dawn');
  await row(page, 1).getByLabel('Checkpoint name').press('Enter');
  await expect(row(page, 1)).toContainText('Dawn');
  await row(page, 2).getByRole('button', { name: 'Name checkpoint' }).click();
  await row(page, 2).getByLabel('Checkpoint name').fill('Throwaway');
  await row(page, 2).getByRole('button', { name: 'Save', exact: true }).click();
  await row(page, 2).getByRole('button', { name: 'Clear checkpoint name' }).click();
  await expect(row(page, 2)).not.toContainText('Throwaway');
  expect((await history(page, id)).map((entry) => entry.checkpointName)).toEqual([
    null,
    null,
    'Dawn',
  ]);
  expect((await head(page, id)).revision).toBe(3);
  await page.screenshot({ path: testInfo.outputPath('history-dialog.png') });
  await dialog(page).getByRole('button', { name: 'Close' }).click();

  // History opens over a dirty draft; Cancel at the guard loses nothing.
  await type(page, '// unsaved');
  await expect(dirtyMark(page)).toBeVisible();
  await openHistory(page);
  await row(page, 1).getByRole('button', { name: 'Restore revision 1' }).click();
  await expect(page.getByRole('heading', { name: 'Unsaved changes' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('history-guard.png') });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dirtyMark(page)).toBeVisible();
  await expect(rows(page)).toHaveCount(3);
  expect((await head(page, id)).revision).toBe(3);

  // Discard, then restore: a clean new head linked to its source, nothing deleted.
  await row(page, 1).getByRole('button', { name: 'Restore revision 1' }).click();
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(rows(page)).toHaveCount(4);
  await expect(rows(page).nth(0)).toContainText('Revision 4');
  await expect(rows(page).nth(0)).toContainText('Current');
  await expect(rows(page).nth(0)).toContainText('Restored from revision 1');
  await expect(dirtyMark(page)).toHaveCount(0);
  const restored = await head(page, id);
  expect(restored.revision).toBe(4);
  expect(restored.fragment).toBe(fragment('0.1'));
  expect((await history(page, id)).map((entry) => entry.revision)).toEqual([4, 3, 2, 1]);
  await page.screenshot({ path: testInfo.outputPath('history-restored.png') });

  // A stale head is refused: the head and the timeline stay as they were.
  await saveElsewhere(page, id, '0.5');
  await row(page, 2).getByRole('button', { name: 'Restore revision 2' }).click();
  await expect(dialog(page).locator('.notice')).toContainText(
    'This shader changed since it was opened',
  );
  expect((await head(page, id)).revision).toBe(5);
  expect((await history(page, id)).map((entry) => entry.revision)).toEqual([5, 4, 3, 2, 1]);
  await page.screenshot({ path: testInfo.outputPath('history-conflict.png') });
});

test('restoring brings presets back and leaves textures and channel settings current', async ({
  page,
}) => {
  await preferences(page);
  const name = 'History presets';
  const id = await createShader(page, name);
  await api(
    page.request.post(`/api/shaders/${id}/presets`, { data: { name: 'Calm', values: {} } }),
  );
  await api(
    page.request.put(`/api/shaders/${id}/textures/0?width=1&height=1`, {
      data: PIXEL,
      headers: { 'content-type': 'image/png' },
    }),
  );
  await api(
    page.request.put(`/api/shaders/${id}`, {
      data: { channels: [{ wrap: 'repeat' }] },
    }),
  );
  await api(page.request.delete(`/api/shaders/${id}/presets/calm`));
  const before = await head(page, id);
  expect(before.presets).toEqual([]);
  await open(page, name);

  await openHistory(page);
  await expect(rows(page).nth(0)).toContainText('Preset deleted');
  await row(page, 2).getByRole('button', { name: 'Restore revision 2' }).click();
  await expect(rows(page).nth(0)).toContainText('Restored from revision 2');

  const after = await head(page, id);
  expect(after.presets.map((preset) => preset.name)).toEqual(['Calm']);
  expect(after.channels[0]).toEqual(before.channels[0]);
  expect(after.channels[0]).toMatchObject({ ext: 'png', wrap: 'repeat' });
  await expect(dirtyMark(page)).toHaveCount(0);
});

test('a French profile holding the pre-History 1.0.5 pack is offered the History translations', async ({
  page,
}) => {
  const FRENCH = 'dev.shadergrove.language-fr';
  // The 1.0.5 pack as shipped before History: the current pack at 1.0.5 without its keys.
  const current = JSON.parse(
    readFileSync(
      resolve(
        import.meta.dirname,
        '../../studio/src/plugins/dev.shadergrove.language-fr-1.0.8.sgplugin.json',
      ),
      'utf8',
    ),
  );
  current.manifest.version = '1.0.5';
  const messages = current.manifest.contributions[0].messages as { [key: string]: string };
  for (const key of Object.keys(messages)) if (key.startsWith('history.')) delete messages[key];
  const old = Buffer.from(JSON.stringify(current, null, 2));

  await preferences(page, { editorOpen: true });
  await page.goto('/');
  await expect(page.locator('mat-toolbar.toolbar')).toBeVisible();
  await page.getByTestId('open-plugins').click();

  // Replace the seeded pack with the one an existing profile still holds.
  await page.getByTestId(`plugin-remove-${FRENCH}`).click();
  await expect(page.getByTestId(`plugin-${FRENCH}`)).toHaveCount(0);
  await page.getByTestId('plugin-file').setInputFiles({
    name: 'language-fr-pre-history-1.0.5.sgplugin.json',
    mimeType: 'application/json',
    buffer: old,
  });
  await page.getByTestId('plugin-install').click();
  const toggle = page.getByTestId(`plugin-enable-${FRENCH}`).getByRole('switch');
  if (!(await toggle.isChecked())) await toggle.click();
  await page.getByTestId(`use-language-${FRENCH}/french`).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');

  // History falls back to English in this profile today.
  await page.getByRole('link', { name: /retour.*[ée]diteur/i }).click();
  await page.locator('app-editor-shell .editor-toolbar').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'History…' })).toBeVisible();
  await page.keyboard.press('Escape');

  // The catalogue offers a newer immutable version carrying the French strings.
  await page.getByTestId('open-plugins').click();
  await expect(page.getByTestId(`install-available-${FRENCH}`)).toBeVisible({ timeout: 10_000 });
  await page.getByTestId(`install-available-${FRENCH}`).click();
  await expect(page.getByTestId(`available-installed-${FRENCH}`)).toBeVisible();
  const updated = page.getByTestId(`plugin-enable-${FRENCH}`).getByRole('switch');
  if (!(await updated.isChecked())) await updated.click();
  await expect(updated).toBeChecked();
  await expect(page.getByTestId(`plugin-${FRENCH}`)).toContainText('1.0.8');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await page.getByRole('link', { name: /retour.*[ée]diteur/i }).click();
  await openHistory(page, 'Historique…');
  await expect(dialog(page)).toContainText('code source, les réglages et les préréglages');
});
