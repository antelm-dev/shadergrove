// The `evaluate` callbacks below run in the page.
/// <reference lib="dom" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';

// Review round 1 of the Controls builder (issue #104): what the worker's journeys
// leave unproven — invalid definitions refused in the UI, the Apply / Discard /
// Cancel guard on a view switch, and a French profile that already holds the
// language pack shipped before the builder.

test.describe.configure({ timeout: 300_000 });

const VERTEX = readFileSync(
  resolve(import.meta.dirname, '../../../examples/shaders/hex-pulse/vertex.glsl'),
  'utf8',
);
const FRAGMENT =
  'precision highp float;\nvarying vec2 vUv;\nvoid main() {\n  gl_FragColor = vec4(vUv, 0.5, 1.0);\n}\n';

const SPEED = { key: 'speed', type: 'number', label: 'Speed', default: 1, min: 0, max: 4 };
const TINT = { key: 'tint', type: 'color', label: 'Tint', default: '#336699' };
const MODE = { key: 'mode', type: 'select', label: 'Mode', default: 0, options: { A: 0, B: 1 } };

async function preferences(page: Page, overrides: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript((extra) => {
    localStorage.setItem(
      'shader-studio.preferences',
      JSON.stringify({
        paused: true,
        browserOpen: true,
        guiVisible: true,
        fileExplorerOpen: false,
        editorOpen: false,
        ...extra,
      }),
    );
  }, overrides);
}

async function createShader(page: Page, name: string, controls: unknown[]): Promise<string> {
  const response = await page.request.post('/api/shaders', {
    data: { name, controls, fragment: FRAGMENT, vertex: VERTEX },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { shader: { id: string } }).shader.id;
}

async function open(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.locator('app-shader-browser .shader-row', { hasText: name }).click();
  await expect(page.locator('.doc-name')).toHaveText(name);
}

const shell = (page: Page) => page.locator('app-editor-shell');
const builder = (page: Page) => page.locator('app-controls-builder');
const field = (page: Page, label: string) => builder(page).getByLabel(label, { exact: true });
const apply = (page: Page) => builder(page).getByRole('button', { name: 'Apply', exact: true });

test('refuses invalid definitions in the form and guards a pending form on a view switch', async ({
  page,
}) => {
  await preferences(page, { editorOpen: true });
  const name = 'Review validate';
  const id = await createShader(page, name, [SPEED, TINT, MODE]);
  await open(page, name);
  await page.getByRole('button', { name: 'Edit controls', exact: true }).click();
  await expect(builder(page)).toBeVisible();
  await expect(shell(page).locator('.monaco-editor')).toHaveCount(1, { timeout: 30_000 });
  const before = await page.request.get(`/api/shaders/${id}`).then((r) => r.json());

  // A range that is empty: refused, with the field marked, nothing written.
  await builder(page).locator('.select[data-key="speed"]').click();
  await field(page, 'Minimum').fill('5');
  await apply(page).click();
  await expect(field(page, 'Minimum')).toHaveAttribute('aria-invalid', 'true');
  await expect(builder(page).locator('.notice.error')).toBeVisible();
  await expect(shell(page).locator('.dirty')).toHaveCount(0);
  await builder(page).getByRole('button', { name: 'Discard', exact: true }).click();

  // A colour that is not #rrggbb.
  await builder(page).locator('.select[data-key="tint"]').click();
  await field(page, 'Default').fill('teal');
  await apply(page).click();
  await expect(field(page, 'Default')).toHaveAttribute('aria-invalid', 'true');
  await expect(shell(page).locator('.dirty')).toHaveCount(0);
  await builder(page).getByRole('button', { name: 'Discard', exact: true }).click();

  // Two options with one label would collapse into one key of the map.
  await builder(page).locator('.select[data-key="mode"]').click();
  await builder(page).getByLabel('Option 2 label', { exact: true }).fill('A');
  await expect(builder(page)).toContainText('Option labels must be unique.');
  await apply(page).click();
  await expect(shell(page).locator('.dirty')).toHaveCount(0);

  // The pending form asks before the view changes: Cancel keeps it, Discard drops it.
  const json = page.getByRole('button', { name: 'JSON', exact: true });
  await json.click();
  await expect(builder(page).locator('.guard')).toBeVisible();
  await builder(page).locator('.guard').getByRole('button', { name: 'Cancel' }).click();
  await expect(builder(page)).toBeVisible();
  await expect(builder(page).getByLabel('Option 2 label', { exact: true })).toHaveValue('A');
  await json.click();
  await builder(page).getByRole('button', { name: 'Discard and continue' }).click();
  await expect(builder(page)).toBeHidden();
  await expect(shell(page).locator('.monaco-editor')).toBeVisible();

  // Apply and continue writes the form once and then switches.
  await page.getByRole('button', { name: 'Builder', exact: true }).click();
  await expect(builder(page).getByLabel('Option 2 label', { exact: true })).toHaveValue('B');
  await field(page, 'Label').fill('Mode two');
  await json.click();
  await builder(page).getByRole('button', { name: 'Apply and continue' }).click();
  await expect(builder(page)).toBeHidden();
  await expect(page.locator('app-gui-panel .lil-name', { hasText: /^Mode two$/ })).toHaveCount(1);

  const after = await page.request.get(`/api/shaders/${id}`).then((r) => r.json());
  expect(after.shader.controls).toEqual(before.shader.controls);
});

test('a French profile holding the pre-builder 1.0.1 pack is offered the builder translations', async ({
  page,
}) => {
  const FRENCH = 'dev.shadergrove.language-fr';
  // The 1.0.1 pack as shipped before the builder: this branch's 1.0.1 without its new keys.
  const current = JSON.parse(
    readFileSync(
      resolve(
        import.meta.dirname,
        '../../studio/src/plugins/dev.shadergrove.language-fr-1.0.1.sgplugin.json',
      ),
      'utf8',
    ),
  );
  const messages = current.manifest.contributions[0].messages as Record<string, string>;
  for (const key of Object.keys(messages)) {
    if (
      key.startsWith('builder.') ||
      key === 'inspector.editControls' ||
      key === 'inspector.noControls'
    ) {
      delete messages[key];
    }
  }
  const old = Buffer.from(JSON.stringify(current, null, 2));

  await preferences(page);
  await page.goto('/');
  await expect(page.locator('mat-toolbar.toolbar')).toBeVisible();
  await page.getByTestId('open-plugins').click();

  // Replace the seeded pack with the one an existing profile still holds.
  await page.getByTestId(`plugin-remove-${FRENCH}`).click();
  await expect(page.getByTestId(`plugin-${FRENCH}`)).toHaveCount(0);
  await page.getByTestId('plugin-file').setInputFiles({
    name: 'language-fr-pre-builder-1.0.1.sgplugin.json',
    mimeType: 'application/json',
    buffer: old,
  });
  await page.getByTestId('plugin-install').click();
  const toggle = page.getByTestId(`plugin-enable-${FRENCH}`).getByRole('switch');
  if (!(await toggle.isChecked())) await toggle.click();
  await page.getByTestId(`use-language-${FRENCH}/french`).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');

  // The builder's entry falls back to English in this profile today.
  await page.getByRole('link', { name: /retour.*[ée]diteur/i }).click();
  await expect(page.getByRole('button', { name: /^Edit controls$/ })).toBeVisible();

  // The catalogue must offer a newer immutable version carrying the French strings.
  await page.getByTestId('open-plugins').click();
  await expect(page.getByTestId(`available-${FRENCH}`)).toBeVisible();
  await expect(page.getByTestId(`install-available-${FRENCH}`)).toBeVisible({ timeout: 10_000 });
});
