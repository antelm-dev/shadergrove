/// <reference lib="dom" />

import { expect, test } from './fixtures';
import type { Locator } from '@playwright/test';

test.describe.configure({ timeout: 180_000 });

async function expectCenteredIcons(buttons: Locator): Promise<void> {
  const offsets = await buttons.evaluateAll((elements) =>
    elements.map((button) => {
      const box = button.getBoundingClientRect();
      const icon = button.querySelector('mat-icon')!.getBoundingClientRect();
      return {
        x: Math.abs((box.left + box.right - icon.left - icon.right) / 2),
        y: Math.abs((box.top + box.bottom - icon.top - icon.bottom) / 2),
      };
    }),
  );
  expect(offsets.length).toBeGreaterThan(0);
  for (const offset of offsets) {
    expect(offset.x).toBeLessThanOrEqual(1);
    expect(offset.y).toBeLessThanOrEqual(1);
  }
}

for (const side of ['left', 'right', 'bottom'] as const) {
  test(`editor controls stay readable when the ${side} dock is minimized`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.addInitScript((dockSide) => {
      localStorage.setItem(
        'shader-studio.preferences',
        JSON.stringify({
          // These tests exercise editor geometry. Continuous example rendering
          // can starve screenshot compositing on software-rendered CI runners.
          paused: true,
          browserOpen: false,
          guiVisible: false,
          editorOpen: true,
          fileExplorerOpen: false,
          editorWindow: { mode: 'docked', dockSide, dockedWidth: 340 },
        }),
      );
    }, side);
    await page.goto('/');
    const shell = page.locator('app-editor-shell');
    await expect(shell.locator('.monaco-editor')).toBeVisible();
    await expectCenteredIcons(page.locator('.quick-actions button'));
    await expectCenteredIcons(shell.locator('.config-toggle'));
    await shell.locator('.config-toggle').click();
    await expect(shell.locator('app-pass-config-panel')).toBeVisible();
    await expectCenteredIcons(shell.locator('.config-toggle'));
    const originalWidth = (await shell.boundingBox())!.width;
    await shell.locator('.monaco-editor').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\n// chrome regression');
    await expect(shell.locator('.dirty')).toContainText('Unsaved changes');
    await shell.getByRole('button', { name: 'Collapse the editor', exact: true }).click();
    await expect(shell.locator('.editor-body')).toBeHidden();
    await expect(shell).toHaveClass(new RegExp(`dock-${side}`));
    await expect(shell.locator('.config-toggle')).toHaveCount(0);
    await expect.poll(async () => (await shell.boundingBox())!.height).toBeLessThan(50);
    await expect.poll(async () => (await shell.boundingBox())!.width).toBeCloseTo(originalWidth, 0);
    await expectCenteredIcons(shell.locator('app-editor-window-controls button'));
    const status = (await shell.locator('.dirty').boundingBox())!;
    const controls = (await shell.locator('app-editor-window-controls').boundingBox())!;
    expect(status.x + status.width).toBeLessThanOrEqual(controls.x);
    // Capture the viewport coordinates asserted above. A fixed, minimized dock
    // does not need locator.screenshot()'s scroll-into-view step.
    await testInfo.attach('minimized-editor', {
      body: await page.screenshot({ clip: (await shell.boundingBox())!, timeout: 10_000 }),
      contentType: 'image/png',
    });
    await shell.getByRole('button', { name: 'Expand the editor', exact: true }).click();
    await expect(shell.locator('.monaco-editor')).toBeVisible();
    await expect(shell.locator('.view-lines')).toContainText('// chrome regression');
    await expect(shell.locator('app-pass-config-panel')).toBeVisible();
  });
}
