/// <reference lib="dom" />
// The page's Angular debug API (`window.ng`) and the components behind it are untyped here.
/* oxlint-disable typescript/no-explicit-any */

// Shader Doctor end to end in the browser: the official package, installed from
// its generated file, switched on, and run from its Installed card — through
// the real sandboxed plugin Worker — against the open shader. The texture slot
// 0 image is answered with a 404, so the preview's own load fails; slot 1 is
// bound but empty; the shader has a feedback buffer and an active Vignette.
// The report names its target and version, changes with the target, takes the
// user to a binding, goes out of date when a texture changes, and disappears
// with the package.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Page } from '@playwright/test';
import {
  DEFAULT_VERTEX,
  addBuffer,
  bufferPasses,
  createProject,
  imagePass,
  setChannelBinding,
  type ShaderProject,
} from '@shadergrove/shared/project';

import { expect, test } from './fixtures';

test.describe.configure({ timeout: 180_000 });

const DOCTOR = 'dev.shadergrove.shader-doctor';
const root = resolve(import.meta.dirname, '../../..');
const manifest = JSON.parse(
  readFileSync(resolve(root, 'plugins/official/shader-doctor/manifest.json'), 'utf8'),
) as { version: string };
const doctorPackage = readFileSync(
  resolve(root, `apps/studio/src/plugins/${DOCTOR}-${manifest.version}.sgplugin.json`),
);

const IMAGE = `precision highp float;
uniform vec3 iResolution;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform sampler2D iChannel2;
void main() {
  vec2 uv = gl_FragCoord.xy / iResolution.xy;
  gl_FragColor = texture2D(iChannel0, uv) + texture2D(iChannel1, uv) + texture2D(iChannel2, uv);
}`;
const BUFFER = `precision highp float;
uniform vec3 iResolution;
uniform sampler2D iChannel0;
void main() { gl_FragColor = texture2D(iChannel0, gl_FragCoord.xy / iResolution.xy) * 0.9; }`;
// 1×1 opaque PNG.
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function project(): { project: ShaderProject } {
  let value = addBuffer(createProject(IMAGE, DEFAULT_VERTEX));
  const buffer = bufferPasses(value)[0]!;
  const image = imagePass(value).id;
  value = {
    ...value,
    passes: value.passes.map((pass) =>
      pass.id === buffer.id ? { ...pass, source: BUFFER } : pass,
    ),
  };
  value = setChannelBinding(value, buffer.id, 0, {
    kind: 'buffer',
    passId: buffer.id,
    feedback: true,
  });
  value = setChannelBinding(value, image, 0, {
    kind: 'buffer',
    passId: buffer.id,
    feedback: false,
  });
  value = setChannelBinding(value, image, 1, { kind: 'texture', slot: 0 });
  value = setChannelBinding(value, image, 2, { kind: 'texture', slot: 1 });
  value = setChannelBinding(value, image, 3, { kind: 'none' });
  return { project: value };
}

const engineCall = (page: Page, script: string) =>
  page.evaluate(
    (body) =>
      new Function('engine', `return ${body}`)(
        (window as any).ng.getComponent(document.querySelector('app-shader-canvas')).engine(),
      ),
    script,
  );

const findings = (page: Page) => page.getByTestId('doctor-finding');
const finding = (page: Page, rule: string, extra = '') =>
  page.locator(`[data-testid="doctor-finding"][data-rule="${rule}"]${extra}`);

test('Shader Doctor: a versioned report from the sandboxed Worker, per target, kept honest', async ({
  page,
}) => {
  const name = `Doctor ${Date.now().toString(36)}`;
  const { project: draft } = project();
  const created = await page.request.post('/api/shaders', {
    data: {
      name,
      fragment: IMAGE,
      vertex: DEFAULT_VERTEX,
      project: draft,
      render: {
        postProcessing: {
          enabled: true,
          effects: [
            {
              type: 'vignette',
              instanceId: 'vignette',
              enabled: true,
              settings: { intensity: 0.4, softness: 0.5, roundness: 1 },
            },
          ],
        },
      },
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { shader } = (await created.json()) as { shader: { id: string } };
  const stored = await page.request.put(`/api/shaders/${shader.id}/textures/0?width=1&height=1`, {
    headers: { 'content-type': 'image/png' },
    data: PIXEL,
  });
  expect(stored.ok(), await stored.text()).toBe(true);
  // The image is stored, but the preview's request for it fails: an unavailable asset.
  await page.route(`**/api/shaders/${shader.id}/textures/0**`, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ status: 404, body: 'gone' })
      : route.continue(),
  );

  // Paused preview. Init scripts also run in the plugin's sandboxed frame, which has no storage.
  await page.addInitScript(() => {
    if (window !== window.top) return;
    localStorage.setItem(
      'shader-studio.preferences',
      JSON.stringify({ paused: true, editorOpen: true }),
    );
  });
  await page.goto('/');
  await page.locator('app-shader-browser .shader-row', { hasText: name }).click();
  await expect(page).toHaveURL(`/shaders/${encodeURIComponent(shader.id)}`);
  await expect.poll(() => engineCall(page, 'engine?.activePasses.length ?? 0')).toBe(2);
  await expect.poll(() => engineCall(page, "engine['textures'].slotState(0)")).toBe('failed');
  // The editor shows Buffer A, so going to a finding's pass is visible.
  await page.getByRole('treeitem', { name: 'Buffer A' }).click();
  await expect(page.getByRole('tab', { name: 'Buffer A', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  // Install from the generated package file; it arrives switched off, with no panel.
  await page.getByTestId('open-plugins').click();
  await expect(page).toHaveURL('/plugins');
  await page.getByTestId('plugin-file').setInputFiles({
    name: `${DOCTOR}.sgplugin.json`,
    mimeType: 'application/json',
    buffer: doctorPackage,
  });
  await expect(page.getByTestId('plugin-review')).toBeVisible();
  await page.getByTestId('plugin-install').click();
  const card = page.getByTestId(`plugin-${DOCTOR}`);
  await expect(card).toBeVisible();
  await expect(page.getByTestId('doctor-panel')).toHaveCount(0);
  const toggle = page.getByTestId(`plugin-enable-${DOCTOR}`).getByRole('switch');
  await toggle.click();
  await expect(toggle).toBeChecked();

  // Studio preview: the failed load and the empty slot, but no post-processing finding.
  const panel = card.getByTestId('doctor-panel');
  await expect(panel).toBeVisible();
  await panel.getByTestId('doctor-run').click();
  await expect(panel.getByTestId('doctor-summary')).toContainText('Shadergrove Studio');
  await expect(panel.getByTestId('doctor-summary')).toContainText('v1');
  await expect(panel.getByTestId('doctor-coverage')).toContainText('source.portability');
  await expect(
    finding(page, 'resources.texture', '[data-severity="warning"][data-coverage="unchecked"]'),
  ).toContainText('slot 0');
  await expect(
    finding(page, 'resources.texture', '[data-severity="warning"][data-coverage="structural"]'),
  ).toContainText('slot 1');
  await expect(finding(page, 'features.post-processing')).toHaveCount(0);
  await expect(finding(page, 'features.feedback')).toHaveCount(0);

  // Wallpaper Engine: the Studio report goes at once, and post-processing is a known unsupported.
  await panel.getByTestId('doctor-target').selectOption('wallpaper-web/v1');
  await expect(panel.getByTestId('doctor-summary')).toContainText('Wallpaper Engine');
  await expect(finding(page, 'features.post-processing', '[data-severity="error"]')).toContainText(
    'Vignette',
  );
  await expect(findings(page).first()).toHaveAttribute('data-rule', 'features.post-processing');

  // A texture change retires the report without a new run.
  const cleared = await page.evaluate(async () => {
    const store = (window as any).ng.getComponent(document.querySelector('app-doctor-panel')).store;
    await store.clearTextureImage(0);
    return { ext: store.channels()[0].ext, notice: store.notice() };
  });
  expect(cleared).toMatchObject({ ext: null });
  await expect(panel.getByTestId('doctor-stale')).toBeVisible();
  await expect(findings(page)).toHaveCount(0);
  await panel.getByTestId('doctor-run').click();
  await expect(finding(page, 'resources.texture', '[data-coverage="structural"]')).toContainText(
    '0, 1',
  );

  // A binding finding takes the user to the pass that holds it, from wherever the editor was.
  await finding(page, 'resources.texture').getByTestId('doctor-show').click();
  await expect(page).toHaveURL(`/shaders/${encodeURIComponent(shader.id)}`);
  await expect(page.getByRole('tab', { name: 'Image', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  // Switched off, the panel is gone; removed, so is the package.
  await page.getByTestId('open-plugins').click();
  await expect(page.getByTestId('doctor-panel')).toBeVisible();
  await toggle.click();
  await expect(page.getByTestId('doctor-panel')).toHaveCount(0);
  await page.getByTestId(`plugin-remove-${DOCTOR}`).click();
  await expect(card).toHaveCount(0);
});
