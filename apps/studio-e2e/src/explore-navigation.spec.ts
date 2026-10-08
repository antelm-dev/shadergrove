// The data and DOM types are for the callbacks Playwright runs in the page.
/// <reference lib="dom" />

// Explore browsing, end to end in the browser: the search lives in the address,
// and opening a publication and coming back (browser Back or the page's own
// Explore link) puts back the same cards, cursor, search and scroll position.
//
// Explore is switched off on this suite's shared server, so the public
// endpoints the browser calls (`/api/capabilities`, `/api/publications…`) are
// answered here, which is also how the test sees exactly which requests were
// made. That proves the browser's behaviour, not the backend or the server's
// own rendering, which a mock in the browser cannot reach.

import type { Page, Route } from '@playwright/test';

import { expect, test } from './fixtures';

test.describe.configure({ timeout: 180_000 });

const PAGE_SIZE = 12;
const PER_NAME = 20;
const NAMES = ['Aurora', 'Bloom'] as const;
// One transparent pixel: the cards only need an image that loads.
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

interface Published {
  id: string;
  title: string;
}

const library: Published[] = NAMES.flatMap((name) =>
  Array.from({ length: PER_NAME }, (_, index) => {
    const number = String(index + 1).padStart(2, '0');
    return { id: `${name.toLowerCase()}-${number}`, title: `${name} ${number}` };
  }),
);

const summary = ({ id, title }: Published) => ({
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

interface ListRequest {
  search: string | null;
  cursor: string | null;
}

/** Answers the public Explore endpoints for a page, and remembers what it was asked. */
async function mockExplore(
  page: Page,
  { slow = {} as Record<string, number>, gone = [] as string[] } = {},
) {
  const listings: ListRequest[] = [];
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  await page.route('**/api/capabilities', (route) =>
    json(route, { publicExplore: true, admin: false }),
  );
  await page.route('**/api/publications**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/publications') {
      const search = url.searchParams.get('search');
      const cursor = url.searchParams.get('cursor');
      listings.push({ search, cursor });
      const delay = slow[search ?? ''] ?? 0;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const matches = library.filter(({ title }) =>
        title.toLowerCase().includes((search ?? '').toLowerCase()),
      );
      const from = cursor ? Number(cursor.slice(1)) : 0;
      const to = from + PAGE_SIZE;
      return json(route, {
        publications: matches.slice(from, to).map(summary),
        nextCursor: to < matches.length ? `c${to}` : null,
      });
    }
    const id = /^\/api\/publications\/([^/]+)$/.exec(url.pathname)?.[1];
    if (id) {
      const found = gone.includes(id) ? undefined : library.find((entry) => entry.id === id);
      return found
        ? json(route, {
            publication: {
              ...summary(found),
              attribution: '',
              derivedFrom: null,
              shader: { id: found.id, name: found.title },
            },
          })
        : json(route, { error: { code: 'not_found', message: 'No such shader' } }, 404);
    }
    if (url.pathname.endsWith('/thumbnail')) {
      return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
    }
    return route.continue();
  });
  return listings;
}

/** A short window, so the listing is certain to scroll; the editor open and still. */
async function openEditor(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.addInitScript(() => {
    localStorage.setItem(
      'shader-studio.preferences',
      JSON.stringify({ paused: true, browserOpen: false, guiVisible: false, editorOpen: true }),
    );
  });
  await page.goto('/');
  await expect(page.locator('app-editor-shell .monaco-editor')).toBeVisible();
}

/** Leaves unsaved work in the open shader, to be found there after all the browsing. */
async function makeDraft(page: Page, marker: string): Promise<void> {
  const shell = page.locator('app-editor-shell');
  await shell.locator('.monaco-editor').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(`\n// ${marker}`);
  await expect(shell.getByText('Unsaved changes', { exact: true })).toBeVisible();
}

async function expectDraft(page: Page, marker: string): Promise<void> {
  const shell = page.locator('app-editor-shell');
  await expect(shell.getByText('Unsaved changes', { exact: true })).toBeVisible();
  await expect(shell.locator('.view-lines')).toContainText(marker);
}

const cards = (page: Page) => page.locator('app-explore-page .card');
const titles = (page: Page) => page.locator('app-explore-page .card-title').allTextContents();
const search = (page: Page) => page.getByRole('searchbox', { name: 'Search public shaders' });

async function submitSearch(page: Page, text: string): Promise<void> {
  await search(page).fill(text);
  await search(page).press('Enter');
}

async function scrollExplore(page: Page): Promise<number> {
  const top = await page.locator('app-explore-page').evaluate((host) => {
    host.scrollTop = 300;
    return host.scrollTop;
  });
  expect(top, 'the listing is long enough to scroll').toBeGreaterThan(0);
  // The page records its position from the scroll event.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
  return top;
}

const scrollOf = (page: Page) =>
  page.locator('app-explore-page').evaluate((host) => host.scrollTop);

/**
 * The card nearest the middle of what is on screen. Clicking a card off screen
 * makes Playwright scroll to it first, which moves the very position under test.
 */
const cardOnScreen = (page: Page) =>
  page.locator('app-explore-page').evaluate((host) => {
    const box = host.getBoundingClientRect();
    const middle = box.top + box.height / 2;
    const distances = [...host.querySelectorAll('.card')].map((card) => {
      const { top, bottom } = card.getBoundingClientRect();
      return Math.abs((top + bottom) / 2 - middle);
    });
    return distances.indexOf(Math.min(...distances));
  });

test('Back and the Explore link both return to the same search, pages and scroll position', async ({
  page,
}) => {
  const listings = await mockExplore(page);
  await openEditor(page);
  await makeDraft(page, 'explore draft');

  await page.getByRole('link', { name: 'Explore', exact: true }).click();
  await expect(page).toHaveURL('/explore');
  await expect(cards(page)).toHaveCount(PAGE_SIZE);

  await submitSearch(page, '  aurora ');
  await expect(page).toHaveURL('/explore?q=aurora');
  await expect(cards(page)).toHaveCount(PAGE_SIZE);
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(cards(page)).toHaveCount(PER_NAME);
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
  const scrolled = await scrollExplore(page);
  const requests = listings.length;
  const opened = await cardOnScreen(page);
  const number = String(opened + 1).padStart(2, '0');

  // Back.
  await cards(page).nth(opened).click();
  await expect(page).toHaveURL(`/explore/aurora-${number}`);
  await expect(page.getByRole('heading', { level: 1, name: `Aurora ${number}` })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL('/explore?q=aurora');
  await expect(cards(page)).toHaveCount(PER_NAME);
  await expect(search(page)).toHaveValue('aurora');
  await expect.poll(() => scrollOf(page)).toBe(scrolled);

  // The page's own link takes the same way back.
  await cards(page).nth(opened).click();
  await expect(page.getByRole('heading', { level: 1, name: `Aurora ${number}` })).toBeVisible();
  await page
    .locator('app-publication-page .page-bar')
    .getByRole('link', { name: 'Explore' })
    .click();
  await expect(page).toHaveURL('/explore?q=aurora');
  await expect(cards(page)).toHaveCount(PER_NAME);
  await expect.poll(() => scrollOf(page)).toBe(scrolled);
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);

  // Nothing was asked of the server on the way, and the draft was never touched.
  expect(listings).toHaveLength(requests);
  await page.getByRole('link', { name: 'Back to the editor' }).click();
  await expectDraft(page, 'explore draft');
});

test('walking back and forward between two searches never mixes their pages', async ({ page }) => {
  const listings = await mockExplore(page);
  await page.goto('/');
  await expect(page.locator('mat-toolbar.toolbar')).toBeVisible();
  await page.getByRole('link', { name: 'Explore', exact: true }).click();

  await submitSearch(page, 'aurora');
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(cards(page)).toHaveCount(PER_NAME);
  await submitSearch(page, 'bloom');
  await expect(page).toHaveURL('/explore?q=bloom');
  await expect(cards(page)).toHaveCount(PAGE_SIZE);
  expect((await titles(page)).every((title) => title.startsWith('Bloom'))).toBe(true);

  await page.goBack();
  await expect(page).toHaveURL('/explore?q=aurora');
  await expect(cards(page)).toHaveCount(PER_NAME);
  expect((await titles(page)).every((title) => title.startsWith('Aurora'))).toBe(true);
  await page.goForward();
  await expect(page).toHaveURL('/explore?q=bloom');
  await expect(cards(page)).toHaveCount(PAGE_SIZE);
  expect((await titles(page)).every((title) => title.startsWith('Bloom'))).toBe(true);
  // Bloom's second page was never loaded, and was not conjured from Aurora's.
  await expect(page.getByRole('button', { name: 'Load more' })).toBeVisible();

  expect(listings.map(({ search }) => search)).toEqual([null, 'aurora', 'aurora', 'bloom']);
});

test('a direct search link and a reload ask the search endpoint for that search', async ({
  page,
}) => {
  const listings = await mockExplore(page);
  await page.goto('/explore?q=bloom');
  await expect(cards(page)).toHaveCount(PAGE_SIZE);
  await expect(search(page)).toHaveValue('bloom');
  expect((await titles(page)).every((title) => title.startsWith('Bloom'))).toBe(true);

  await page.reload();
  await expect(cards(page)).toHaveCount(PAGE_SIZE);
  expect((await titles(page)).every((title) => title.startsWith('Bloom'))).toBe(true);
  // Every request, including those the server made for itself, was for this search.
  expect(listings.length).toBeGreaterThanOrEqual(2);
  expect(new Set(listings.map(({ search }) => search))).toEqual(new Set(['bloom']));

  // An untidy address is tidied in place, not stacked on the history.
  await page.goto('/explore?q=%20%20aurora%20');
  await expect(page).toHaveURL('/explore?q=aurora');
  await expect(search(page)).toHaveValue('aurora');
  await page.goBack();
  await expect(page).toHaveURL('/explore?q=bloom');
});

test('a slow answer for an earlier search never lands on the one shown now', async ({ page }) => {
  await mockExplore(page, { slow: { aurora: 1500 } });
  await page.goto('/');
  await expect(page.locator('mat-toolbar.toolbar')).toBeVisible();
  await page.getByRole('link', { name: 'Explore', exact: true }).click();
  await expect(cards(page)).toHaveCount(PAGE_SIZE);

  await submitSearch(page, 'aurora');
  await expect(page).toHaveURL('/explore?q=aurora');
  await submitSearch(page, 'bloom');
  await expect(page).toHaveURL('/explore?q=bloom');
  await expect(cards(page)).toHaveCount(PAGE_SIZE);
  // Longer than the slow answer takes.
  await page.waitForTimeout(2200);
  expect((await titles(page)).every((title) => title.startsWith('Bloom'))).toBe(true);
  await expect(cards(page)).toHaveCount(PAGE_SIZE);

  // Aurora never finished for this page, so there is nothing of it to restore: it loads.
  await page.goBack();
  await expect(page).toHaveURL('/explore?q=aurora');
  await expect(cards(page)).toHaveCount(PAGE_SIZE);
  expect((await titles(page)).every((title) => title.startsWith('Aurora'))).toBe(true);
});

test('a search kept for more than five minutes is asked for again', async ({ page }) => {
  const listings = await mockExplore(page);
  // Only the clock the page reads, so timers and animation carry on as usual.
  await page.addInitScript(() => {
    const now = Date.now.bind(Date);
    Object.assign(globalThis, { skew: 0 });
    Date.now = () => now() + (globalThis as unknown as { skew: number }).skew;
  });
  await page.goto('/explore?q=bloom');
  await expect(cards(page)).toHaveCount(PAGE_SIZE);
  await cards(page).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Bloom 01' })).toBeVisible();
  const requests = listings.length;

  await page.evaluate(() => Object.assign(globalThis, { skew: 6 * 60 * 1000 }));
  await page.goBack();
  await expect(page).toHaveURL('/explore?q=bloom');
  await expect(cards(page)).toHaveCount(PAGE_SIZE);
  expect(listings.length).toBe(requests + 1);
});

test('a publication that is gone still leads back to the search', async ({ page }) => {
  // Taken down between the listing and the click.
  const listings = await mockExplore(page, { gone: ['bloom-03'] });
  await page.goto('/');
  await expect(page.locator('mat-toolbar.toolbar')).toBeVisible();
  await page.getByRole('link', { name: 'Explore', exact: true }).click();
  await submitSearch(page, 'bloom');
  await expect(cards(page)).toHaveCount(PAGE_SIZE);
  const requests = listings.length;

  await page.locator('app-explore-page a[href="/explore/bloom-03"]').click();
  await expect(page.getByText('This shader is not public.')).toBeVisible();
  await page
    .locator('app-publication-page .page-bar')
    .getByRole('link', { name: 'Explore' })
    .click();
  await expect(page).toHaveURL('/explore?q=bloom');
  await expect(cards(page)).toHaveCount(PAGE_SIZE);
  expect(listings).toHaveLength(requests);
});

test('a publication opened directly has no search to return to', async ({ page }) => {
  await mockExplore(page);
  await page.goto('/explore/bloom-01');
  await expect(page.getByRole('heading', { level: 1, name: 'Bloom 01' })).toBeVisible();
  await page
    .locator('app-publication-page .page-bar')
    .getByRole('link', { name: 'Explore' })
    .click();
  await expect(page).toHaveURL('/explore');
  await expect(search(page)).toHaveValue('');
});
