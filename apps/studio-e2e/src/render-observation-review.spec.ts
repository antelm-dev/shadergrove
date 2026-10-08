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

/**
 * Holds publication of the next real measurement after its GPU work has finished, and can make
 * it fail late instead; the measurement itself is never replaced by a stub value.
 */
async function holdNextPublication(page: Page, failLate = false) {
  await page.evaluate((fail) => {
    const engine = (window as any).ng
      .getComponent(document.querySelector('app-shader-canvas'))
      .engine();
    const original = engine.observePoint.bind(engine);
    (window as any).reviewObservationReady = false;
    engine.observePoint = async (...args: any[]) => {
      engine.observePoint = original;
      const result = await original(...args);
      (window as any).reviewObservationReady = true;
      await new Promise<void>((resolve) => ((window as any).reviewObservationFinish = resolve));
      if (fail) throw new Error('late failure after supersession');
      return result;
    };
  }, failLate);
}

const releaseHeld = (page: Page) => page.evaluate(() => (window as any).reviewObservationFinish());
const heldReady = (page: Page) => page.evaluate(() => (window as any).reviewObservationReady);

const LOOP = `precision highp float;
void main() {
  float acc = 0.0;
  for (int i = 0; i < 4; i++) {
    float inc = float(i) * 0.5;
    acc += inc;
  }
  gl_FragColor = vec4(acc * 0.1, 0.0, 0.0, 1.0);
}`;

test('changing the visit or the pixel while a measurement finishes cannot publish its old result', async ({
  page,
}) => {
  const { panel, section } = await open(page, 'Review visit and pixel supersession', LOOP);
  await choose(section, 'inc');
  for (const change of [
    () => section.locator('.visit').fill('3'),
    async () => {
      await panel.locator('.pixel-x').fill('3');
      await panel.locator('.pixel-x').dispatchEvent('change');
    },
  ]) {
    await holdNextPublication(page);
    await section.locator('.measure').click();
    await expect.poll(() => heldReady(page)).toBe(true);
    await change();
    await releaseHeld(page);
    await expect(section.locator('.cancel-measure')).toHaveCount(0);
    await expect(section.locator('.result')).toHaveCount(0);
    await expect(section.locator('.status')).toHaveText('');
  }
  // The next measurement is the current selection, published with its own place and values.
  await section.locator('.measure').click();
  await expect(section.locator('.result')).toBeVisible();
  await expect(section.locator('.facts')).toContainText('visit 3, pixel 3, 2');
  expect(await section.locator('.raw-value').allTextContents()).toEqual(['1']);
});

test('a late failure of a superseded measurement writes neither an error nor an old result', async ({
  page,
}) => {
  const { section } = await open(
    page,
    'Review late failure supersession',
    `precision highp float;
void main() {
  float first = 3.0;
  vec3 second = vec3(7.0, 8.0, 9.0);
  gl_FragColor = vec4(first * 0.1, second.y * 0.01, 0.0, 1.0);
}`,
  );
  await choose(section, 'first');
  await holdNextPublication(page, true);
  await section.locator('.measure').click();
  await expect.poll(() => heldReady(page)).toBe(true);
  await choose(section, 'second');
  await releaseHeld(page);
  await expect(section.locator('.cancel-measure')).toHaveCount(0);
  await expect(section.locator('.status')).toHaveText('');
  await expect(section.locator('.result')).toHaveCount(0);

  // The slot was not left owned by the old run, and the new result carries its own point's place.
  await section.locator('.measure').click();
  await expect(section.locator('.result')).toBeVisible();
  expect(await section.locator('.raw-value').allTextContents()).toEqual(['7', '8', '9']);
  const option = section.locator('.point-select option:checked');
  const place = /(Image:\d+:\d+)/.exec((await option.textContent()) ?? '')![1];
  await expect(section.locator('.source-identity')).toHaveText(place);
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
  // Plugins is laid over the live preview: software-rendered, it would starve the default-pack
  // seeding the install below waits for, as in the other plugin journeys. Kept across reloads.
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
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
  await expect(page.getByTestId(`plugin-${english}`)).toContainText('version 1.0.7');
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

test('a newer real vec2 measurement survives the old failure and same-texel re-emission', async ({
  page,
}) => {
  // Opening a shader that has no library preview photographs it once, which forces one real live
  // frame unrelated to observation. Let it land before the no-observation baseline below.
  const photographed = page.waitForResponse(
    (response) => response.request().method() === 'PUT' && response.url().includes('/thumbnail'),
  );
  const { panel, section } = await open(
    page,
    'Review vec2 overlapping ownership',
    `precision highp float;
void main() {
  vec2 first = vec2(-2.5, 6.25);
  vec2 second = first * 2.0;
  gl_FragColor = vec4(second * 0.01, 0.0, 1.0);
}`,
  );
  await photographed;
  await choose(section, 'first');
  // Both jobs really draw. Hold only publication so the old catch/finally runs
  // while the newer UI request still owns its controller and measuring state.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).ng.getComponent(document.querySelector('app-shader-canvas')).engine()
            .pendingFrames,
      ),
    )
    .toBe(0);
  const state = () =>
    page.evaluate(() => {
      const engine = (window as any).ng
        .getComponent(document.querySelector('app-shader-canvas'))
        .engine();
      return {
        index: engine.framesDrawn as number,
        time: engine.time as number,
        uniforms: ['iTime', 'iResolution', 'u_timeScale'].map((name) =>
          engine.registry.value(name),
        ),
      };
    });
  const before = await state();
  // Independent no-observation control: two scheduled frames in this settled
  // paused view do not draw or alter the live uniforms.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(await state()).toEqual(before);
  await page.evaluate(() => {
    const engine = (window as any).ng
      .getComponent(document.querySelector('app-shader-canvas'))
      .engine();
    const original = engine.observePoint.bind(engine);
    let calls = 0;
    (window as any).overlapReady = [];
    (window as any).overlapFinish = [];
    engine.observePoint = async (...args: any[]) => {
      const call = calls++;
      const result = await original(...args);
      (window as any).overlapReady[call] = true;
      await new Promise<void>((resolve) => ((window as any).overlapFinish[call] = resolve));
      if (call === 0) throw new Error('old failure while a new result is pending');
      return result;
    };
  });
  await section.locator('.measure').click();
  await expect.poll(() => page.evaluate(() => (window as any).overlapReady[0])).toBe(true);
  await choose(section, 'second');
  await section.locator('.measure').click();
  await expect.poll(() => page.evaluate(() => (window as any).overlapReady[1])).toBe(true);
  // Re-emitting an unchanged drawing-buffer coordinate must not supersede it.
  await panel.locator('.pixel-x').fill('2');
  await panel.locator('.pixel-x').dispatchEvent('change');
  await page.evaluate(() => (window as any).overlapFinish[0]());
  await expect(section.locator('.cancel-measure')).toHaveCount(1);
  await expect(section.locator('.status')).toHaveText('Measuring on the GPU…');
  await expect(section.locator('.result')).toHaveCount(0);
  await page.evaluate(() => (window as any).overlapFinish[1]());
  await expect(section.locator('.result')).toBeVisible();
  expect(await section.locator('.raw-value').allTextContents()).toEqual(['-5', '12.5']);
  await expect(section.locator('.facts')).toContainText('vec2');
  await expect(section.locator('.facts')).toContainText('visit 1, pixel 2, 2');
  await expect(section.locator('.source-identity')).toHaveText('Image:4:8');
  await expect(section.locator('.label .badge').nth(1)).toHaveText('Output verified');
  // Unlike normalization by an observed frame index, this rejects any extra
  // live frame induced by either observation, as well as uniform/time changes.
  expect(await state()).toEqual(before);
});
