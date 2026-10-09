/// <reference lib="dom" />

import type { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures';

// Review round 1 of the contained splits (task 03): gestures the main spec does
// not drive — a splitter dragged past its end, a splitter dragged against a
// nested split, and the first group's only tab moved away.

test.describe.configure({ timeout: 180_000 });

const PREFS = 'shader-studio.preferences';

async function openStudio(page: Page, width = 1600): Promise<Locator> {
  await page.setViewportSize({ width, height: 1000 });
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
const splitters = (shell: Locator) =>
  shell.getByRole('separator', { name: /Resize the editor groups/ });
const host = (shell: Locator) => shell.locator('app-editor-split-host');

async function split(page: Page, from: Locator, item: 'Split right' | 'Split down') {
  await from.getByRole('button', { name: 'Editor window menu' }).first().click();
  await page.getByRole('menuitem', { name: item }).click();
}

async function storedTree(page: Page) {
  return page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? '{}').surfacesLayout?.editorLayout,
    PREFS,
  );
}

/** Drag a splitter's centre to an absolute x and release there. */
async function dragTo(page: Page, bar: Locator, x: number): Promise<void> {
  const box = (await bar.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  for (let step = 1; step <= 6; step += 1) {
    await page.mouse.move(box.x + box.width / 2 + ((x - box.x - box.width / 2) * step) / 6, y);
  }
  await page.mouse.up();
}

test('a splitter dragged past its end keeps the split and commits the clamped ratio', async ({
  page,
}) => {
  const shell = await openStudio(page);
  await split(page, shell, 'Split right');
  await expect(groups(shell)).toHaveCount(2);
  const bar = splitters(shell);
  await expect(bar).toHaveAttribute('aria-valuenow', '50');

  // Look for a frame width where the clamped end ratio does not multiply back
  // to the 220px minimum exactly (floating point); fall back to the last width.
  // The frame tracks the viewport minus fixed chrome, so the width is found arithmetically
  // and the viewport resized once: a resize per candidate re-lays out the whole studio and
  // ran past the test timeout on CI.
  let frame = (await host(shell).boundingBox())!;
  const chrome = 1600 - frame.width;
  for (let width = 1600; width < 1700; width += 1) {
    const size = width - chrome;
    const ratio = Math.min(0.8, 1 - 220 / size);
    if (size * (1 - ratio) < 220 || width === 1699) {
      await page.setViewportSize({ width, height: 1000 });
      frame = (await host(shell).boundingBox())!;
      break;
    }
  }

  await dragTo(page, bar, frame.x + frame.width + 40);

  await expect(host(shell)).not.toHaveClass(/stacked/);
  await expect(bar).toBeVisible();
  const stored = Number(((await storedTree(page))?.ratio ?? 0).toFixed(3));
  expect(stored).toBeGreaterThan(0.5);
  expect(stored).toBeLessThanOrEqual(0.8);
  await expect(bar).toHaveAttribute('aria-valuenow', String(Math.round(stored * 100)));
});

test('a splitter dragged against a nested split keeps both splits on screen', async ({ page }) => {
  const shell = await openStudio(page);
  await split(page, shell, 'Split right');
  await expect(groups(shell)).toHaveCount(2);
  await split(page, groups(shell).nth(1), 'Split right');
  await expect(groups(shell)).toHaveCount(3);
  await expect(splitters(shell)).toHaveCount(2);

  const root = (await storedTree(page)).id as string;
  const outer = shell.locator(`[data-split-id="${root}"]`);
  const frame = (await host(shell).boundingBox())!;
  // Leaves the right side 300px: room for one group, not for its nested two.
  await dragTo(page, outer, frame.x + frame.width - 300);

  await expect(host(shell)).not.toHaveClass(/stacked/);
  await expect(splitters(shell)).toHaveCount(2);
  for (const group of await groups(shell).all()) {
    await expect(group.locator('.monaco-editor')).toBeVisible();
  }
  expect((await storedTree(page)).ratio).not.toBe(0.5);
});

test('moving the first group only tab to another group leaves no blank group', async ({ page }) => {
  const shell = await openStudio(page);
  await split(page, shell, 'Split right');
  await expect(groups(shell)).toHaveCount(2);
  const first = groups(shell).nth(0);
  const tabs = first.locator('app-editor-tabs [role="tab"]');
  await expect(tabs).toHaveCount(1);

  await tabs.first().click({ button: 'right' });
  // The header's own context menu opens over the tab menu, so click the item directly.
  await page
    .getByRole('menuitem', { name: 'Move to Source editor 2' })
    .evaluate((item) => (item as HTMLElement).click());
  await page.keyboard.press('Escape');
  await expect(page.locator('.cdk-overlay-pane .mat-mdc-menu-panel')).toHaveCount(0);

  for (const group of await groups(shell).all()) {
    await expect(group.locator('.editor-main .empty')).toHaveCount(0);
    await expect(group.locator('app-editor-tabs [role="tab"][aria-selected="true"]')).toHaveCount(
      1,
    );
  }
});
