/// <reference lib="dom" />

import type { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures';

// The single default editor must keep showing the document the user picked —
// at startup, from a tab, from the explorer, across a shader switch and on a
// deep link — while its panel resolves that document through its editor group
// instead of the store's global pick (multi-editor windows, task 02).

test.describe.configure({ timeout: 180_000 });

async function openStudio(page: Page, path = '/'): Promise<Locator> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => {
    localStorage.setItem(
      'shader-studio.preferences',
      JSON.stringify({
        paused: true,
        browserOpen: true,
        guiVisible: false,
        editorOpen: true,
        fileExplorerOpen: true,
        editorWindow: { mode: 'docked', dockSide: 'right', dockedWidth: 760 },
      }),
    );
  });
  await page.goto(path);
  const shell = page.locator('app-editor-shell');
  await expectShowing(shell);
  return shell;
}

/** The editor is mounted, not on its empty state, and its tab strip has one selected tab. */
async function expectShowing(shell: Locator, docId?: string): Promise<void> {
  await expect(shell.locator('.monaco-editor')).toBeVisible();
  await expect(shell.locator('.editor-main .empty')).toHaveCount(0);
  const selected = shell.locator('app-editor-tabs [role="tab"][aria-selected="true"]');
  await expect(selected).toHaveCount(1);
  if (docId) await expect(selected).toHaveAttribute('data-doc-id', docId);
}

/** The Config opens in the controls builder; these checks are about the JSON editor. */
async function openConfigJson(shell: Locator): Promise<void> {
  await explorerRow(shell, '@config').click();
  await shell.locator('.view-json').click();
}

function explorerRow(shell: Locator, docId: string): Locator {
  return shell.locator(`[role="treeitem"][data-node-id="${docId}"]`);
}

test('the default editor follows startup, tab, explorer, shader switch and deep link selection', async ({
  page,
}) => {
  const response = await page.request.get('/api/shaders');
  expect(response.ok()).toBe(true);
  const { shaders } = (await response.json()) as { shaders: { id: string; name: string }[] };
  const idOf = (name: string) => shaders.find((shader) => shader.name === name)!.id;

  const shell = await openStudio(page);
  await expect(shell).toHaveAttribute('aria-label', 'Source editor');

  // Explorer → a document with no tab yet opens it in the default group.
  await openConfigJson(shell);
  await expectShowing(shell, '@config');
  await expect(shell.locator('[data-mode-id]')).toHaveAttribute('data-mode-id', /^json/);

  // Tab → back to the first document.
  const firstTab = shell.locator('app-editor-tabs [role="tab"]').first();
  const firstId = (await firstTab.getAttribute('data-doc-id'))!;
  await firstTab.click();
  await expectShowing(shell, firstId);

  // Shader switch from the library.
  await page.locator('app-shader-browser .shader-row', { hasText: 'Hex Pulse' }).click();
  await expect(page).toHaveURL(`/shaders/${encodeURIComponent(idOf('Hex Pulse'))}`);
  await expectShowing(shell);

  // Deep link straight to a shader, cold.
  await page.goto(`/shaders/${encodeURIComponent(idOf('Warp Tunnel'))}`);
  await expectShowing(page.locator('app-editor-shell'));
});

// The tab menu's "Move to new group" used to move a document into a group no
// shell rendered (task 02 kept it reachable in the lone editor). With contained
// splits it opens a visible group beside the first, and the moved document stays
// reachable there from the tab strip and the explorer.
test('a document moved to a new group opens in a visible split and stays reachable', async ({
  page,
}) => {
  const shell = await openStudio(page);

  await openConfigJson(shell);
  await expectShowing(shell, '@config');

  await shell.locator('app-editor-tabs [role="tab"][data-doc-id="@config"]').click({
    button: 'right',
  });
  // The header's own context menu opens over the tab menu, so click the item directly.
  await page
    .getByRole('menuitem', { name: 'Move to new group' })
    .evaluate((item) => (item as HTMLElement).click());
  await page.keyboard.press('Escape');
  await expect(page.locator('.cdk-overlay-pane .mat-mdc-menu-panel')).toHaveCount(0);

  const groups = shell.locator('[role="region"][data-editor-group]');
  await expect(groups).toHaveCount(2);
  const moved = groups.nth(1);
  // A Config arriving in a new group opens in the builder; its JSON is one click away.
  await moved.locator('.view-json').click();
  await expectShowing(moved, '@config');

  // Another document in the first group, then the explorer: the Config shows where it lives.
  await groups.nth(0).locator('app-editor-tabs [role="tab"]').first().click();
  await explorerRow(shell, '@config').click();
  await expectShowing(moved, '@config');
  await expect(
    groups.nth(0).locator('app-editor-tabs [role="tab"][data-doc-id="@config"]'),
  ).toHaveCount(0);
});
