/// <reference lib="dom" />

import type { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures';

// Contained split editors (multi-editor windows, task 03): split right and
// down, resize, close/merge, shader switching, reload and the compact layout.

test.describe.configure({ timeout: 180_000 });

const PREFS = 'shader-studio.preferences';

async function openStudio(page: Page, width = 1600): Promise<Locator> {
  await page.setViewportSize({ width, height: 1000 });
  // Seeded once per context, so a reload keeps what the app saved since.
  await page.addInitScript((key) => {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(
      key,
      JSON.stringify({
        paused: true,
        browserOpen: true,
        guiVisible: false,
        editorOpen: true,
        fileExplorerOpen: true,
        editorWindow: { mode: 'docked', dockSide: 'bottom', dockedHeight: 560 },
      }),
    );
  }, PREFS);
  await page.goto('/');
  const shell = page.locator('app-editor-shell');
  await expect(shell.locator('.monaco-editor')).toBeVisible();
  return shell;
}

const groups = (shell: Locator) => shell.locator('[role="region"][data-editor-group]');
const splitter = (shell: Locator) =>
  shell.getByRole('separator', { name: /Resize the editor groups/ });

async function split(page: Page, from: Locator, item: 'Split right' | 'Split down') {
  await from.getByRole('button', { name: 'Editor window menu' }).first().click();
  await page.getByRole('menuitem', { name: item }).click();
}

/** The document a group shows: its one selected tab. */
async function selectedDoc(group: Locator): Promise<string> {
  const selected = group.locator('app-editor-tabs [role="tab"][aria-selected="true"]');
  await expect(selected).toHaveCount(1);
  return (await selected.getAttribute('data-doc-id'))!;
}

async function tabIds(group: Locator): Promise<string[]> {
  return group
    .locator('app-editor-tabs [role="tab"]')
    .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute('data-doc-id')!));
}

async function typeInto(page: Page, group: Locator, text: string): Promise<void> {
  await group.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text);
  await expect(group.locator('.monaco-editor .view-lines')).toContainText(text.trim());
}

async function storedTree(page: Page) {
  return page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? '{}').surfacesLayout?.editorLayout,
    PREFS,
  );
}

async function expectDisjoint(shell: Locator): Promise<void> {
  const all: string[] = [];
  for (const group of await groups(shell).all()) all.push(...(await tabIds(group)));
  expect(new Set(all).size, `duplicate ownership in ${all.join(', ')}`).toBe(all.length);
}

test('split right, edit both groups, resize, and reload', async ({ page }) => {
  const shell = await openStudio(page);
  const lone = await selectedDoc(shell);
  await expect(groups(shell)).toHaveCount(0);

  await split(page, shell, 'Split right');
  await expect(groups(shell)).toHaveCount(2);
  const [left, right] = [groups(shell).nth(0), groups(shell).nth(1)];
  await expect(left).toHaveAttribute('aria-label', 'Source editor 1');
  await expect(right).toHaveAttribute('aria-label', 'Source editor 2');
  // The active tab moved into the new group, which has focus.
  expect(await selectedDoc(right)).toBe(lone);
  expect(await selectedDoc(left)).not.toBe(lone);
  await expect(right.locator('.monaco-editor')).toBeVisible();
  await expect.poll(() => right.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await expectDisjoint(shell);

  await typeInto(page, right, '\n// right group edit');
  await typeInto(page, left, '\n// left group edit');

  // Pointer resize: previews while moving, persists once on release.
  const bar = splitter(shell);
  await expect(bar).toHaveAttribute('aria-valuenow', '50');
  const box = (await bar.boundingBox())!;
  const shellBox = (await shell.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(box.x + box.width / 2 + step * 25, box.y + box.height / 2);
  }
  await expect(bar).not.toHaveAttribute('aria-valuenow', '50');
  expect((await storedTree(page))?.ratio).toBe(0.5);
  await page.mouse.up();
  const expected = Math.round(((shellBox.width / 2 + 200) / shellBox.width) * 100);
  await expect
    .poll(async () => Math.round(((await storedTree(page))?.ratio ?? 0) * 100))
    .toBeGreaterThanOrEqual(expected - 2);

  // Keyboard resize: one step left.
  await bar.focus();
  const before = Number(await bar.getAttribute('aria-valuenow'));
  await page.keyboard.press('ArrowLeft');
  await expect(bar).toHaveAttribute('aria-valuenow', String(before - 5));
  const ratio = (await storedTree(page))?.ratio;
  await page.screenshot({ path: 'test-results/editor-splits-right.png' });

  await page.reload();
  await expect(groups(shell)).toHaveCount(2);
  await expect(splitter(shell)).toHaveAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  for (const group of await groups(shell).all()) {
    await expect(group.locator('.monaco-editor')).toBeVisible();
    await selectedDoc(group);
  }
  await expectDisjoint(shell);
});

test('split down and switch shaders without duplicate ownership', async ({ page }) => {
  const shell = await openStudio(page);
  await split(page, shell, 'Split down');
  await expect(groups(shell)).toHaveCount(2);
  await expect(splitter(shell)).toHaveAttribute('aria-orientation', 'horizontal');
  const original = [await tabIds(groups(shell).nth(0)), await tabIds(groups(shell).nth(1))];
  const firstShader = page.url();

  for (const name of ['Hex Pulse', 'Warp Tunnel']) {
    await page.locator('app-shader-browser .shader-row', { hasText: name }).click();
    await expect(page).not.toHaveURL(firstShader);
    await expect(groups(shell)).toHaveCount(2);
    for (const group of await groups(shell).all()) {
      await expect(group.locator('.monaco-editor')).toBeVisible();
      await expect(group.locator('.editor-main .empty')).toHaveCount(0);
      await selectedDoc(group);
    }
    await expectDisjoint(shell);
  }
  await page.screenshot({ path: 'test-results/editor-splits-down.png' });

  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(firstShader);
  await expect.poll(() => tabIds(groups(shell).nth(0))).toEqual(original[0]);
  await expect.poll(() => tabIds(groups(shell).nth(1))).toEqual(original[1]);
});

test('merge a dirty group and reject closing the final group', async ({ page }) => {
  const shell = await openStudio(page);
  await split(page, shell, 'Split right');
  await expect(groups(shell)).toHaveCount(2);
  const right = groups(shell).nth(1);
  const moved = await selectedDoc(right);
  const leftTabs = await tabIds(groups(shell).nth(0));
  await typeInto(page, right, '\n// dirty before merge');
  await expect(shell.locator('.dirty').first()).toBeVisible();

  await right.getByRole('button', { name: 'Close this editor group' }).click();
  await expect(groups(shell)).toHaveCount(0);

  // Merged: the left group's tabs first, then the closed group's, edits intact.
  expect(await tabIds(shell)).toEqual([...leftTabs, moved]);
  await shell.locator(`app-editor-tabs [role="tab"][data-doc-id="${moved}"]`).click();
  await expect(shell.locator('.monaco-editor .view-lines')).toContainText('// dirty before merge');

  // One group left: the close control hides the editor, it never closes the group.
  await expect(shell.getByRole('button', { name: 'Close this editor group' })).toHaveCount(0);
  await expect(shell.getByRole('button', { name: 'Close the editor' })).toBeVisible();

  // Closing the first (primary) group merges it into its neighbour too.
  await split(page, shell, 'Split right');
  await expect(groups(shell)).toHaveCount(2);
  const rightTabs = await tabIds(groups(shell).nth(1));
  const primaryTabs = await tabIds(groups(shell).nth(0));
  await groups(shell).nth(0).getByRole('button', { name: 'Close this editor group' }).click();
  await expect(groups(shell)).toHaveCount(0);
  expect(await tabIds(shell)).toEqual([...rightTabs, ...primaryTabs]);
  await page.screenshot({ path: 'test-results/editor-splits-merged.png' });
});

test('verify responsive and keyboard behavior around the compact breakpoint', async ({ page }) => {
  const shell = await openStudio(page);
  await split(page, shell, 'Split right');
  const bar = splitter(shell);
  await expect(bar).toBeVisible();
  await bar.focus();
  await page.keyboard.press('ArrowRight');
  await expect(bar).toHaveAttribute('aria-valuenow', '55');

  // Compact: one column, no splitter, every group's controls reachable, no sideways overflow.
  await page.setViewportSize({ width: 680, height: 900 });
  const host = shell.locator('app-editor-split-host');
  await expect(host).toHaveClass(/stacked/);
  await expect(splitter(shell)).toHaveCount(0);
  for (const group of await groups(shell).all()) {
    const menu = group.getByRole('button', { name: 'Editor window menu' });
    await menu.scrollIntoViewIfNeeded();
    await expect(menu).toBeInViewport();
  }
  expect(await host.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const [first, second] = [
    (await groups(shell).nth(0).boundingBox())!,
    (await groups(shell).nth(1).boundingBox())!,
  ];
  expect(second.y).toBeGreaterThanOrEqual(first.y + first.height - 1);
  await page.screenshot({ path: 'test-results/editor-splits-compact.png' });

  // Wide again: the stored ratio comes back untouched.
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect(splitter(shell)).toHaveAttribute('aria-valuenow', '55');
  for (const group of await groups(shell).all()) {
    await expect(group.locator('.monaco-editor')).toBeVisible();
    const box = (await group.locator('.monaco-editor').boundingBox())!;
    expect(box.width).toBeGreaterThan(200);
  }

  // Docked to the side, the groups stay side by side while both keep their minimum…
  await groups(shell).nth(0).getByRole('button', { name: 'Editor window menu' }).click();
  await page.getByRole('menuitem', { name: 'Dock to right' }).click();
  await expect(shell).toHaveClass(/dock-right/);
  // …and stack once the frame is too narrow for two (a right dock shrinks with ArrowRight).
  await shell.getByRole('separator', { name: /Resize the editor panel/ }).focus();
  for (let step = 0; step < 20; step += 1) await page.keyboard.press('Shift+ArrowRight');
  await expect(host).toHaveClass(/stacked/);
  await expect(splitter(shell)).toHaveCount(0);
  const frame = (await shell.boundingBox())!;
  for (const group of await groups(shell).all()) {
    const close = group.getByRole('button', { name: 'Close this editor group' });
    await close.scrollIntoViewIfNeeded();
    const box = (await close.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width + 1);
  }
  await page.screenshot({ path: 'test-results/editor-splits-dock-right.png' });
});
