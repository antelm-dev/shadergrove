import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../tools/workspace/package.json', import.meta.url));
const { chromium } = require('playwright');
const url = process.env.PREVIEW_URL;
if (!/^https:\/\/pr-[1-9]\d*\.45-155-170-120\.sslip\.io$/.test(url))
  throw new Error('Invalid preview URL');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const health = await page.request.get(`${url}/api/health`);
  assert.equal(health.status(), 200);
  assert.equal((await health.json()).status, 'ok');
  assert.equal((await page.request.get(`${url}/api/shaders`)).status(), 401);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page
    .locator('.brand-title')
    .filter({ hasText: /^Shadergrove$/ })
    .waitFor({ timeout: 30_000 });
  assert.equal(await page.title(), 'Shadergrove');
  console.log(`Preview browser, database readiness and anonymous access checks passed: ${url}`);
} finally {
  await browser.close();
}
