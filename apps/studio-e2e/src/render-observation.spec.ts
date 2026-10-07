/// <reference lib="dom" />
// The page's Angular debug API (`window.ng`) and the engine behind it are untyped here.
/* oxlint-disable typescript/no-explicit-any */
import type { Locator, Page } from '@playwright/test';
import {
  DEFAULT_VERTEX,
  addBuffer,
  addFile,
  bufferPasses,
  createProject,
  imagePass,
  setChannelBinding,
  setFileSource,
  setPassSource,
  type ShaderProject,
} from '@shadergrove/shared/project';
import { expect, test } from './fixtures';

/**
 * One frozen GPU variable measurement against a real GPU: the value is read from
 * a modified copy of the captured accepted program, held against the unmodified
 * frozen replay, and refused (never faked) when it cannot be exact.
 */

test.describe.configure({ timeout: 180_000 });

const IMAGE = `precision highp float;
uniform vec2 iResolution;
float g = 0.0;
float bump() {
  g += 1.0;
  return g;
}
void main() {
  vec2 uv = gl_FragCoord.xy / iResolution.xy;
  vec3 hdr = vec3(uv.x * 4.0 - 2.0, uv.y * 8.0, -0.5);
  float once = bump();
  float acc = 0.0;
  for (int i = 0; i < 4; i++) {
    float inc = float(i) * 0.5;
    acc += inc;
  }
  if (uv.x < -1.0) {
    float never = 7.0;
    acc += never;
  }
  if (uv.x > 0.75) discard;
  gl_FragColor = vec4(hdr * 0.1 + vec3(acc * 0.0), once * 0.25 + g * 0.125);
}`;

async function open(page: Page, name: string, project: ShaderProject, passes: number) {
  const response = await page.request.post('/api/shaders', {
    data: { name, fragment: IMAGE, vertex: DEFAULT_VERTEX, project },
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
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).ng.getComponent(document.querySelector('app-shader-canvas')).engine()
            ?.activePasses.length ?? 0,
      ),
    )
    .toBe(passes);
}

const single = () => createProject(IMAGE, DEFAULT_VERTEX);

/** Ctrl+J is the workspace's own bottom-panel shortcut; the tab is the panel's own control. */
async function openInspection(page: Page) {
  await page.keyboard.press('Control+j');
  await page.locator('#bottom-panel-tab-inspection').click();
  const panel = page.locator('app-render-inspection-panel');
  await expect(panel.locator('.capture')).toBeVisible();
  return panel;
}

async function pick(panel: Locator, x: number, y: number) {
  await panel.locator('.pixel-x').fill(String(x));
  await panel.locator('.pixel-x').dispatchEvent('change');
  await panel.locator('.pixel-y').fill(String(y));
  await panel.locator('.pixel-y').dispatchEvent('change');
}

const engineOf = `(window).ng.getComponent(document.querySelector('app-shader-canvas')).engine()`;

const drawingBuffer = (page: Page) =>
  page.evaluate(
    () =>
      (window as any).ng.getComponent(document.querySelector('app-shader-canvas')).engine()
        .capturedFrame.frame.drawingBuffer as { width: number; height: number },
  );

/** Captures through the real UI and finds the variables of the selected pass. */
async function captureAndFind(page: Page) {
  const panel = await openInspection(page);
  await panel.locator('.capture').click();
  await expect(panel.locator('.badge').first()).toBeVisible();
  const section = panel.locator('app-render-observation');
  await section.locator('.find').click();
  await expect(section.locator('.point-select')).toBeVisible();
  return { panel, section };
}

async function choose(section: Locator, name: string) {
  const option = section.locator('.point-select option', {
    hasText: new RegExp(`^\\s*${name} ·`),
  });
  await expect(option).toHaveCount(1);
  await section.locator('.point-select').selectOption((await option.getAttribute('value'))!);
}

async function measure(section: Locator, visit = 1) {
  await section.locator('.visit').fill(String(visit));
  await section.locator('.measure').click();
  await expect(section.locator('.result')).toBeVisible();
}

const values = async (section: Locator) =>
  (await section.locator('.raw-value').allTextContents()).map(Number);

test('measures a vec3 with negative and HDR components, labelled as a modified-program measurement', async ({
  page,
}) => {
  await open(page, 'Observe vec3', single(), 1);
  const { panel, section } = await captureAndFind(page);
  const { width, height } = await drawingBuffer(page);
  const [x, y] = [3, 5];
  await pick(panel, x, y);
  await choose(section, 'hdr');
  await measure(section);

  const [r, g, b] = await values(section);
  expect(r).toBeCloseTo(((x + 0.5) / width) * 4 - 2, 4);
  expect(r).toBeLessThan(0);
  expect(g).toBeCloseTo(((y + 0.5) / height) * 8, 4);
  expect(b).toBe(-0.5);
  await expect(section.locator('.flag').first()).toBeVisible();
  await expect(section.locator('.label .badge').first()).toHaveText('Modified-program measurement');
  await expect(section.locator('.fidelity')).toContainText('matches the original');
  await expect(section.locator('.label .badge').nth(1)).toHaveText('Output verified');
  await expect(section.locator('.availability')).toHaveText('Available');
  await expect(section.locator('.source-identity')).toHaveText(/^Image.*:\d+:\d+$|:\d+:\d+$/);
  await expect(section.locator('.fidelity')).toContainText('matches the original');
  await expect(section.locator('.facts')).toContainText('highp');
  await expect(section.locator('.facts')).toContainText('vec3');
});

test('selects the nth visit of a loop statement, and an unvisited visit is unavailable, not zero', async ({
  page,
}) => {
  await open(page, 'Observe visits', single(), 1);
  const { panel, section } = await captureAndFind(page);
  await pick(panel, 2, 2);
  await choose(section, 'inc');

  await measure(section, 1);
  expect(await values(section)).toEqual([0]);
  await expect(section.locator('.availability')).toHaveText('Available');

  await measure(section, 3);
  expect(await values(section)).toEqual([1]);

  // The loop runs four times: visit 5 never happens, which is not the value 0.
  await measure(section, 5);
  await expect(section.locator('.availability')).toContainText('never reached that visit');
  await expect(section.locator('.raw-value')).toHaveCount(0);
});

test('keeps the statement single-evaluation, so the output matches the unmodified replay', async ({
  page,
}) => {
  await open(page, 'Observe side effect', single(), 1);
  const { panel, section } = await captureAndFind(page);
  await pick(panel, 4, 4);
  await choose(section, 'once');
  await measure(section);
  // `bump()` mutates a global and feeds the output: a second evaluation would change both.
  expect(await values(section)).toEqual([1]);
  await expect(section.locator('.label .badge').nth(1)).toHaveText('Output verified');
  await expect(section.locator('.fidelity')).toContainText('matches the original');
  await expect(section.locator('.fidelity')).not.toContainText('Do not trust');
});

test('reports an unreachable statement and a discarded pixel as unavailable', async ({ page }) => {
  await open(page, 'Observe unavailable', single(), 1);
  const { panel, section } = await captureAndFind(page);
  const { width } = await drawingBuffer(page);

  await pick(panel, 2, 2);
  await choose(section, 'never');
  await measure(section);
  await expect(section.locator('.availability')).toContainText('never reached that visit');
  await expect(section.locator('.raw-value')).toHaveCount(0);

  // Right of 75% of the width, the shader discards: no value exists for that pixel at all.
  await pick(panel, width - 3, 2);
  await choose(section, 'hdr');
  await measure(section);
  await expect(section.locator('.availability')).toContainText('was discarded');
  await expect(section.locator('.raw-value')).toHaveCount(0);
});

test('maps a point in an include to its document, line and column', async ({ page }) => {
  let project = addFile(single(), 'lib.glsl');
  project = setFileSource(
    project,
    project.files[0].id,
    'float helper(float x) {\n  float inner = x * 2.0;\n  return inner;\n}\n',
  );
  project = setPassSource(
    project,
    imagePass(project).id,
    `precision highp float;
uniform vec2 iResolution;
#include "lib.glsl"
void main() {
  float shown = helper(iResolution.x);
  gl_FragColor = vec4(shown * 0.0001, 0.0, 0.0, 1.0);
}`,
  );
  await open(page, 'Observe include', project, 1);
  const { panel, section } = await captureAndFind(page);
  await pick(panel, 1, 1);
  await choose(section, 'inner');
  await expect(section.locator('.point-select option', { hasText: 'lib.glsl:2:9' })).toHaveCount(1);
  await measure(section);
  await expect(section.locator('.source-identity')).toHaveText('lib.glsl:2:9');
  const { width } = await drawingBuffer(page);
  expect(await values(section)).toEqual([width * 2]);
});

test('measures from the captured feedback inputs, and leaves the live feedback untouched', async ({
  page,
}) => {
  let project = addBuffer(createProject(IMAGE, DEFAULT_VERTEX));
  const [a] = bufferPasses(project);
  project = setPassSource(
    project,
    a.id,
    `precision highp float;
uniform vec2 iResolution;
uniform sampler2D iChannel0;
void main() {
  vec4 previous = texture2D(iChannel0, gl_FragCoord.xy / iResolution.xy);
  gl_FragColor = vec4(previous.r + 1.5, 0.0, 0.0, 1.0);
}`,
  );
  project = setChannelBinding(project, a.id, 0, { kind: 'buffer', passId: a.id, feedback: true });
  project = setPassSource(
    project,
    imagePass(project).id,
    `precision highp float;
uniform vec2 iResolution;
uniform sampler2D iChannel0;
void main() {
  vec4 fromA = texture2D(iChannel0, gl_FragCoord.xy / iResolution.xy);
  float seen = fromA.r * 2.0;
  gl_FragColor = vec4(seen * 0.001, 0.0, 0.0, 1.0);
}`,
  );
  project = setChannelBinding(project, imagePass(project).id, 0, {
    kind: 'buffer',
    passId: a.id,
    feedback: false,
  });
  await open(page, 'Observe feedback', project, 2);

  // The control: with no observation, each captured frame advances the buffer by exactly one step.
  const control = await page.evaluate(async () => {
    const engine = (window as any).ng
      .getComponent(document.querySelector('app-shader-canvas'))
      .engine();
    const read = async () => {
      const snapshot = await engine.captureFrame();
      const value = snapshot.pixel(snapshot.passes[0].output.rawImageId, 0, 0)[0] as number;
      snapshot.release();
      return value;
    };
    const first = await read();
    return { first, second: await read() };
  });
  expect(control.second - control.first).toBe(1.5);

  const { panel, section } = await captureAndFind(page);
  const before = await page.evaluate(() => {
    const snapshot = (window as any).ng
      .getComponent(document.querySelector('app-shader-canvas'))
      .engine().capturedFrame;
    return snapshot.pixel(snapshot.passes[0].output.rawImageId, 0, 0)[0] as number;
  });
  // `seen` is in the Image pass (the second), and is twice the captured buffer value.
  await panel.locator('.pass-select').selectOption({ index: 1 });
  await pick(panel, 0, 0);
  await section.locator('.find').click();
  await choose(section, 'seen');
  await measure(section);
  expect(await values(section)).toEqual([before * 2]);
  await expect(section.locator('.label .badge').nth(1)).toHaveText('Output verified');

  await panel.locator('.release').click();
  const after = await page.evaluate(async () => {
    const engine = (window as any).ng
      .getComponent(document.querySelector('app-shader-canvas'))
      .engine();
    const snapshot = await engine.captureFrame();
    const value = snapshot.pixel(snapshot.passes[0].output.rawImageId, 0, 0)[0] as number;
    snapshot.release();
    return value;
  });
  // Observing neither advanced, replaced nor re-ran the live buffer.
  expect(after - before).toBe(control.second - control.first);
});

test('cancels when the capture is released or the panel is hidden, and starts no inactive work', async ({
  page,
}) => {
  await open(page, 'Observe lifecycle', single(), 1);
  const { panel, section } = await captureAndFind(page);
  await pick(panel, 2, 2);
  await choose(section, 'once');
  await measure(section);
  await expect(section.locator('.result')).toBeVisible();

  // Hiding the mounted panel releases the capture and the measurement with it; nothing is pending.
  await page.keyboard.press('Control+j');
  expect(await page.evaluate(`${engineOf}.observing`)).toBe(false);
  await page.keyboard.press('Control+j');
  await page.locator('#bottom-panel-tab-inspection').click();
  await expect(panel.locator('.capture')).toBeVisible();
  await expect(section).toHaveCount(0);

  // Releasing a fresh capture takes the variables away with it, too.
  await panel.locator('.capture').click();
  await expect(panel.locator('.release')).toBeVisible();
  await panel.locator('.release').click();
  await expect(panel.locator('.capture')).toBeVisible();
  await expect(section).toHaveCount(0);
  expect(await page.evaluate(`${engineOf}.observing`)).toBe(false);
});

test('refuses, rather than quantizes, on a GPU that cannot read floats back', async ({ page }) => {
  await open(page, 'Observe unsupported', single(), 1);
  const { panel, section } = await captureAndFind(page);
  await pick(panel, 2, 2);
  await choose(section, 'once');
  await page.evaluate(() => {
    const gl = (window as any).ng
      .getComponent(document.querySelector('app-shader-canvas'))
      .engine()
      .context.renderer.getContext();
    // A driver whose float attachment reads back only as bytes would be quantized: it must refuse.
    const original = gl.getParameter.bind(gl);
    gl.getParameter = (name: number) =>
      name === gl.IMPLEMENTATION_COLOR_READ_TYPE ? gl.UNSIGNED_BYTE : original(name);
  });
  await section.locator('.measure').click();
  await expect(section.locator('.status')).toContainText('The measurement was refused');
  await expect(section.locator('.result')).toHaveCount(0);
});

test('ends the measurement when the drawing buffer is resized', async ({ page }) => {
  await open(page, 'Observe resize', single(), 1);
  const { panel, section } = await captureAndFind(page);
  await pick(panel, 2, 2);
  await choose(section, 'once');
  await measure(section);
  await page.setViewportSize({ width: 900, height: 640 });
  await expect(panel.locator('.capture')).toBeVisible();
  await expect(section).toHaveCount(0);
});
