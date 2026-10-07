/// <reference lib="dom" />
// The page's Angular debug API (`window.ng`) and the engine behind it are untyped here.
/* oxlint-disable typescript/no-explicit-any */
import type { Locator, Page } from '@playwright/test';
import {
  DEFAULT_VERTEX,
  addBuffer,
  addFile,
  bufferPasses,
  commonPass,
  createProject,
  imagePass,
  setChannelBinding,
  setFileSource,
  setPassResolution,
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

  // A paused preview still draws the frames it owes after a layout change, and opening the panel is
  // one. Let those finish first, so that only captures advance the buffer from here on.
  const panel = await openInspection(page);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).ng.getComponent(document.querySelector('app-shader-canvas')).engine()
            .pendingFrames,
      ),
    )
    .toBe(0);

  // The control: with no observation, each live frame drawn advances the buffer by exactly one
  // step. The frame index counts those frames, so a redraw the paused preview owes cannot skew it.
  const control = await page.evaluate(async () => {
    const engine = (window as any).ng
      .getComponent(document.querySelector('app-shader-canvas'))
      .engine();
    const read = async () => {
      const snapshot = await engine.captureFrame();
      const value = snapshot.pixel(snapshot.passes[0].output.rawImageId, 0, 0)[0] as number;
      const index = snapshot.frame.index as number;
      snapshot.release();
      return { value, index };
    };
    const first = await read();
    return { first, second: await read() };
  });
  expect(control.second.index).toBeGreaterThan(control.first.index);
  const step =
    (control.second.value - control.first.value) / (control.second.index - control.first.index);
  expect(step).toBe(1.5);

  await panel.locator('.capture').click();
  await expect(panel.locator('.badge').first()).toBeVisible();
  const section = panel.locator('app-render-observation');
  await section.locator('.find').click();
  await expect(section.locator('.point-select')).toBeVisible();
  const before = await page.evaluate(() => {
    const snapshot = (window as any).ng
      .getComponent(document.querySelector('app-shader-canvas'))
      .engine().capturedFrame;
    return {
      value: snapshot.pixel(snapshot.passes[0].output.rawImageId, 0, 0)[0] as number,
      index: snapshot.frame.index as number,
    };
  });
  // `seen` is in the Image pass (the second), and is twice the captured buffer value.
  await panel.locator('.pass-select').selectOption({ index: 1 });
  await pick(panel, 0, 0);
  await section.locator('.find').click();
  await choose(section, 'seen');
  await measure(section);
  expect(await values(section)).toEqual([before.value * 2]);
  await expect(section.locator('.label .badge').nth(1)).toHaveText('Output verified');

  await panel.locator('.release').click();
  const after = await page.evaluate(async () => {
    const engine = (window as any).ng
      .getComponent(document.querySelector('app-shader-canvas'))
      .engine();
    const snapshot = await engine.captureFrame();
    const value = snapshot.pixel(snapshot.passes[0].output.rawImageId, 0, 0)[0] as number;
    const index = snapshot.frame.index as number;
    snapshot.release();
    return { value, index };
  });
  // Observing neither advanced, replaced nor re-ran the live buffer: it moved one step per live
  // frame drawn, exactly as in the control.
  expect(after.index).toBeGreaterThan(before.index);
  expect(after.value - before.value).toBe(step * (after.index - before.index));
});

test('a live frame drawn while the observation yields between readback bands stays out of its target', async ({
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
  await open(page, 'Observe live frame between bands', project, 2);
  const { panel, section } = await captureAndFind(page);
  await panel.locator('.pass-select').selectOption({ index: 1 });
  await section.locator('.find').click();
  await choose(section, 'seen');
  await pick(panel, 1, 1);
  // A paused preview that owes a frame (any layout or control change asks for one) draws it on
  // the next animation frame, which can land in any macrotask the observation yields to between
  // readback bands. Draw exactly that real live frame right after the first band is read.
  // Frames the paused preview still owes from loading are drawn by its own loop at any time, so
  // count only the frame drawn here: exactly one.
  await page.evaluate(() => {
    const engine = (window as any).ng
      .getComponent(document.querySelector('app-shader-canvas'))
      .engine();
    const renderer = engine.context.renderer;
    const read = renderer.readRenderTargetPixels.bind(renderer);
    let drawn = false;
    renderer.readRenderTargetPixels = (...args: unknown[]) => {
      read(...args);
      if (!drawn && engine.observing) {
        drawn = true;
        renderer.readRenderTargetPixels = read;
        const before = engine.framesDrawn;
        engine.requestFrames(1);
        engine.tick();
        (window as any).__injectedFrames = engine.framesDrawn - before;
      }
    };
  });
  await measure(section);
  expect(await page.evaluate(() => (window as any).__injectedFrames)).toBe(1);
  // The frozen inputs and the frozen reference are unchanged; only a live frame was drawn.
  await expect(section.locator('.label .badge').nth(1)).toHaveText('Output verified');
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

test('measures the accepted program, not the broken draft, after a failed edit', async ({
  page,
}) => {
  await open(page, 'Observe failed edit', single(), 1);
  await page.locator('.monaco-editor').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\nvoid broken( {');
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const snapshot = await (window as any).ng
          .getComponent(document.querySelector('app-shader-canvas'))
          .engine()
          .captureFrame();
        const stale = snapshot.passes[0].accepted.stale as boolean;
        snapshot.release();
        return stale;
      }),
    )
    .toBe(true);

  const { panel, section } = await captureAndFind(page);
  expect(
    await page.evaluate(`${engineOf}.capturedFrame.passes[0].accepted.fragment.includes('broken')`),
  ).toBe(false);
  await pick(panel, 4, 4);
  await choose(section, 'once');
  await measure(section);
  expect(await values(section)).toEqual([1]);
  await expect(section.locator('.label .badge').nth(1)).toHaveText('Output verified');
});

/** Common includes outer.glsl, which includes inner.glsl: three documents plus the pass itself. */
function documentsProject(): ShaderProject {
  let project = addFile(addFile(single(), 'outer.glsl'), 'inner.glsl');
  const [outer, inner] = project.files;
  project = setFileSource(
    project,
    inner.id,
    'float fromInner(float x) {\n  float inInner = x * 2.0;\n  return inInner;\n}\n',
  );
  project = setFileSource(
    project,
    outer.id,
    '#include "inner.glsl"\nfloat fromOuter(float x) {\n  float inOuter = fromInner(x) + 1.0;\n  return inOuter;\n}\n',
  );
  project = setPassSource(
    project,
    commonPass(project)!.id,
    '#include "outer.glsl"\n#define GAIN 3.0\nfloat fromCommon(float x) {\n  float inCommon = fromOuter(x) + 3.0;\n  return inCommon;\n}\n',
  );
  return setPassSource(
    project,
    imagePass(project).id,
    `precision highp float;
uniform vec2 iResolution;
void main() {
  float viaImage = fromCommon(iResolution.x);
  float gained = GAIN * 2.0;
  float level = 2.0;
  {
    float level = 9.0;
    viaImage += level;
  }
  gl_FragColor = vec4((viaImage + gained + level) * 0.0001, 0.0, 0.0, 1.0);
}`,
  );
}

test('maps points in the pass, Common and nested includes, and does not offer a macro-rewritten line', async ({
  page,
}) => {
  await open(page, 'Observe documents', documentsProject(), 1);
  const { panel, section } = await captureAndFind(page);
  await pick(panel, 1, 1);
  const { width } = await drawingBuffer(page);
  // `gained` sits on a line a #define rewrote: refused at the caller, never offered or measured.
  await expect(section.locator('.point-select option', { hasText: /^\s*gained ·/ })).toHaveCount(0);
  await expect(section.locator('.status')).toContainText('candidate(s) not offered');

  const expected: Record<string, { place: string; value: number }> = {
    inInner: { place: 'inner.glsl:2:9', value: width * 2 },
    inOuter: { place: 'outer.glsl:3:9', value: width * 2 + 1 },
    inCommon: { place: 'Common:4:9', value: width * 2 + 4 },
    viaImage: { place: 'Image:4:9', value: width * 2 + 4 },
  };
  for (const [name, { place, value }] of Object.entries(expected)) {
    await choose(section, name);
    await measure(section);
    await expect(section.locator('.source-identity')).toHaveText(place);
    expect(await values(section)).toEqual([value]);
    await expect(section.locator('.label .badge').nth(1)).toHaveText('Output verified');
  }
});

test('offers a shadowing variable only at its own place, with its own value', async ({ page }) => {
  await open(page, 'Observe shadowing', documentsProject(), 1);
  const { panel, section } = await captureAndFind(page);
  await pick(panel, 1, 1);
  const options = section.locator('.point-select option', { hasText: /^\s*level ·/ });
  // Either both declarations are refused or each is measured as itself; never one as the other.
  const offered = await options.count();
  expect([0, 2]).toContain(offered);
  for (let index = 0; index < offered; index++) {
    const option = options.nth(index);
    const place = /(Image:\d+:\d+)/.exec((await option.textContent()) ?? '')![1];
    await section.locator('.point-select').selectOption((await option.getAttribute('value'))!);
    await measure(section);
    await expect(section.locator('.source-identity')).toHaveText(place);
    expect(await values(section)).toEqual([place === 'Image:6:9' ? 2 : 9]);
  }
});

test('observes a scaled pass at its own pixel coordinates from the frozen current and previous inputs', async ({
  page,
}) => {
  let project = addBuffer(addBuffer(single()));
  const [a, b] = bufferPasses(project);
  project = setPassSource(
    project,
    a.id,
    `precision highp float;
uniform vec2 iResolution;
uniform sampler2D iChannel0;
void main() {
  vec4 previous = texture(iChannel0, gl_FragCoord.xy / iResolution.xy);
  gl_FragColor = vec4(previous.r + 1.5, 0.0, 0.0, 1.0);
}`,
  );
  project = setPassSource(
    project,
    b.id,
    `precision highp float;
uniform vec2 iResolution;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
void main() {
  vec2 uv = gl_FragCoord.xy / iResolution.xy;
  vec3 probe = vec3(gl_FragCoord.x, texture(iChannel0, uv).r, texture(iChannel1, uv).r);
  gl_FragColor = vec4(probe.x, probe.y, probe.z + 1.0, 1.0);
}`,
  );
  project = setChannelBinding(project, a.id, 0, { kind: 'buffer', passId: a.id, feedback: true });
  project = setChannelBinding(project, b.id, 0, { kind: 'buffer', passId: a.id, feedback: false });
  project = setChannelBinding(project, b.id, 1, { kind: 'buffer', passId: b.id, feedback: true });
  project = setPassResolution(project, b.id, { mode: 'scaled', scale: 0.5 });
  await open(page, 'Observe scaled', project, 3);

  const { panel, section } = await captureAndFind(page);
  // Passes run A, B, Image: B is the second.
  await panel.locator('.pass-select').selectOption({ index: 1 });
  const frozen = await page.evaluate(() => {
    const snapshot = (window as any).ng
      .getComponent(document.querySelector('app-shader-canvas'))
      .engine().capturedFrame;
    const pass = snapshot.passes[1];
    const size = snapshot.image(pass.output.rawImageId) as { width: number; height: number };
    return {
      size,
      current: snapshot.pixel(pass.inputs[0].imageId, 0, 0)[0] as number,
    };
  });
  const frozenPrevious = (x: number, y: number) =>
    page.evaluate(
      ([px, py]) => {
        const snapshot = (window as any).ng
          .getComponent(document.querySelector('app-shader-canvas'))
          .engine().capturedFrame;
        return snapshot.pixel(snapshot.passes[1].inputs[1].imageId, px, py)[0] as number;
      },
      [x, y],
    );
  const full = await drawingBuffer(page);
  expect(frozen.size.width).toBe(Math.floor(full.width * 0.5));
  await section.locator('.find').click();
  await choose(section, 'probe');

  for (const [x, y] of [
    [3, 2],
    [frozen.size.width - 1, frozen.size.height - 1],
  ]) {
    await pick(panel, x, y);
    await measure(section);
    // gl_FragCoord is the scaled target's own centre; the inputs are the captured frame's, not live ones.
    expect(await values(section)).toEqual([x + 0.5, frozen.current, await frozenPrevious(x, y)]);
    await expect(section.locator('.label .badge').nth(1)).toHaveText('Output verified');
  }
});

test('does not trust a value when the preserved output differs numerically from its reference', async ({
  page,
}) => {
  await open(page, 'Observe mismatch', single(), 1);
  const { panel, section } = await captureAndFind(page);
  await pick(panel, 4, 4);
  await choose(section, 'once');
  // Corrupt the frozen reference with a finite offset; the real instrumented draw is unchanged.
  await page.evaluate(() => {
    const snapshot = (window as any).ng
      .getComponent(document.querySelector('app-shader-canvas'))
      .engine().capturedFrame;
    const read = snapshot.read.bind(snapshot);
    snapshot.read = (id: string, region: unknown) => {
      const out = read(id, region);
      return { ...out, data: out.data.map((value: number) => value + 0.5) };
    };
  });
  await measure(section);
  expect(await values(section)).toEqual([1]);
  await expect(section.locator('.label .badge').nth(1)).toHaveText('Not verified');
  await expect(section.locator('.fidelity')).toContainText('Do not trust');
  await expect(section.locator('.fidelity')).toContainText('texel(s) differently');
  await expect(section.locator('.result')).toHaveClass(/distrusted/);
});

/**
 * A buffer side whose capture fits in 128 MiB on its own. The Image pass then reads that buffer
 * through four channels, so the observer's float target, input textures and band readbacks
 * together push the combined footprint over the limit.
 */
const BUDGET_SIDE = 1560;

test('refuses an observation that would exceed the combined capture and observer budget, and cleans up', async ({
  page,
}) => {
  let project = addBuffer(single());
  const [a] = bufferPasses(project);
  project = setPassSource(
    project,
    a.id,
    `precision highp float;
void main() {
  gl_FragColor = vec4(gl_FragCoord.xy * 0.001, 0.5, 1.0);
}`,
  );
  project = setPassResolution(project, a.id, {
    mode: 'fixed',
    width: BUDGET_SIDE,
    height: BUDGET_SIDE,
  });
  const image = imagePass(project);
  project = setPassSource(
    project,
    image.id,
    `precision highp float;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform sampler2D iChannel2;
uniform sampler2D iChannel3;
void main() {
  vec2 uv = gl_FragCoord.xy / vec2(1280.0, 720.0);
  vec4 blend = texture(iChannel0, uv) + texture(iChannel1, uv) + texture(iChannel2, uv) + texture(iChannel3, uv);
  gl_FragColor = vec4(blend.rgb * 0.25, 1.0);
}`,
  );
  for (const slot of [0, 1, 2, 3] as const) {
    project = setChannelBinding(project, image.id, slot, {
      kind: 'buffer',
      passId: a.id,
      feedback: false,
    });
  }
  await open(page, 'Observe budget', project, 2);

  const { panel, section } = await captureAndFind(page);
  // The capture fit the budget on its own; the observer does not fit beside it.
  const retained = (await page.evaluate(`${engineOf}.capturedFrame.bytes`)) as number;
  expect(retained).toBeLessThanOrEqual(128 * 1024 * 1024);
  await pick(panel, 5, 5);
  await choose(section, 'blend');
  const memory = () =>
    page.evaluate(() => {
      const info = (window as any).ng
        .getComponent(document.querySelector('app-shader-canvas'))
        .engine().context.renderer.info.memory;
      return { textures: info.textures as number, geometries: info.geometries as number };
    });
  const before = await memory();
  await section.locator('.visit').fill('1');
  await section.locator('.measure').click();
  await expect(section.locator('.status')).toContainText('The measurement was refused');
  await expect(section.locator('.status')).toContainText('downsampl');
  await expect(section.locator('.result')).toHaveCount(0);
  await expect(section.locator('.measure')).toBeVisible();
  expect(await page.evaluate(`${engineOf}.observing`)).toBe(false);
  expect(await memory()).toEqual(before);
  // The capture itself is untouched and still measurable on a pass that fits.
  expect(await page.evaluate(`${engineOf}.capturedFrame !== null`)).toBe(true);
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

for (const composer of [false, true]) {
  test(`live frames drawn at the observation's yields reach the canvas with live state${composer ? ' through the post-processing composer' : ''}`, async ({
    page,
  }) => {
    await open(page, `Observe yields ${composer ? 'composer' : 'plain'}`, single(), 1);
    if (composer) {
      // The canvas applies the draft's settings once; these stay until the draft changes.
      await expect
        .poll(() =>
          page.evaluate(() => {
            const engine = (window as any).ng
              .getComponent(document.querySelector('app-shader-canvas'))
              .engine();
            engine.setRenderSettings({
              postProcessing: {
                enabled: true,
                effects: [
                  {
                    type: 'vignette',
                    instanceId: 'vignette',
                    enabled: true,
                    settings: { intensity: 1, softness: 0.5, roundness: 1 },
                  },
                ],
              },
            });
            return engine.post.usesComposer() as boolean;
          }),
        )
        .toBe(true);
    }
    const { panel, section } = await captureAndFind(page);
    const { width, height } = await drawingBuffer(page);
    const [x, y] = [3, 5];
    await pick(panel, x, y);
    await choose(section, 'hdr');

    // After every observer readback, schedule one real live frame on a macrotask. The
    // observation yields right after each readback, so each frame lands inside a yield.
    await page.evaluate(() => {
      const engine = (window as any).ng
        .getComponent(document.querySelector('app-shader-canvas'))
        .engine();
      const renderer = engine.context.renderer;
      const T = engine.context.three;
      const colour = new T.Color();
      const state = () => ({
        target: renderer.getRenderTarget(),
        colour: renderer.getClearColor(colour).getHex(),
        alpha: renderer.getClearAlpha(),
      });
      const live = state();
      const observerTargets = new Set<unknown>();
      const record: any = {
        live: { colour: live.colour, alpha: live.alpha, canvas: live.target === null },
        yields: [] as any[],
        renders: [] as any[],
        frameDeltas: [] as number[],
      };
      (window as any).__yieldRecord = record;
      const read = renderer.readRenderTargetPixels.bind(renderer);
      const render = renderer.render.bind(renderer);
      let inLive = false;
      renderer.render = (scene: unknown, camera: unknown) => {
        if (inLive) {
          const now = state();
          record.renders.push({
            observerTarget: observerTargets.has(now.target),
            canvas: now.target === null,
            colour: now.colour,
            alpha: now.alpha,
          });
        }
        return render(scene, camera);
      };
      renderer.readRenderTargetPixels = (...args: any[]) => {
        read(...args);
        if (!engine.observing) return;
        observerTargets.add(args[0]);
        setTimeout(() => {
          if (!engine.observing) return;
          const now = state();
          record.yields.push({
            observerTarget: observerTargets.has(now.target),
            target: now.target === live.target,
            colour: now.colour,
            alpha: now.alpha,
            composer: engine.post.usesComposer(),
          });
          record.renders.push('frame');
          const drawn = engine.framesDrawn;
          inLive = true;
          try {
            engine.requestFrames(1);
            engine.tick();
          } finally {
            inLive = false;
          }
          record.frameDeltas.push(engine.framesDrawn - drawn);
        }, 0);
      };
    });
    await measure(section);

    const [r, g, b] = await values(section);
    expect(r).toBeCloseTo(((x + 0.5) / width) * 4 - 2, 4);
    expect(g).toBeCloseTo(((y + 0.5) / height) * 8, 4);
    expect(b).toBe(-0.5);
    await expect(section.locator('.label .badge').nth(1)).toHaveText('Output verified');

    const record = await page.evaluate(() => (window as any).__yieldRecord);
    expect(record.live.canvas).toBe(true);
    // Every band, the hit and the value readback were each followed by a live frame in a yield.
    expect(record.yields.length).toBeGreaterThanOrEqual(3);
    // Each injected tick drew exactly one real frame (owed frames the paused preview draws on its
    // own are extra live frames, not counted here).
    expect(record.frameDeltas).toEqual(record.yields.map(() => 1));
    for (const at of record.yields) {
      expect(at).toEqual({
        observerTarget: false,
        target: true,
        colour: record.live.colour,
        alpha: record.live.alpha,
        composer,
      });
    }
    // Each live frame drew with the live clear colour, never into an observer target, and its
    // last draw went to the canvas.
    const frames: any[][] = [];
    for (const entry of record.renders) {
      if (entry === 'frame') frames.push([]);
      else frames.at(-1)!.push(entry);
    }
    expect(frames).toHaveLength(record.yields.length);
    for (const draws of frames) {
      expect(draws.length).toBeGreaterThan(0);
      for (const draw of draws) {
        expect(draw.observerTarget).toBe(false);
        expect([draw.colour, draw.alpha]).toEqual([record.live.colour, record.live.alpha]);
      }
      expect(draws.at(-1).canvas).toBe(true);
    }
  });
}
