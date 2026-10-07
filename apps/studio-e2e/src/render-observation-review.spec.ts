/// <reference lib="dom" />
/* oxlint-disable typescript/no-explicit-any */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Locator, Page } from '@playwright/test';
import {
  DEFAULT_VERTEX,
  addBuffer,
  bufferPasses,
  createProject,
  imagePass,
  setChannelBinding,
  setPassSource,
} from '@shadergrove/shared/project';
import { expect, test } from './fixtures';

test.describe.configure({ timeout: 180_000 });

async function open(page: Page, name: string, fragment: string, withBuffer = false) {
  let project = createProject(fragment, DEFAULT_VERTEX);
  if (withBuffer) {
    project = addBuffer(project);
    const [buffer] = bufferPasses(project);
    project = setPassSource(
      project,
      buffer.id,
      'precision highp float; uniform vec2 iResolution; void main() { gl_FragColor = vec4(gl_FragCoord.xy / iResolution.xy, 0.25, 1.0); }',
    );
    project = setChannelBinding(project, imagePass(project).id, 0, {
      kind: 'buffer',
      passId: buffer.id,
      feedback: false,
    });
  }
  const response = await page.request.post('/api/shaders', {
    data: { name, fragment, vertex: DEFAULT_VERTEX, project },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const { shader } = (await response.json()) as { shader: { id: string } };
  await page.addInitScript(() =>
    localStorage.setItem(
      'shader-studio.preferences',
      JSON.stringify({ paused: true, editorOpen: true }),
    ),
  );
  await page.goto('/');
  await page.locator('app-shader-browser .shader-row', { hasText: name }).click();
  await expect(page).toHaveURL(`/shaders/${encodeURIComponent(shader.id)}`);
  await expect(page.locator('app-shader-canvas')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).ng.getComponent(document.querySelector('app-shader-canvas')).engine()
            ?.activePasses.length ?? 0,
      ),
    )
    .toBe(withBuffer ? 2 : 1);
  await page.keyboard.press('Control+j');
  await page.locator('#bottom-panel-tab-inspection').click();
  const panel = page.locator('app-render-inspection-panel');
  await panel.locator('.capture').click();
  const section = panel.locator('app-render-observation');
  await section.locator('.find').click();
  await expect(section.locator('.point-select')).toBeVisible();
  for (const axis of ['x', 'y']) {
    await panel.locator(`.pixel-${axis}`).fill('2');
    await panel.locator(`.pixel-${axis}`).dispatchEvent('change');
  }
  return { panel, section };
}

async function choose(section: Locator, name: string) {
  const option = section.locator('.point-select option', {
    hasText: new RegExp(`^\\s*${name} ·`),
  });
  await expect(option).toHaveCount(1);
  await section.locator('.point-select').selectOption((await option.getAttribute('value'))!);
}

test('changing the point while a measurement finishes cannot relabel or publish its old result', async ({
  page,
}) => {
  const { section } = await open(
    page,
    'Review observation supersession',
    `precision highp float;
void main() {
  float first = 3.0;
  vec3 second = vec3(7.0, 8.0, 9.0);
  gl_FragColor = vec4(first * 0.1, second.y * 0.01, 0.0, 1.0);
}`,
  );
  await choose(section, 'first');
  // Delay publication after the real GPU operation finishes. This uses the
  // existing Angular debug seam and keeps the actual measurement intact.
  await page.evaluate(() => {
    const engine = (window as any).ng
      .getComponent(document.querySelector('app-shader-canvas'))
      .engine();
    const original = engine.observePoint.bind(engine);
    engine.observePoint = async (...args: any[]) => {
      const result = await original(...args);
      (window as any).reviewObservationReady = true;
      await new Promise<void>((resolve) => ((window as any).reviewObservationFinish = resolve));
      return result;
    };
  });
  await section.locator('.measure').click();
  await expect.poll(() => page.evaluate(() => (window as any).reviewObservationReady)).toBe(true);
  await choose(section, 'second');
  await page.evaluate(() => (window as any).reviewObservationFinish());
  await expect(section.locator('.cancel-measure')).toHaveCount(0);
  await expect(section.locator('.result')).toHaveCount(0);
});

test('a skipped nonfinite output comparison must stay unverified instead of certifying output', async ({
  page,
}) => {
  const { section } = await open(
    page,
    'Review observation nonfinite trust',
    `precision highp float;
void main() {
  float special = exp(gl_FragCoord.x * 1000.0);
  gl_FragColor = vec4(special, 0.0, 0.0, 1.0);
}`,
  );
  // Establish a real nonfinite value in the immutable raw reference on this actual driver.
  expect(
    await page.evaluate(() => {
      const snapshot = (window as any).ng
        .getComponent(document.querySelector('app-shader-canvas'))
        .engine().capturedFrame;
      return !Number.isFinite(snapshot.pixel(snapshot.passes[0].output.rawImageId, 2, 2)[0]);
    }),
  ).toBe(true);
  await choose(section, 'special');
  await section.locator('.measure').click();
  await expect(section.locator('.result')).toBeVisible();
  await expect(section.locator('.raw-value')).toHaveText('+Infinity');
  await expect(section.locator('.result')).toContainText('could not be compared numerically');
  await expect(section.locator('.label .badge').nth(1)).toHaveText('Not verified');
});

test('an installed English upgrade preserves language and full-viewport derivative and sampler observation', async ({
  page,
}) => {
  const english = 'dev.shadergrove.language-en';
  const old = readFileSync(
    resolve(import.meta.dirname, 'review-fixtures/language-en-pre-observation-1.0.2.sgplugin.json'),
  );
  await page.goto('/');
  await expect(page.locator('mat-toolbar.toolbar')).toBeVisible();
  await page.getByTestId('open-plugins').click();
  await page.getByTestId('plugin-file').setInputFiles({
    name: 'language-en-pre-observation-1.0.2.sgplugin.json',
    mimeType: 'application/json',
    buffer: old,
  });
  await page.getByTestId('plugin-install').click();
  const toggle = page.getByTestId(`plugin-enable-${english}`).getByRole('switch');
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  // English is already the selected installed language; its action is hidden.
  await page.reload();
  await expect(toggle).toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.getByTestId(`install-available-${english}`).click();
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(page.getByTestId(`plugin-${english}`)).toContainText('version 1.0.3');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  const { section } = await open(
    page,
    'Review full viewport observation',
    `precision highp float;
uniform vec2 iResolution;
uniform sampler2D iChannel0;
void main() {
  vec2 uv = gl_FragCoord.xy / iResolution.xy;
  vec4 sampled = texture(iChannel0, uv);
  vec4 probe = vec4(dFdx(uv.x), dFdy(uv.y), sampled.r, sampled.g);
  gl_FragColor = vec4(probe.xy * 0.5 + probe.zw * 0.1, 0.0, 1.0);
}`,
    true,
  );
  await choose(section, 'probe');
  await section.locator('.measure').click();
  await expect(section.locator('.result')).toBeVisible();
  const actual = (await section.locator('.raw-value').allTextContents()).map(Number);
  const size = await page.evaluate(() => {
    const snapshot = (window as any).ng
      .getComponent(document.querySelector('app-shader-canvas'))
      .engine().capturedFrame;
    return snapshot.passes.at(-1).resolution as { width: number; height: number };
  });
  expect(actual).toHaveLength(4);
  expect(actual[0]).toBeCloseTo(1 / size.width, 6);
  expect(actual[1]).toBeCloseTo(1 / size.height, 6);
  expect(actual[2]).toBeCloseTo(2.5 / size.width, 3);
  expect(actual[3]).toBeCloseTo(2.5 / size.height, 3);
  await expect(section.locator('.label .badge').nth(1)).toHaveText('Output verified');
});
