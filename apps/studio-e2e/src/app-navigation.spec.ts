// The top bar's Editor / Explore / Plugins links, end to end in the browser:
// they stay on screen over every page, lead back to where each part was left
// (the open draft, the Explore search, the Plugins tab), keep the hidden editor
// out of the pointer's and the keyboard's way, survive a slow page chunk, and
// never appear in zen or in the output window.
//
// Explore is switched off on this suite's shared server, so where it is wanted
// its public endpoints are answered here; that proves the browser's behaviour,
// not the server's own rendering.

/// <reference lib="dom" />

import type { Page, Route } from '@playwright/test';

import { expect, test } from './fixtures';

test.describe.configure({ timeout: 180_000 });

const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const PAGE_SIZE = 12;
const library = Array.from({ length: 30 }, (_, index) => {
  const number = String(index + 1).padStart(2, '0');
  return { id: `nebula-${number}`, title: `Nebula ${number}` };
});
const summary = ({ id, title }: { id: string; title: string }) => ({
  id,
  title,
  description: '',
  authorLabel: 'Alice A.',
  license: 'CC-BY-4.0',
  revision: 1,
  publishedAt: '2026-09-30T10:00:00.000Z',
  updatedAt: '2026-09-30T10:00:00.000Z',
  hasThumbnail: true,
});

/** Turns public Explore on for this page and answers its listing, one order only. */
async function mockExplore(page: Page): Promise<void> {
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/capabilities', (route) =>
    json(route, { publicExplore: true, admin: false }),
  );
  await page.route('**/api/publications**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/publications') {
      const search = (url.searchParams.get('search') ?? '').toLowerCase();
      const from = Number(url.searchParams.get('cursor')?.slice(1) ?? 0);
      const matches = library.filter(({ title }) => title.toLowerCase().includes(search));
      const to = from + PAGE_SIZE;
      return json(route, {
        publications: matches.slice(from, to).map(summary),
        nextCursor: to < matches.length ? `${(url.searchParams.get('sort') ?? 'u')[0]}${to}` : null,
      });
    }
    const id = /^\/api\/publications\/([^/]+)$/.exec(url.pathname)?.[1];
    const found = library.find((entry) => entry.id === id);
    if (found) {
      return json(route, {
        publication: {
          ...summary(found),
          attribution: '',
          derivedFrom: null,
          shader: { id: found.id, name: found.title },
        },
      });
    }
    if (url.pathname.endsWith('/thumbnail')) {
      return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
    }
    return route.continue();
  });
}

async function openEditor(page: Page, width = 1280): Promise<void> {
  await page.setViewportSize({ width, height: 700 });
  await page.addInitScript(() => {
    localStorage.setItem(
      'shader-studio.preferences',
      JSON.stringify({ paused: true, browserOpen: false, guiVisible: false, editorOpen: true }),
    );
  });
  await page.goto('/');
  await expect(page.locator('app-editor-shell .monaco-editor')).toBeVisible();
}

async function makeDraft(page: Page, marker: string): Promise<void> {
  const shell = page.locator('app-editor-shell');
  await shell.locator('.monaco-editor').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(`\n// ${marker}`);
  await expect(shell.getByText('Unsaved changes', { exact: true })).toBeVisible();
}

async function expectDraft(page: Page, marker: string): Promise<void> {
  const shell = page.locator('app-editor-shell');
  await expect(shell).toBeVisible();
  await expect(shell.getByText('Unsaved changes', { exact: true })).toBeVisible();
  await expect(shell.locator('.view-lines')).toContainText(marker);
}

const tab = (page: Page, name: 'editor' | 'explore' | 'plugins') =>
  page.getByTestId(`open-${name}`);

async function expectCurrent(page: Page, name: 'editor' | 'explore' | 'plugins') {
  await expect(tab(page, name)).toHaveAttribute('aria-current', 'page');
}

/** The routed page starts below the bars, the links are hit-testable, and nothing scrolls sideways. */
async function expectNavOverPage(page: Page, host: string): Promise<void> {
  await expect(page.locator(host)).toBeVisible();
  const layout = await page.evaluate((selector) => {
    const toolbar = document.querySelector('mat-toolbar.toolbar')!.getBoundingClientRect();
    const pageBox = document.querySelector(selector)!.getBoundingClientRect();
    const root = document.scrollingElement!;
    return {
      gap: pageBox.top - toolbar.bottom,
      overflow: root.scrollWidth - root.clientWidth,
      bodyInert: document.querySelector('mat-sidenav-container.body')!.hasAttribute('inert'),
      previewInert: document.querySelector('app-preview-shell')!.hasAttribute('inert'),
    };
  }, host);
  expect(layout).toEqual({ gap: 0, overflow: 0, bodyInert: true, previewInert: true });
  for (const name of ['editor', 'plugins'] as const) {
    await tab(page, name).click({ trial: true });
  }
}

test('the links keep the draft and bring back the Explore search and the Plugins tab', async ({
  page,
}) => {
  await mockExplore(page);
  await openEditor(page);
  await makeDraft(page, 'nav draft');
  await expectCurrent(page, 'editor');

  // A current link goes nowhere: no history entry, no navigation.
  const before = await page.evaluate(() => history.length);
  await tab(page, 'editor').click();
  expect(await page.evaluate(() => history.length)).toBe(before);

  // Explore: search, a second page, scroll; a publication; Plugins; then back by the link.
  await tab(page, 'explore').click();
  await expect(page).toHaveURL('/explore');
  await expectCurrent(page, 'explore');
  await expectNavOverPage(page, 'app-explore-page');
  const search = page.getByRole('searchbox', { name: 'Search titles, descriptions and authors' });
  await search.fill('nebula');
  await search.press('Enter');
  await expect(page).toHaveURL('/explore?q=nebula');
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(page.locator('app-explore-page .card')).toHaveCount(24);
  const scrolled = await page.locator('app-explore-page').evaluate((host) => {
    host.scrollTop = 200;
    return host.scrollTop;
  });
  expect(scrolled).toBeGreaterThan(0);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  await tab(page, 'explore').click();
  await expect(page).toHaveURL('/explore?q=nebula');

  await page.locator('app-explore-page a[href="/explore/nebula-02"]').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Nebula 02' })).toBeVisible();
  await expectCurrent(page, 'explore');
  await expectNavOverPage(page, 'app-publication-page');

  await tab(page, 'plugins').click();
  await expect(page).toHaveURL('/plugins');
  await expectCurrent(page, 'plugins');
  await expectNavOverPage(page, 'app-plugins-page');
  await page.getByTestId('plugins-tab-installed').click();
  await expect(page).toHaveURL('/plugins?tab=installed');

  await tab(page, 'explore').click();
  await expect(page).toHaveURL('/explore?q=nebula');
  await expect(page.locator('app-explore-page .card')).toHaveCount(24);
  await expect(search).toHaveValue('nebula');
  await expect
    .poll(() => page.locator('app-explore-page').evaluate((h) => h.scrollTop))
    .toBe(scrolled);

  await tab(page, 'plugins').click();
  await expect(page).toHaveURL('/plugins?tab=installed');
  await expect(page.getByTestId('plugins-tab-installed')).toHaveAttribute('aria-selected', 'true');

  await tab(page, 'editor').click();
  await expectCurrent(page, 'editor');
  await expect(page).toHaveURL(/\/shaders\/[^/]+$/);
  await expectDraft(page, 'nav draft');
  await expect(page.locator('mat-sidenav-container.body')).not.toHaveAttribute('inert');
});

test('at 390px the links stay usable, and the keyboard never reaches the hidden editor', async ({
  page,
}) => {
  await openEditor(page, 390);
  // Explore is off on this server: no way in is offered.
  await expect(tab(page, 'explore')).toHaveCount(0);
  await expect(tab(page, 'editor')).toHaveAccessibleName('Editor');
  await expect(tab(page, 'plugins')).toHaveAccessibleName('Plugins');

  await tab(page, 'plugins').click();
  await expectCurrent(page, 'plugins');
  await expectNavOverPage(page, 'app-plugins-page');
  await expect(page.locator('mat-toolbar.toolbar app-transport-bar')).toBeHidden();

  // Forwards from the Plugins link: the page's own controls, never the editor's.
  await tab(page, 'plugins').focus();
  for (let step = 0; step < 25; step++) {
    await page.keyboard.press('Tab');
    const hidden = await page.evaluate(
      () => !!document.activeElement?.closest('mat-sidenav-container.body, app-preview-shell'),
    );
    expect(hidden, `focus stop ${step}`).toBe(false);
  }
  await page.setViewportSize({ width: 1280, height: 700 });
  await expectNavOverPage(page, 'app-plugins-page');
});

test('a slow page chunk is waited for, through a direct link, reload, Back and Forward', async ({
  page,
}) => {
  await openEditor(page);
  const editorUrl = page.url();
  // Every script from now on arrives late, the Plugins page's chunk among them.
  await page.route('**/*.js', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.continue();
  });

  await tab(page, 'plugins').click();
  // Until the page has arrived, the editor is what is shown and current.
  await expectCurrent(page, 'editor');
  await expect(page).toHaveURL('/plugins');
  await expectCurrent(page, 'plugins');
  await expect(page.locator('app-plugins-page')).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(editorUrl);
  await expectCurrent(page, 'editor');
  await page.goForward();
  await expect(page).toHaveURL('/plugins');
  await expect(page.locator('app-plugins-page')).toBeVisible();

  await page.goto('/plugins?tab=installed');
  await expect(page.getByTestId('plugins-tab-installed')).toHaveAttribute('aria-selected', 'true');
  await page.reload();
  await expect(page.getByTestId('plugins-tab-installed')).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL('/plugins?tab=installed');
  await expectCurrent(page, 'plugins');
});

test('reaching a page leaves zen, and the output window has no links', async ({ page }) => {
  await openEditor(page);
  await tab(page, 'plugins').click();
  await expect(page.locator('app-plugins-page')).toBeVisible();
  await page.goBack();
  await expectCurrent(page, 'editor');

  await page.locator('body').press('z');
  await expect(page.locator('.shell.zen')).toHaveCount(1);
  await page.goForward();
  await expect(page.locator('app-plugins-page')).toBeVisible();
  await expect(page.locator('.shell.zen')).toHaveCount(0);
  await expectNavOverPage(page, 'app-plugins-page');

  await page.goto('/output');
  await expect(page.locator('app-preview-shell')).toBeAttached();
  await expect(page.locator('mat-toolbar.toolbar')).toHaveCount(0);
  await expect(tab(page, 'editor')).toHaveCount(0);
});
