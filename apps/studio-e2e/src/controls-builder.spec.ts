// The `evaluate` callbacks below run in the page.
/// <reference lib="dom" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Locator, Page, TestInfo } from '@playwright/test';

import { expect, test } from './fixtures';

// The Config builder end to end: the way into it from the inspector, creating
// and managing controls of every type, the JSON beside it, and what keeps a
// stale form from writing over a document that moved on.

test.describe.configure({ timeout: 240_000 });

const VERTEX = readFileSync(
  resolve(import.meta.dirname, '../../../examples/shaders/hex-pulse/vertex.glsl'),
  'utf8',
);
const FRAGMENT =
  'precision highp float;\nvarying vec2 vUv;\nvoid main() {\n  gl_FragColor = vec4(vUv, 0.5, 1.0);\n}\n';

type Control = Record<string, unknown> & { key: string };

const FRENCH = 'plugin:dev.shadergrove.language-fr/french';
const SPEED: Control = { key: 'speed', type: 'number', label: 'Speed', default: 1, min: 0, max: 4 };
const GLOW: Control = { key: 'glow', type: 'boolean', label: 'Glow', default: false };
const TINT: Control = { key: 'tint', type: 'color', label: 'Tint', default: '#336699' };
/** What "Add number" produces: a second shader holding it has the same Config text as one that just added it. */
const NEW_NUMBER: Control = {
  key: 'value',
  type: 'number',
  default: 0.5,
  min: 0,
  max: 1,
  step: 0.01,
};

/**
 * Preferences that keep geometry stable: the preview paused, the library and
 * the explorer out of the way, the inspector in, the editor where a test wants it.
 */
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

interface Shader {
  id: string;
  name: string;
}

async function createShader(page: Page, name: string, controls: Control[]): Promise<Shader> {
  const response = await page.request.post('/api/shaders', {
    data: { name, controls, fragment: FRAGMENT, vertex: VERTEX },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return { id: ((await response.json()) as { shader: { id: string } }).shader.id, name };
}

async function savedControls(page: Page, id: string): Promise<Control[]> {
  const response = await page.request.get(`/api/shaders/${encodeURIComponent(id)}`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { shader: { controls: Control[] } }).shader.controls;
}

/**
 * Opens a shader the way a person does, from the library. A link straight to one
 * created after the page was rendered lands on the first shader instead: the
 * server-rendered page knows only the examples.
 */
async function open(page: Page, shader: Shader): Promise<void> {
  await page.goto('/');
  await page.locator('app-shader-browser .shader-row', { hasText: shader.name }).click();
  await expect(page.locator('.doc-name')).toHaveText(shader.name);
}

const shell = (page: Page) => page.locator('app-editor-shell');
const builder = (page: Page) => page.locator('app-controls-builder');
const editEntry = (page: Page) =>
  page.getByRole('button', { name: /^(Edit controls|Modifier les contrôles)$/ });
const apply = (page: Page) => builder(page).getByRole('button', { name: 'Apply', exact: true });
const field = (page: Page, label: string) => builder(page).getByLabel(label, { exact: true });

async function openBuilder(page: Page): Promise<void> {
  await editEntry(page).click();
  await expect(builder(page)).toBeVisible();
}

/**
 * Waits for Monaco behind the builder. Before it has loaded a builder edit goes
 * to the store and the editor starts from the result, so there is no history to
 * undo — a test of undo has to start after.
 */
async function monacoReady(page: Page): Promise<void> {
  await expect(shell(page).locator('.monaco-editor')).toHaveCount(1, { timeout: 30_000 });
}

/** The inspector knobs the controls produce, found by the label they show. */
function knob(page: Page, label: string): Locator {
  return page.locator('app-gui-panel .lil-controller', {
    has: page.locator('.lil-name', { hasText: new RegExp(`^${label}$`) }),
  });
}

/** How many of the named controls the inspector currently shows. */
function knobCount(page: Page, labels: string[]): Locator {
  return page.locator('app-gui-panel .lil-name', {
    hasText: new RegExp(`^(${labels.join('|')})$`),
  });
}

async function setKnob(page: Page, label: string, value: string): Promise<void> {
  const input = knob(page, label).locator('input');
  await input.fill(value);
  await input.press('Enter');
}

async function save(page: Page): Promise<void> {
  await page.keyboard.press('Control+s');
  await expect(shell(page).locator('.dirty')).toHaveCount(0, { timeout: 30_000 });
}

async function shot(page: Page, testInfo: TestInfo, name: string, target?: Locator) {
  const path = testInfo.outputPath(`${name}.png`);
  await (target ?? page).screenshot({ path });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

/** Nothing the builder offers is cut off by its edges. */
async function expectNoClipping(page: Page): Promise<void> {
  const problems = await builder(page).evaluate((host) => {
    const box = host.getBoundingClientRect();
    const found: string[] = [];
    if (host.scrollWidth > host.clientWidth + 1) found.push('horizontal overflow');
    for (const element of host.querySelectorAll('button, input, [role="combobox"], textarea')) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.left < box.left - 1 || rect.right > box.right + 1) {
        found.push(`${element.className || element.tagName} is clipped`);
      }
    }
    return found;
  });
  expect(problems).toEqual([]);
}

test('creates every control type from an empty Config, previews values, saves and reloads', async ({
  page,
}, testInfo) => {
  await preferences(page);
  const shader = await createShader(page, 'Builder create', []);
  await open(page, shader);

  // The editor is closed and the shader has nothing to tune: the entry still works.
  await expect(shell(page).locator('.monaco-editor')).toHaveCount(0);
  await expect(editEntry(page)).toBeVisible();
  await openBuilder(page);
  await expect(builder(page)).toContainText('No controls yet');
  await expect(shell(page)).toHaveCount(1);

  for (const type of ['number', 'boolean', 'color', 'select']) {
    await builder(page).locator(`[data-add="${type}"]`).click();
    await expect(builder(page).locator('.form')).toBeVisible();
  }
  await expect(builder(page).locator('.select')).toHaveCount(4);
  // Widgets appear in the inspector at once: no save, no reload.
  await expect(knobCount(page, ['value', 'enabled', 'tint', 'mode'])).toHaveCount(4);

  // Define the number: label, range, default.
  await builder(page).locator('.select[data-key="value"]').click();
  await field(page, 'Label').fill('Intensity');
  await field(page, 'Maximum').fill('10');
  await field(page, 'Default').fill('4');
  await expect(builder(page).locator('.badge')).toBeVisible();
  await apply(page).click();
  await expect(builder(page).locator('.badge')).toHaveCount(0);
  await expect(knob(page, 'Intensity')).toBeVisible();

  // Trying a value moves the knob, never the schema's default.
  await setKnob(page, 'Intensity', '7');
  await expect(knob(page, 'Intensity').locator('input')).toHaveValue('7');

  await shot(page, testInfo, 'wide-builder');
  await save(page);

  const saved = await savedControls(page, shader.id);
  expect(saved.map((control) => control['type'])).toEqual(['number', 'boolean', 'color', 'select']);
  expect(saved[0]).toMatchObject({ key: 'value', label: 'Intensity', max: 10, default: 4 });

  await open(page, shader);
  await expect(knob(page, 'Intensity')).toBeVisible();
  await expect(knobCount(page, ['Intensity', 'enabled', 'tint', 'mode'])).toHaveCount(4);
  // A reload starts from the saved default, not from the value tried.
  await expect(knob(page, 'Intensity').locator('input')).toHaveValue('4');
});

test('edits, duplicates, regroups, reorders and deletes controls', async ({ page }) => {
  await preferences(page);
  const shader = await createShader(page, 'Builder manage', [SPEED, GLOW, TINT]);
  await open(page, shader);
  await openBuilder(page);

  // The live value is above what the new range allows: it is clamped, not lost.
  await setKnob(page, 'Speed', '3.5');
  await builder(page).locator('.select[data-key="speed"]').click();
  await field(page, 'Label').fill('Pace');
  await field(page, 'Maximum').fill('2');
  await field(page, 'Default').fill('1.5');
  await apply(page).click();
  await expect(knob(page, 'Pace').locator('input')).toHaveValue('2');

  // Duplicate: a fresh key, an independent copy.
  await builder(page).getByRole('button', { name: 'Duplicate' }).click();
  await expect(builder(page).locator('.select[data-key="speed2"]')).toBeVisible();

  // Regroup the copy through its folder field.
  await field(page, 'Folder').fill('Motion');
  await apply(page).click();
  await expect(builder(page).locator('.group-title')).toHaveText(['Parameters', 'Motion']);

  // Reorder within the Parameters group.
  await builder(page).getByRole('button', { name: 'Move Tint up' }).click();
  await expect(builder(page).locator('.group').first().locator('.select .name')).toHaveText([
    'Pace',
    'Tint',
    'Glow',
  ]);

  // Delete asks first.
  await builder(page).locator('.select[data-key="speed2"]').click();
  await builder(page).getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(builder(page).locator('.select[data-key="speed2"]')).toBeVisible();
  await builder(page).getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(builder(page).locator('.select[data-key="speed2"]')).toHaveCount(0);

  await save(page);
  const saved = await savedControls(page, shader.id);
  expect(saved.map((control) => control.key)).toEqual(['speed', 'tint', 'glow']);
  expect(saved[0]).toMatchObject({ label: 'Pace', max: 2, default: 1.5 });
});

test('Builder and JSON share one buffer: undo, redo, invalid JSON, repair, navigation', async ({
  page,
}) => {
  await preferences(page, { bottomPanelOpen: true, bottomPanelTab: 'problems' });
  const shader = await createShader(page, 'Builder json', [SPEED]);
  await open(page, shader);
  await openBuilder(page);
  await monacoReady(page);

  const json = page.getByRole('button', { name: 'JSON', exact: true });
  const view = page.getByRole('button', { name: 'Builder', exact: true });
  const lines = shell(page).locator('.view-lines');

  await builder(page).locator('[data-add="boolean"]').click();
  await expect(knobCount(page, ['Speed', 'enabled'])).toHaveCount(2);

  // Toggling the view loses nothing: the Builder's edit is in the JSON, on its undo stack.
  await json.click();
  await expect(shell(page).locator('.monaco-editor')).toBeVisible();
  await expect(lines).toContainText('"enabled"');
  await view.click();
  await expect(builder(page)).toBeVisible();
  await json.click();

  await shell(page).locator('.monaco-editor').click();
  await page.keyboard.press('Control+z');
  await expect(lines).not.toContainText('"enabled"');
  await expect(knobCount(page, ['Speed', 'enabled'])).toHaveCount(1);
  await page.keyboard.press('Control+y');
  await expect(lines).toContainText('"enabled"');
  await expect(knobCount(page, ['Speed', 'enabled'])).toHaveCount(2);

  // A JSON edit shows up in the Builder.
  await page.keyboard.press('Control+End');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type(',{"key":"typed","type":"boolean","default":true}');
  await expect(knobCount(page, ['Speed', 'enabled', 'typed'])).toHaveCount(3);
  await view.click();
  await expect(builder(page).locator('.select[data-key="typed"]')).toBeVisible();

  // Invalid JSON is kept as it is, and the Builder will not write over it.
  await json.click();
  await shell(page).locator('.monaco-editor').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('x');
  await view.click();
  await expect(builder(page).locator('.repair')).toBeVisible();
  await expect(builder(page).locator('[data-add]')).toHaveCount(0);
  await expect(builder(page).locator('.select')).toHaveCount(0);

  // A Config problem in the Problems panel leads to the JSON.
  await page
    .locator('app-problems-panel .row', { hasText: /config/i })
    .first()
    .click();
  await expect(shell(page).locator('.monaco-editor')).toBeVisible();
  await expect(builder(page)).toBeHidden();

  // Repair it there, and the Builder takes over again.
  await shell(page).locator('.monaco-editor').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Backspace');
  await expect(page.locator('app-problems-panel .row', { hasText: /config/i })).toHaveCount(0);
  await view.click();
  await expect(builder(page).locator('.select')).toHaveCount(3);
});

test('a stale form cannot overwrite a changed Config or another shader', async ({ page }) => {
  await preferences(page, { editorOpen: true });
  const a = await createShader(page, 'Builder stale A', [SPEED]);
  const b = await createShader(page, 'Builder stale B', [GLOW]);
  await open(page, a);
  await openBuilder(page);

  // A change made elsewhere (here: reverting the draft) replaces the Config under a half-edited form.
  await builder(page).locator('[data-add="color"]').click();
  await builder(page).locator('.select[data-key="speed"]').click();
  await field(page, 'Label').fill('Pending');
  await expect(builder(page).locator('.badge')).toBeVisible();
  await shell(page).locator('.editor-toolbar').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Revert' }).click();
  // Reverting reopens the shader on its Image: go back to the Config, where the form is waiting.
  await page.getByRole('tab', { name: /Config/ }).click();
  await expect(builder(page).locator('.stale')).toBeVisible();
  await apply(page).click();
  await expect(builder(page).locator('.notice.error')).toContainText('changed elsewhere');
  await expect(field(page, 'Label')).toHaveValue('Speed');
  expect(await savedControls(page, a.id)).toEqual([expect.objectContaining({ key: 'speed' })]);
  await expect(knobCount(page, ['Pending'])).toHaveCount(0);

  // Another shader replaces the document: the half-edited form is dropped, written nowhere.
  await field(page, 'Label').fill('Unapplied');
  await expect(builder(page).locator('.badge')).toBeVisible();
  await page.locator('app-shader-browser .shader-row', { hasText: b.name }).click();
  await expect(page.locator('.doc-name')).toHaveText(b.name);
  await openBuilder(page);
  await expect(builder(page).locator('.form')).toHaveCount(0);
  await expect(builder(page).locator('.badge')).toHaveCount(0);
  await expect(builder(page).locator('.select')).toHaveText([/Glow/]);
  expect(await savedControls(page, a.id)).toEqual([expect.objectContaining({ key: 'speed' })]);
  expect(await savedControls(page, b.id)).toEqual([expect.objectContaining({ key: 'glow' })]);
});

test('undo history does not leak from one shader to the next', async ({ page }) => {
  await preferences(page, { editorOpen: true });
  const c = await createShader(page, 'Builder history C', []);
  // Opened, this one holds exactly the text that "Add number" writes into C.
  const d = await createShader(page, 'Builder history D', [NEW_NUMBER]);
  await open(page, c);
  await openBuilder(page);
  await monacoReady(page);

  await builder(page).locator('[data-add="number"]').click();
  await expect(knobCount(page, ['value'])).toHaveCount(1);
  // Saved, so that leaving it asks nothing; its undo history is still in the editor.
  await save(page);

  await page.locator('app-shader-browser .shader-row', { hasText: d.name }).click();
  await expect(page.locator('.doc-name')).toHaveText(d.name);
  await openBuilder(page);
  await page.getByRole('button', { name: 'JSON', exact: true }).click();
  await expect(shell(page).locator('.view-lines')).toContainText('"value"');

  await shell(page).locator('.monaco-editor').click();
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expect(shell(page).locator('.view-lines')).toContainText('"value"');
  await expect(knobCount(page, ['value'])).toHaveCount(1);
  await expect(shell(page).locator('.dirty')).toHaveCount(0);
  expect(await savedControls(page, d.id)).toEqual([expect.objectContaining({ key: 'value' })]);
});

test('is reachable and usable from a closed, minimized or floating editor and a 340px dock', async ({
  page,
}, testInfo) => {
  const dock = { mode: 'docked', dockSide: 'right', dockedWidth: 340 };
  await preferences(page, { editorOpen: false, editorWindow: dock });
  const shader = await createShader(page, 'Builder narrow', [SPEED, GLOW]);
  await open(page, shader);

  await openBuilder(page);
  expect((await shell(page).boundingBox())!.width).toBeLessThanOrEqual(345);
  await expect(shell(page)).toHaveCount(1);

  // The list: a narrow dock shows it alone.
  await expect(builder(page).locator('.list-pane')).toBeVisible();
  await expect(builder(page).locator('.form-pane')).toBeHidden();
  await expectNoClipping(page);
  await shot(page, testInfo, 'narrow-list', shell(page));

  // Select with the keyboard.
  await builder(page).locator('.select[data-key="speed"]').focus();
  await page.keyboard.press('Enter');
  await expect(builder(page).locator('.form-pane')).toBeVisible();
  await expect(builder(page).locator('.list-pane')).toBeHidden();
  await expectNoClipping(page);
  await shot(page, testInfo, 'narrow-form', shell(page));

  // Edit and apply with the keyboard.
  await field(page, 'Label').focus();
  await page.keyboard.type(' x');
  await page.keyboard.press('Enter');
  await expect(knob(page, 'Speed x')).toBeVisible();

  // Back to the list, focus on the control just left.
  await builder(page).getByRole('button', { name: 'Back to the list' }).focus();
  await page.keyboard.press('Enter');
  await expect(builder(page).locator('.select[data-key="speed"]')).toBeFocused();

  // Add one: the form opens with the label ready to type in.
  await builder(page).locator('[data-add="boolean"]').focus();
  await page.keyboard.press('Enter');
  await expect(field(page, 'Label')).toBeFocused();
  await builder(page).getByRole('button', { name: 'Back to the list' }).focus();
  await page.keyboard.press('Enter');
  // The list is shown once the builder has rendered; until then its buttons
  // cannot take focus, and the Enter below would go to Back again.
  await expect(builder(page).locator('.select[data-key="enabled"]')).toBeFocused();

  // Move it with the keyboard; the focus stays on a move action.
  await builder(page).locator('[data-move="enabled:up"]').focus();
  await page.keyboard.press('Enter');
  await expect(builder(page).locator('.select')).toHaveText([/Speed/, /enabled/, /Glow/]);
  await expect(builder(page).locator('[data-move="enabled:up"]')).toBeFocused();

  // The mode switch is a pair of buttons in the tab order.
  await page.getByRole('button', { name: 'JSON', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(shell(page).locator('.monaco-editor')).toBeVisible();
  await page.getByRole('button', { name: 'Builder', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(builder(page)).toBeVisible();

  // Minimized: the entry restores it.
  await shell(page).getByRole('button', { name: 'Collapse the editor', exact: true }).click();
  await expect(shell(page).locator('.editor-body')).toBeHidden();
  await editEntry(page).click();
  await expect(builder(page)).toBeVisible();

  // Closed again, then on another document.
  await shell(page).getByRole('button', { name: 'Close the editor', exact: true }).click();
  await expect(shell(page)).toHaveCount(0);
  await editEntry(page).click();
  await expect(builder(page)).toBeVisible();
  await page.getByRole('tab', { name: /Image/ }).click();
  await expect(builder(page)).toBeHidden();
  await editEntry(page).click();
  await expect(builder(page)).toBeVisible();
  await expect(shell(page)).toHaveCount(1);
});

test('opens from a floating editor', async ({ page }) => {
  await preferences(page, {
    editorOpen: true,
    editorWindow: {
      mode: 'floating',
      restoreMode: 'floating',
      floating: { x: 48, y: 48, width: 700, height: 420 },
    },
  });
  const shader = await createShader(page, 'Builder floating', []);
  await open(page, shader);

  await shell(page).getByRole('button', { name: 'Collapse the editor', exact: true }).click();
  await editEntry(page).click();
  await expect(builder(page)).toBeVisible();
  await expect(builder(page)).toContainText('No controls yet');
  await expectNoClipping(page);
});

test('speaks French and fits a 340px dock', async ({ page }, testInfo) => {
  await preferences(page, {
    languagePackId: FRENCH,
    editorOpen: false,
    editorWindow: { mode: 'docked', dockSide: 'right', dockedWidth: 340 },
  });
  const shader = await createShader(page, 'Builder francais', [SPEED]);
  await open(page, shader);

  await expect(editEntry(page)).toHaveText(/Modifier les contrôles/);
  await openBuilder(page);
  await expect(builder(page).getByRole('group', { name: 'Ajouter un contrôle' })).toBeVisible();
  await expectNoClipping(page);
  await shot(page, testInfo, 'french-list', shell(page));

  await builder(page).locator('.select[data-key="speed"]').click();
  await expect(field(page, 'Libellé')).toBeVisible();
  await expect(field(page, 'Valeur par défaut')).toBeVisible();
  await expect(builder(page).getByRole('button', { name: 'Dupliquer' })).toBeVisible();
  await field(page, 'Libellé').fill('Allure');
  await expect(builder(page).locator('.badge')).toHaveText('Modifications non appliquées');
  await expectNoClipping(page);
  await shot(page, testInfo, 'french-form', shell(page));
  await builder(page).getByRole('button', { name: 'Appliquer', exact: true }).click();
  await expect(knob(page, 'Allure')).toBeVisible();
});
