import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { chromium } from 'playwright';

import { checkOfflineFonts } from './font-smoke.js';
import { createLogger } from './lib/logger.js';
import { root } from './lib/paths.js';
import { checkPluginSandbox } from './plugin-sandbox-smoke.js';

const log = createLogger('smoke');
const webDir = resolve(root, 'apps/studio');
const require = createRequire(resolve(webDir, 'package.json'));
const ngCli = require.resolve('@angular/cli/bin/ng.js');
const PORT = Number(process.env['SMOKE_PORT'] ?? 4321);
const BASE = `http://127.0.0.1:${PORT}`;
const READY = /Local:\s+http:\/\/(?:localhost|127\.0\.0\.1):/;
const dataDir = mkdtempSync(join(tmpdir(), 'shader-studio-smoke-'));

const ipc = spawnSync('pnpm', ['--filter', '@shadergrove/studio', 'gen:ipc'], {
  cwd: root,
  encoding: 'utf8',
  shell: process.platform === 'win32',
});
if (ipc.status !== 0) {
  log.error(
    'smoke requires gen:ipc — window.electron types come from studio/src/desktop/contracts/ipc-bridge.ts',
  );
  log.error(ipc.stderr || ipc.stdout);
  process.exit(ipc.status ?? 1);
}

const server = spawn(
  process.execPath,
  [ngCli, 'serve', `--port=${PORT}`, '--host=127.0.0.1', '--no-hmr', '--no-live-reload'],
  {
    cwd: webDir,
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      DATABASE_URL: '',
      // A throwaway store, and an account that can sign in without a mailbox or
      // a round-trip to Have I Been Pwned — the smoke drives the editor, not auth.
      SHADER_DATA_DIR: dataDir,
      BETTER_AUTH_URL: BASE,
      AUTH_REQUIRE_VERIFIED_EMAIL: '0',
      AUTH_CHECK_COMPROMISED_PASSWORDS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  },
);

let output = '';
const onChunk = (chunk: Buffer) => {
  output += chunk.toString();
};
server.stdout?.on('data', onChunk);
server.stderr?.on('data', onChunk);

let exiting = false;
const shutdown = async (code = 0) => {
  if (exiting) return;
  exiting = true;
  if (!server.killed) {
    server.kill('SIGTERM');
    await delay(500);
    if (!server.killed) server.kill('SIGKILL');
  }
  process.exit(code);
};

process.on('SIGINT', () => void shutdown(130));
process.on('SIGTERM', () => void shutdown(143));

try {
  await waitForReady(90_000);
  assertServeHealthy();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Readiness must work for the anonymous Docker probe without opening the library.
  const readiness = await page.request.get(BASE + '/api/health');
  if (!readiness.ok() || (await readiness.json()).status !== 'ok') {
    throw new Error('API/database readiness failed');
  }
  if (readiness.headers()['cache-control'] !== 'no-store') {
    throw new Error('Readiness must not be cached');
  }
  const anonymousLibrary = await page.request.get(BASE + '/api/shaders');
  if (anonymousLibrary.status() !== 401) throw new Error('Anonymous library access must be denied');

  // The library is per-account now: sign up first. With verification off, the
  // sign-up response sets the session cookie on this browser context.
  const signUp = await page.request.post(`${BASE}/api/auth/sign-up/email`, {
    headers: { origin: BASE },
    data: { name: 'Smoke', email: 'smoke@example.test', password: 'smoke-test-password' },
  });
  if (!signUp.ok()) throw new Error(`Sign-up failed: ${signUp.status()} ${await signUp.text()}`);

  // New accounts have empty libraries. Verify this throwaway account and create
  // an explicit fixture rather than relying on startup example seeding.
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => {
      prepare(sql: string): { run(...values: unknown[]): unknown };
      close(): void;
    };
  };
  const db = new DatabaseSync(join(dataDir, 'shader-studio.sqlite'));
  try {
    db.prepare('UPDATE users SET email_verified = 1 WHERE email = ?').run('smoke@example.test');
  } finally {
    db.close();
  }
  const fixtureDir = resolve(root, 'examples/shaders/aurora-veil');
  const meta = JSON.parse(readFileSync(join(fixtureDir, 'meta.json'), 'utf8'));
  const fixture = await page.request.post(`${BASE}/api/shaders`, {
    data: {
      name: meta.name,
      controls: meta.controls,
      render: meta.render,
      fragment: readFileSync(join(fixtureDir, 'fragment.glsl'), 'utf8'),
      vertex: readFileSync(join(fixtureDir, 'vertex.glsl'), 'utf8'),
    },
  });
  if (!fixture.ok()) throw new Error(`Fixture failed: ${fixture.status()} ${await fixture.text()}`);
  const signIn = await page.request.post(`${BASE}/api/auth/sign-in/email`, {
    headers: { origin: BASE },
    data: { email: 'smoke@example.test', password: 'smoke-test-password' },
  });
  if (!signIn.ok()) throw new Error(`Sign-in failed: ${signIn.status()}`);

  await page.goto(`${BASE}/shaders/aurora-veil`, { waitUntil: 'networkidle', timeout: 60_000 });
  if ((await page.title()) !== 'Shadergrove') throw new Error('Unexpected application title');
  await page
    .locator('.brand-title')
    .filter({ hasText: /^Shadergrove$/ })
    .waitFor();
  await page.locator('mat-sidenav.drawer').waitFor({ state: 'visible', timeout: 30_000 });
  await page
    .locator('app-inspector-shell.inspector')
    .waitFor({ state: 'visible', timeout: 30_000 });
  await delay(1_200);
  await page
    .locator('.lil-gui .lil-controller')
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 });

  // Effects Rack: add Vignette, reorder it ahead of Bloom, then exercise both
  // the per-effect and master bypass switches. Asserted through stable
  // data-testid hooks rather than translated labels, so a locale change or a
  // copy edit cannot break this script.
  // The rack lives on its own inspector tab (controls, textures, post, presets),
  // picked by position so the label's locale does not matter.
  await page.locator('app-inspector-shell [role="tab"]').nth(2).click();
  const rack = page.locator('app-post-processing-panel');
  await rack.waitFor({ state: 'visible', timeout: 15_000 });

  await rack.locator('[data-testid="pp-add"]').click();
  await page.locator('[data-testid="pp-add-vignette"]').click();
  // A new instance gets a fresh id (`vignette-<random>`), so the row is found by
  // its prefix and every control below is addressed through that id.
  const vignetteRow = rack.locator('[data-testid^="pp-effect-vignette"]').last();
  await vignetteRow.waitFor({ state: 'visible', timeout: 10_000 });
  const vignetteRowId = await vignetteRow.getAttribute('data-testid');
  const vignetteId = vignetteRowId?.replace('pp-effect-', '') ?? '';
  if (!vignetteId) throw new Error('The added Vignette row has no instance id');

  // Vignette is appended after Bloom — move it up so it now precedes Bloom,
  // then confirm the DOM order (which mirrors the composer's build order)
  // actually changed. The reorder mutation lands via an Angular signal, which
  // re-renders on its own microtask, so poll for the new order instead of
  // reading it synchronously right after the click. Locator.getAttribute
  // (rather than page.waitForFunction) keeps this tool-script context free of
  // the DOM lib the browser-side callback would otherwise need.
  await vignetteRow.locator(`[data-testid="pp-move-up-${vignetteId}"]`).click();
  const firstEffect = rack.locator('.effect').first();
  const deadline = Date.now() + 10_000;
  let firstEffectTestId: string | null = null;
  while (Date.now() < deadline) {
    firstEffectTestId = await firstEffect.getAttribute('data-testid');
    if (firstEffectTestId === vignetteRowId) break;
    await delay(50);
  }
  const rowTypes = await rack
    .locator('.effect')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-testid')));
  if (rowTypes[0] !== vignetteRowId) {
    throw new Error(`Expected Vignette first after reordering, got: ${rowTypes.join(', ')}`);
  }

  // Per-effect bypass, then the chain's master switch — both must stay
  // interactive with no reload. Rendering-path correctness (direct vs.
  // composer) is asserted by the deterministic PostProcessing unit tests;
  // smoke only proves the controls survive real DOM interaction.
  const vignetteToggle = rack.locator(`[data-testid="pp-enable-${vignetteId}"]`);
  await vignetteToggle.click();
  await rack.locator('[data-testid="pp-master-toggle"]').click();
  await rack.locator('[data-testid="pp-master-toggle"]').click();
  await vignetteToggle.click();
  // Remove lives in the row's "more actions" menu, rendered in the overlay.
  await rack.locator(`[data-testid="pp-more-${vignetteId}"]`).click();
  await page.locator(`[data-testid="pp-remove-${vignetteId}"]`).click();
  await rack
    .locator(`[data-testid="${vignetteRowId}"]`)
    .waitFor({ state: 'detached', timeout: 10_000 });

  await page.locator('button[aria-label="More actions"]').click();
  await page.getByRole('menuitem', { name: 'Show editor' }).click();
  await page.locator('app-editor-shell').waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('.monaco-editor').waitFor({ state: 'visible', timeout: 30_000 });

  // Bounded Profiler path: open the bottom-panel tab, assert honest content, then leave and
  // confirm the panel is no longer active. Headless Chromium typically lacks
  // EXT_disjoint_timer_query_webgl2, so the unsupported/empty copy is the
  // supported-path stand-in; deterministic unit tests cover the timing path.
  await page.keyboard.press('Control+J');
  const bottomPanel = page.locator('app-bottom-panel');
  await bottomPanel.waitFor({ state: 'visible', timeout: 10_000 });
  await page.evaluate(`(() => {
    const tab = [...document.querySelectorAll('app-bottom-panel [role="tab"]')]
      .find((item) => /Profiler/i.test(item.textContent ?? ''));
    if (!(tab instanceof HTMLElement)) throw new Error('Profiler tab not found');
    tab.click();
  })()`);
  const profiler = bottomPanel.locator('app-profiler-panel');
  await profiler.waitFor({ state: 'visible', timeout: 15_000 });
  const profilerStatePattern =
    /GPU timing is unavailable|Collecting GPU samples|Waiting for the active preview|GPU timing was interrupted by the driver/i;
  const profilerText = await waitForMatch(() => profiler.innerText(), profilerStatePattern, 10_000);
  const observedProfilerState = profilerStatePattern.exec(profilerText)?.[0] ?? 'unknown';
  log.info(`Profiler state observed: ${observedProfilerState}`);

  // Force-path DOM click: the preview canvas can intercept Playwright hit-testing
  // even when the tab is scrolled into view inside the docked panel.
  await page.evaluate(`(() => {
    const tabs = document.querySelectorAll('app-bottom-panel [role="tab"]');
    const output = [...tabs].find((tab) => /Output/i.test(tab.textContent ?? ''));
    if (!(output instanceof HTMLElement)) throw new Error('Output tab not found');
    output.click();
  })()`);
  await waitForMatch(
    async () =>
      [
        await bottomPanel.getByRole('tab', { name: /Profiler/i }).getAttribute('aria-selected'),
        await bottomPanel.getByRole('tab', { name: /Output/i }).getAttribute('aria-selected'),
      ].join(','),
    /^false,true$/,
    5_000,
  );
  await bottomPanel.locator('app-output-panel').waitFor({ state: 'visible', timeout: 10_000 });
  // preserveContent keeps ProfilerPanel mounted; disable-on-leave is covered by
  // mounted unit tests via setProfilingEnabled(false). Smoke asserts the tab left.

  await checkOfflineFonts(browser, BASE);
  log.info(
    'offline fonts ok — Inter, JetBrains Mono and Material Symbols load with the network blocked',
  );

  await checkPluginSandbox(browser, BASE);
  log.info('plugin sandbox ok — escapes blocked, terminate destroys the Worker');

  await browser.close();
  log.info('smoke ok — drawer, inspector controls, Monaco editor, and Profiler tab loaded');
  await shutdown(0);
} catch (error) {
  log.error('smoke failed');
  log.error(error);
  if (output.trim()) {
    log.error('--- ng serve output ---');
    log.error(output.slice(-8_000));
  }
  await shutdown(1);
}

function assertServeHealthy(): void {
  if (/Application bundle generation failed|ERROR in |✘ \[ERROR\]/i.test(output)) {
    throw new Error('ng serve reported a compile failure');
  }
}

async function waitForMatch(
  read: () => Promise<string>,
  pattern: RegExp,
  timeoutMs: number,
): Promise<string> {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < timeoutMs) {
    last = await read();
    if (pattern.test(last)) return last;
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${pattern}: last text was ${JSON.stringify(last)}`);
}

function waitForReady(timeoutMs: number): Promise<void> {
  return new Promise<void>((resolveReady, reject) => {
    const started = Date.now();

    const check = () => {
      if (/Application bundle generation failed/i.test(output)) {
        reject(new Error('ng serve failed to compile the application'));
        return;
      }
      if (READY.test(output)) {
        resolveReady();
        return;
      }
      if (server.exitCode !== null) {
        reject(new Error(`ng serve exited early with code ${server.exitCode}`));
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Timed out waiting for ng serve on port ${PORT}`));
        return;
      }
      setTimeout(check, 250);
    };

    check();
  });
}
