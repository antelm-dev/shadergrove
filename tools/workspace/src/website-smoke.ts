/** Exercises the exported website against a deterministic public release catalogue. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium, type Page } from 'playwright';

const root = resolve(import.meta.dirname, '../../..');
const output = resolve(root, 'apps/website/out');
const screenshots = resolve(root, 'test-results/website');
const types: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.txt': 'text/plain',
};
const server = createServer((request, response) => {
  void (async () => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    const requested = resolve(output, `.${path}`);
    if (!requested.startsWith(output + sep) && requested !== output) {
      response.writeHead(403).end();
      return;
    }
    let file: string | undefined;
    // Exported routes may have both page.html and a page/ directory containing RSC
    // prefetch data. Like nginx try_files, select a real file before a directory index.
    for (const candidate of [requested, `${requested}.html`, resolve(requested, 'index.html')]) {
      try {
        if ((await stat(candidate)).isFile()) {
          file = candidate;
          break;
        }
      } catch {
        /* try next */
      }
    }
    if (!file) {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(file);
      response.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  })().catch(() => response.writeHead(500).end());
});
server.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function release(version: string, channel = 'stable') {
  return {
    version,
    channel,
    title: `Shadergrove ${version}`,
    publishedAt: '2026-10-02T19:15:09Z',
    url: `https://github.com/antelm-dev/shadergrove/releases/tag/v${version}`,
    notes:
      '## Improvements\n\n- Better shader editing\n\n<script>window.releaseNotesExecuted = true</script>\n\n[Unsafe](javascript:alert(1))\n\n![tracking](https://tracking.example/pixel.png)',
    downloads: [
      {
        name: `shadergrove-${version}-setup.exe`,
        platform: 'windows',
        arch: 'x64',
        kind: 'installer',
        size: 104857600,
        url: `https://github.com/antelm-dev/shadergrove/releases/download/v${version}/shadergrove-${version}-setup.exe`,
      },
    ],
  };
}

const stable = release('1.5.0');
const beta = release('2.0.0-beta.1', 'beta');
let unavailable = false;
let newer = false;
let catalogueRequests = 0;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let currentPage: Page | undefined;
const errors: string[] = [];
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  currentPage = page;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/releases**', async (route) => {
    catalogueRequests++;
    const url = new URL(route.request().url());
    const suffix = url.pathname.split('/api/releases')[1] ?? '';
    const selected =
      url.searchParams.get('channel') === 'beta' ? beta : newer ? release('1.6.0') : stable;
    const body =
      suffix === '/latest'
        ? { release: selected }
        : suffix === '/1.5.0'
          ? stable
          : suffix === '/2.0.0-beta.1'
            ? beta
            : suffix
              ? { error: { code: 'not_found' } }
              : { releases: [selected], nextPage: url.searchParams.get('page') === '2' ? null : 2 };
    await route.fulfill({
      status: unavailable
        ? 503
        : suffix && suffix !== '/latest' && suffix !== '/1.5.0' && suffix !== '/2.0.0-beta.1'
          ? 404
          : 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
  await page.goto(`${base}/download`);
  await page.getByText('Version 1.5.0', { exact: true }).waitFor();
  assert.equal(
    await page.getByRole('link', { name: /Installer · 64-bit/ }).getAttribute('href'),
    stable.downloads[0]!.url,
  );
  assert.equal(await page.getByText('For your system').count(), 1);
  assert.equal(await page.getByRole('link', { name: /AppImage|Disk image/ }).count(), 0);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: resolve(screenshots, 'download.png'), fullPage: true });
  await page.getByRole('link', { name: 'See what’s new ↗' }).click();
  await page.getByRole('heading', { name: 'Shadergrove 1.5.0' }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('version'), '1.5.0');
  assert.equal(await page.getByText('Better shader editing').count(), 1);
  assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
  assert.equal(await page.locator('img[src*="tracking.example"]').count(), 0);
  assert.equal(await page.evaluate("'releaseNotesExecuted' in window"), false);
  await page.screenshot({ path: resolve(screenshots, 'changelog.png'), fullPage: true });
  await page.getByRole('link', { name: 'Download 1.5.0 ↓' }).click();
  await page.getByText('Version 1.5.0', { exact: true }).waitFor();
  await page.goto(`${base}/download?channel=beta`);
  await page.getByText('Version 2.0.0-beta.1', { exact: true }).waitFor();
  assert.equal(await page.getByText('This is a preview release.', { exact: false }).count(), 1);
  await page.goto(`${base}/changelog`);
  await page.getByRole('heading', { name: 'Shadergrove 1.5.0' }).waitFor();
  await page.getByRole('button', { name: 'Load older releases ↓' }).click();
  // The same version on overlapping pages must not duplicate the article.
  await page.getByRole('status').waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('button', { name: 'Load older releases ↓' }).count(), 0);
  assert.equal(await page.getByRole('heading', { name: 'Shadergrove 1.5.0' }).count(), 1);
  unavailable = true;
  await page.goto(`${base}/download`);
  await page
    .getByRole('alert')
    .filter({ hasText: 'Release information is temporarily unavailable' })
    .waitFor();
  assert.equal(await page.getByRole('link', { name: /Installer ·/ }).count(), 0);
  unavailable = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.getByText('Version 1.5.0', { exact: true }).waitFor();
  newer = true;
  await page.reload();
  await page.getByText('Version 1.6.0', { exact: true }).waitFor();
  await page.goto(`${base}/changelog?version=99.0.0`);
  await page.getByRole('alert').filter({ hasText: 'This release could not be found.' }).waitFor();
  assert.equal(await page.getByText('This release could not be found.').count(), 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/download?version=1.5.0`);
  await page.getByText('Version 1.5.0', { exact: true }).waitFor();
  assert.equal(
    await page.evaluate('document.documentElement.scrollWidth > window.innerWidth'),
    false,
  );
  await page.screenshot({ path: resolve(screenshots, 'download-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  assert.ok(catalogueRequests >= 10);
  console.log(
    'Website smoke passed: direct downloads, channel isolation, version links, safe Markdown, pagination, retry, new release without rebuild, mobile layout.',
  );
  console.log(`Screenshots: ${screenshots}`);
} catch (error) {
  await mkdir(screenshots, { recursive: true });
  await currentPage?.screenshot({ path: resolve(screenshots, 'failure.png'), fullPage: true });
  console.error('Browser errors:', errors);
  console.error('Page:', await currentPage?.locator('body').innerText());
  throw error;
} finally {
  await browser?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
