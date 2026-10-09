// Project Recipes, end to end in the browser: the official recipe pack installed
// from its generated file (switched off), switched on, previewed in the app's
// renderer, used to create independent shaders from the New shader dialog and
// from its Installed card — behind the unsaved-changes question — and removed,
// leaving what it created intact: reopened, exported and imported again.

import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';

test.describe.configure({ timeout: 300_000 });

const PACK = 'dev.shadergrove.project-recipes';
const RECIPES = ['raymarching', 'particles', 'feedback-trails', 'interactive-ui'];
const TRAILS = `${PACK}/feedback-trails`;
const studio = resolve(import.meta.dirname, '../../studio');
const generated = resolve(studio, 'src/plugins');
const packFile = readdirSync(generated).find((file) => file.startsWith(`${PACK}-`))!;
const packText = readFileSync(resolve(generated, packFile), 'utf8');

/** Creating writes to the library, which an unverified account may not do (see plugins.spec.ts). */
test.beforeAll(() => {
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

/** The editor, with the main preview paused before anything renders: it would starve the CPU. */
async function openStudio(page: Page, browserOpen = false): Promise<void> {
  await page.addInitScript((browserOpen) => {
    if (window.top !== window) return;
    localStorage.setItem(
      'shader-studio.preferences',
      JSON.stringify({ paused: true, editorOpen: true, browserOpen }),
    );
  }, browserOpen);
  await page.goto('/');
  await expect(page.locator('mat-toolbar.toolbar')).toBeVisible();
}

async function openPlugins(page: Page): Promise<void> {
  await page.getByTestId('open-plugins').click();
  await expect(page).toHaveURL(/\/plugins/);
}

async function backToEditor(page: Page): Promise<void> {
  await page.getByRole('link', { name: /back to the editor/i }).click();
  await expect(page.locator('mat-toolbar.toolbar')).toBeVisible();
}

async function pickPackage(page: Page, text: string): Promise<void> {
  await page.getByTestId('plugin-file').setInputFiles({
    name: 'project-recipes.sgplugin.json',
    mimeType: 'application/json',
    buffer: Buffer.from(text),
  });
  await expect(page.getByTestId('plugin-review')).toBeVisible();
}

/** Installs the pack from its file, if it is not installed yet; it arrives switched off. */
async function installPack(page: Page): Promise<void> {
  await expect(page.getByTestId('plugin-pick')).toBeVisible();
  if ((await page.getByTestId(`plugin-${PACK}`).count()) > 0) return;
  await pickPackage(page, packText);
  await page.getByTestId('plugin-install').click();
  await expect(page.getByTestId(`plugin-${PACK}`)).toBeVisible();
  await expect(page.getByTestId(`plugin-enable-${PACK}`).getByRole('switch')).not.toBeChecked();
}

async function setEnabled(page: Page, on: boolean): Promise<void> {
  const toggle = page.getByTestId(`plugin-enable-${PACK}`).getByRole('switch');
  if ((await toggle.isChecked()) !== on) await toggle.click();
  if (on) await expect(toggle).toBeChecked();
  else await expect(toggle).not.toBeChecked();
}

async function removePack(page: Page): Promise<void> {
  await page.getByTestId(`plugin-remove-${PACK}`).click();
  await expect(page.getByTestId(`plugin-${PACK}`)).toHaveCount(0);
}

interface Shader {
  id: string;
  name: string;
}

async function shaders(page: Page): Promise<Shader[]> {
  const response = await page.request.get('/api/shaders');
  return ((await response.json()) as { shaders: Shader[] }).shaders;
}

interface Pass {
  id: string;
  kind: string;
  source: string;
  channels: { kind: string; passId?: string; feedback?: boolean }[];
}

async function project(page: Page, name: string): Promise<{ id: string; passes: Pass[] }> {
  const shader = (await shaders(page)).find((entry) => entry.name === name);
  if (!shader) throw new Error(`no shader named ${name}`);
  const response = await page.request.get(`/api/shaders/${shader.id}`);
  const record = (await response.json()) as { shader: { project: { passes: Pass[] } } };
  return { id: shader.id, passes: record.shader.project.passes };
}

/** The New shader dialog's recipe entry, which opens the gallery. */
async function openGallery(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /New shader/ }).click();
  await page.getByTestId('new-shader-recipes:new').click();
  await expect(page.getByTestId('recipe-gallery')).toBeVisible();
}

/** Whether a preview canvas shows a picture: more than a handful of distinct colours. */
async function previewColours(page: Page): Promise<number> {
  return page.getByTestId('recipe-preview-canvas').evaluate((canvas: HTMLCanvasElement) => {
    const copy = document.createElement('canvas');
    copy.width = 64;
    copy.height = 36;
    const context = copy.getContext('2d')!;
    context.drawImage(canvas, 0, 0, copy.width, copy.height);
    const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
    const colours = new Set<number>();
    for (let index = 0; index < pixels.length; index += 4) {
      colours.add((pixels[index]! << 16) | (pixels[index + 1]! << 8) | pixels[index + 2]!);
    }
    return colours.size;
  });
}

test('Project Recipes: installed off from its file, switched on and off, malformed packs refused, removed', async ({
  page,
}) => {
  await openStudio(page);
  await openPlugins(page);

  // A template binding a texture, and template data under protocol 3, are refused at review.
  const json = JSON.parse(packText);
  json.templates['particles'].project.passes[0].channels[1] = { kind: 'texture', slot: 0 };
  await pickPackage(page, JSON.stringify(json));
  await expect(page.getByTestId('plugin-review')).toContainText('must not bind a texture');
  await expect(page.getByTestId('plugin-install')).toHaveCount(0);
  const older = JSON.parse(packText);
  older.manifest.protocolVersion = 3;
  await pickPackage(page, JSON.stringify(older));
  await expect(page.getByTestId('plugin-install')).toHaveCount(0);

  await pickPackage(page, packText);
  const review = page.getByTestId('plugin-review');
  await expect(review).toContainText('Project Recipes');
  for (const name of [
    'Raymarched shape',
    'Procedural particles',
    'Feedback trails',
    'Interactive UI',
  ]) {
    await expect(review).toContainText(name);
  }
  await page.getByTestId('plugin-install').click();
  await expect(page.getByTestId(`plugin-${PACK}`)).toBeVisible();
  await expect(page.getByTestId(`plugin-enable-${PACK}`).getByRole('switch')).not.toBeChecked();
  for (const id of RECIPES) {
    await expect(page.getByTestId(`contribution-${PACK}/${id}`)).toBeVisible();
  }

  await setEnabled(page, true);
  await page.reload();
  await expect(page.getByTestId(`plugin-enable-${PACK}`).getByRole('switch')).toBeChecked();
  await setEnabled(page, false);
  await removePack(page);
});

test('Project Recipes: previews every recipe, creates independent feedback shaders and keeps them after removal', async ({
  page,
}) => {
  await openStudio(page, true);
  await openPlugins(page);
  await installPack(page);
  // Off: no recipe card, and the New shader dialog offers none.
  await expect(page.getByTestId(`recipe-${TRAILS}`)).toHaveCount(0);
  await backToEditor(page);
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /New shader/ }).click();
  await expect(page.getByRole('dialog')).toContainText('New shader');
  await expect(page.getByTestId('new-shader-recipes:new')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await openPlugins(page);
  await setEnabled(page, true);
  await backToEditor(page);
  await openGallery(page);
  const gallery = page.getByTestId('recipe-gallery');

  // Every recipe compiles and draws in the app's renderer; one preview runs at a time.
  for (const id of RECIPES) {
    const ref = `${PACK}/${id}`;
    await expect(gallery.getByTestId(`recipe-${ref}`)).toBeVisible();
    await gallery.getByTestId(`recipe-preview-${ref}`).click();
    await expect(gallery.getByTestId('recipe-preview-canvas')).toHaveCount(1);
    await expect.poll(() => previewColours(page), { timeout: 30_000 }).toBeGreaterThan(8);
    await expect(gallery.getByTestId('recipe-preview-problem')).toHaveCount(0);
  }
  await test.info().attach('recipe gallery', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  await gallery.getByTestId(`recipe-preview-${PACK}/interactive-ui`).click();
  await expect(gallery.getByTestId('recipe-preview-canvas')).toHaveCount(0);

  // Created twice, under two names: two shaders, each with its own feedback graph.
  await expect(gallery.getByTestId(`recipe-name-${TRAILS}`)).toHaveValue('Feedback trails');
  await gallery.getByTestId(`recipe-name-${TRAILS}`).fill('Trails one');
  await gallery.getByTestId(`recipe-create-${TRAILS}`).click();
  await expect(gallery).toHaveCount(0);
  await expect(
    page.locator('.mat-mdc-snack-bar-container', {
      hasText: 'Created “Trails one” from a recipe.',
    }),
  ).toBeVisible();
  await expect(page.locator('.doc-name')).toHaveText('Trails one');

  await openGallery(page);
  await gallery.getByTestId(`recipe-name-${TRAILS}`).fill('Trails two');
  await gallery.getByTestId(`recipe-create-${TRAILS}`).click();
  await expect(gallery).toHaveCount(0);
  await expect(page.locator('.doc-name')).toHaveText('Trails two');

  const one = await project(page, 'Trails one');
  const two = await project(page, 'Trails two');
  expect(one.id).not.toBe(two.id);
  const ids = (passes: Pass[]) => passes.map((pass) => pass.id);
  expect(ids(one.passes).filter((id) => ids(two.passes).includes(id))).toEqual([]);
  for (const { passes } of [one, two]) {
    const buffer = passes.find((pass) => pass.kind === 'buffer')!;
    const image = passes.find((pass) => pass.kind === 'image')!;
    expect(buffer.channels[0]).toEqual({ kind: 'buffer', passId: buffer.id, feedback: true });
    expect(image.channels[0]).toEqual({ kind: 'buffer', passId: buffer.id, feedback: false });
  }

  // Removing the pack takes its entries away and leaves what it created alone.
  await openPlugins(page);
  await removePack(page);
  await backToEditor(page);
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /New shader/ }).click();
  await expect(page.getByTestId('new-shader-recipes:new')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Reopened from the library after a reload: what was saved is what comes back.
  await page.reload();
  await page.locator('app-shader-browser .shader-row', { hasText: 'Trails one' }).click();
  await expect(page.locator('.doc-name')).toHaveText('Trails one');
  expect((await project(page, 'Trails one')).passes).toEqual(one.passes);

  // Its exported bundle imports as a shader of its own with the same graph.
  const exported = await page.request.get(`/api/shaders/${one.id}/export`);
  expect(exported.ok()).toBe(true);
  const bundle = (await exported.json()) as { shader: { name: string } };
  bundle.shader.name = 'Trails again';
  const origin = new URL(page.url()).origin;
  const imported = await page.request.post('/api/import', {
    data: { bundle, mode: 'rename' },
    headers: { Origin: origin },
  });
  expect(imported.ok()).toBe(true);
  expect((await project(page, 'Trails again')).passes).toEqual(one.passes);
});

test('Project Recipes: an unsaved draft is kept when the question is declined, and replaced only when discarded', async ({
  page,
}) => {
  await openStudio(page);
  await openPlugins(page);
  await installPack(page);
  await setEnabled(page, true);

  // The Installed card offers the same recipes.
  const card = page.getByTestId(`recipe-${PACK}/particles`);
  await expect(card).toContainText('Procedural particles');
  await expect(card).toContainText('Beginner');

  await backToEditor(page);
  const shell = page.locator('app-editor-shell');
  const dirty = shell.getByText('Unsaved changes', { exact: true });
  await expect(shell.locator('.monaco-editor')).toBeVisible();
  await shell.locator('.monaco-editor').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n// unsaved draft');
  await expect(dirty).toBeVisible();
  const before = await shaders(page);

  await openGallery(page);
  const gallery = page.getByTestId('recipe-gallery');
  const ref = `${PACK}/particles`;
  await gallery.getByTestId(`recipe-name-${ref}`).fill('Kept away');
  await gallery.getByTestId(`recipe-create-${ref}`).click();
  const unsaved = page.getByRole('dialog', { name: 'Unsaved changes' });
  await expect(unsaved).toBeVisible();
  await unsaved.getByRole('button', { name: 'Cancel' }).click();
  await expect(gallery.getByTestId(`recipe-message-${ref}`)).toContainText('Nothing was created.');
  await expect(dirty).toBeVisible();
  expect(await shaders(page)).toEqual(before);

  await gallery.getByTestId(`recipe-create-${ref}`).click();
  await expect(unsaved).toBeVisible();
  await unsaved.getByRole('button', { name: 'Discard' }).click();
  await expect(gallery).toHaveCount(0);
  await expect(page.locator('.doc-name')).toHaveText('Kept away');
  expect((await shaders(page)).map((shader) => shader.name)).toContain('Kept away');
  expect(await shaders(page)).toHaveLength(before.length + 1);

  await openPlugins(page);
  await removePack(page);
});
