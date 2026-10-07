/// <reference lib="dom" />
// The page's Angular debug API (`window.ng`) and the engine behind it are untyped here.
/* oxlint-disable typescript/no-explicit-any */
import type { Page } from '@playwright/test';
import {
  DEFAULT_VERTEX,
  addBuffer,
  bufferPasses,
  createProject,
  imagePass,
  setChannelBinding,
  setPassResolution,
  setPassSource,
  type ShaderProject,
} from '@shadergrove/shared/project';
import { expect, test } from './fixtures';

/**
 * Frame capture against a real GPU: what a pass sampled, what it wrote, and which
 * program drew it — taken from the live frame, not reconstructed after it.
 *
 * Every value below is exactly representable as a half float (and the buffers are
 * half-float targets), so equality is `toBe`, not "close": a capture that rounded,
 * clamped or read the wrong texture would fail.
 */

test.describe.configure({ timeout: 180_000 });

/** Buffer A accumulates 1.5 a frame, B doubles A and counts up, Image shows B beyond [0, 1]. */
const DECLARE = `precision highp float;
uniform vec2 iResolution;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
`;
const BUFFER_A = `${DECLARE}void main() {
  vec4 previous = texture2D(iChannel0, gl_FragCoord.xy / iResolution.xy);
  gl_FragColor = vec4(previous.r + 1.5, -0.25, 2048.0, 1.0);
}`;
const BUFFER_B = `${DECLARE}void main() {
  vec2 uv = gl_FragCoord.xy / iResolution.xy;
  vec4 fromA = texture2D(iChannel0, uv);
  vec4 previous = texture2D(iChannel1, uv);
  gl_FragColor = vec4(fromA.r * 2.0, previous.r + 1.0, -1.0, 1.0);
}`;
const IMAGE = `${DECLARE}void main() {
  vec4 fromB = texture2D(iChannel0, gl_FragCoord.xy / iResolution.xy);
  gl_FragColor = vec4(fromB.r * 0.5, fromB.g, fromB.b, 1.0);
}`;

function pipeline(
  adjust: (project: ShaderProject, ids: { a: string; b: string }) => ShaderProject,
) {
  let project = addBuffer(addBuffer(createProject(IMAGE, DEFAULT_VERTEX)));
  const [a, b] = bufferPasses(project);
  project = setPassSource(project, a.id, BUFFER_A);
  project = setPassSource(project, b.id, BUFFER_B);
  const own = (pass: string, channel: 0 | 1, target: string, feedback: boolean) =>
    (project = setChannelBinding(project, pass, channel, {
      kind: 'buffer',
      passId: target,
      feedback,
    }));
  own(a.id, 0, a.id, true);
  own(b.id, 0, a.id, false);
  own(b.id, 1, b.id, true);
  own(imagePass(project).id, 0, b.id, false);
  return adjust(project, { a: a.id, b: b.id });
}

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
  return shader.id;
}

test('records what each pass really sampled, wrote and drew, with feedback in render order', async ({
  page,
}) => {
  await open(
    page,
    'Inspect feedback',
    pipeline((project) => project),
    3,
  );

  const frame = await page.evaluate(async () => {
    const engine = (window as any).ng
      .getComponent(document.querySelector('app-shader-canvas'))
      .engine();
    const snapshot = await engine.captureFrame();
    const [a, b, image] = snapshot.passes;
    const pixel = (id: string) => snapshot.pixel(id, 0, 0);
    const result = {
      kinds: snapshot.passes.map((pass: any) => pass.kind),
      aSources: a.inputs.slice(0, 1).map((input: any) => input.source),
      bSources: b.inputs.slice(0, 2).map((input: any) => input.source),
      imageSource: image.inputs[0].source,
      aPrevious: pixel(a.inputs[0].imageId),
      aOutput: pixel(a.output.rawImageId),
      bFromA: pixel(b.inputs[0].imageId),
      bPrevious: pixel(b.inputs[1].imageId),
      bOutput: pixel(b.output.rawImageId),
      imageInput: pixel(image.inputs[0].imageId),
      imageRaw: pixel(image.output.rawImageId),
      display: pixel(image.output.displayImageId),
      // One copy of what A wrote, however many passes read it.
      bAndAShare: b.inputs[0].imageId === a.output.rawImageId,
      imageAndBShare: image.inputs[0].imageId === b.output.rawImageId,
      formats: {
        buffer: snapshot.image(a.output.rawImageId).format,
        raw: snapshot.image(image.output.rawImageId).format,
        display: snapshot.image(image.output.displayImageId).format,
      },
      rawOrigin: image.output.rawOrigin,
      comparison: image.output.comparison,
      identity: snapshot.identity,
      mixed: snapshot.mixedRevisions,
      gl: {
        width: engine.context.canvas.width,
        height: engine.context.canvas.height,
      },
      drawingBuffer: snapshot.frame.drawingBuffer,
    };
    snapshot.release();
    return result;
  });

  expect(frame.kinds).toEqual(['buffer', 'buffer', 'image']);
  expect(frame.aSources).toEqual(['buffer-previous']);
  expect(frame.bSources).toEqual(['buffer-current', 'buffer-previous']);
  expect(frame.imageSource).toBe('buffer-current');

  // A draws previous + 1.5: the previous frame was read before this one overwrote it.
  expect(frame.aOutput).toEqual([frame.aPrevious[0] + 1.5, -0.25, 2048, 1]);
  // B read A's output *of this frame*, and its own previous frame — which doubled
  // A's output of the frame before (A's previous), so history is intact.
  expect(frame.bFromA).toEqual(frame.aOutput);
  expect(frame.bPrevious[0]).toBe(frame.aPrevious[0] * 2);
  expect(frame.bOutput).toEqual([frame.aOutput[0] * 2, frame.bPrevious[0] + 1, -1, 1]);
  expect(frame.imageInput).toEqual(frame.bOutput);
  expect(frame.bAndAShare && frame.imageAndBShare).toBe(true);

  // Raw HDR and negatives survive; the canvas is the transformed 8-bit result.
  expect(frame.imageRaw).toEqual([frame.bOutput[0] * 0.5, frame.bOutput[1], -1, 1]);
  expect(frame.imageRaw[0]).toBeGreaterThan(1);
  expect(frame.display).toEqual([255, 255, 0, 255]);
  expect(frame.formats).toEqual({ buffer: 'rgba16f', raw: 'rgba32f', display: 'rgba8' });

  // The labelled frozen replay of the accepted Image program agrees with the live canvas.
  expect(frame.rawOrigin).toBe('frozen-replay');
  expect(frame.comparison.status).toBe('match');
  expect(frame.comparison.maxDelta).toBeLessThanOrEqual(1);
  expect(frame.drawingBuffer).toEqual({ width: frame.gl.width, height: frame.gl.height });
  expect(frame.mixed).toBe(false);
});

test('capturing leaves the live feedback history exactly as a run without it', async ({ page }) => {
  await open(
    page,
    'Inspect history',
    pipeline((project) => project),
    3,
  );

  const runs = await page.evaluate(async () => {
    const engine = (window as any).ng
      .getComponent(document.querySelector('app-shader-canvas'))
      .engine();
    const take = async () => {
      const snapshot = await engine.captureFrame();
      const a = snapshot.passes[0];
      const taken = {
        index: snapshot.frame.index,
        previous: snapshot.pixel(a.inputs[0].imageId, 0, 0)[0],
        output: snapshot.pixel(a.output.rawImageId, 0, 0)[0],
      };
      snapshot.release();
      return taken;
    };
    const first = await take();
    // Ordinary frames, with no capture anywhere near them.
    engine.requestFrames(5);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const second = await take();
    return { first, second };
  });

  // A adds 1.5 per frame it draws. Counting the engine's frames between the two
  // captures must predict the buffer exactly: the capture added none and skipped none.
  const frames = runs.second.index - runs.first.index;
  expect(frames).toBeGreaterThanOrEqual(1);
  expect(runs.second.output - runs.first.output).toBe(1.5 * frames);
  expect(runs.second.previous).toBe(runs.second.output - 1.5);
});

test('keeps the accepted program, and says so, while a failed draft is pending', async ({
  page,
}) => {
  await open(
    page,
    'Inspect accepted',
    pipeline((project) => project),
    3,
  );
  await page.locator('.monaco-editor').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\nvoid broken( {');

  await expect
    .poll(() =>
      page.evaluate(async () => {
        const engine = (window as any).ng
          .getComponent(document.querySelector('app-shader-canvas'))
          .engine();
        const snapshot = await engine.captureFrame();
        const image = snapshot.passes[2];
        const state = {
          stale: image.accepted.stale,
          draftInSource: image.accepted.fragment.includes('void broken'),
          draftInComposed: image.accepted.composedFragment.includes('void broken'),
          hasAccepted: image.accepted.fragment.includes('fromB'),
          acceptedRevision: image.accepted.revision,
          requested: snapshot.identity.requestedRevision,
          mixed: snapshot.mixedRevisions,
        };
        snapshot.release();
        return state;
      }),
    )
    .toMatchObject({
      stale: true,
      draftInSource: false,
      draftInComposed: false,
      hasAccepted: true,
      mixed: true,
    });
});

test('records scaled and fixed target sizes, and each pass its own resolution', async ({
  page,
}) => {
  await open(
    page,
    'Inspect sizes',
    pipeline((project, ids) =>
      setPassResolution(
        setPassResolution(project, ids.a, { mode: 'fixed', width: 64, height: 32 }),
        ids.b,
        { mode: 'scaled', scale: 0.5 },
      ),
    ),
    3,
  );

  const sizes = await page.evaluate(async () => {
    const engine = (window as any).ng
      .getComponent(document.querySelector('app-shader-canvas'))
      .engine();
    const snapshot = await engine.captureFrame();
    const [a, b, image] = snapshot.passes;
    const size = (id: string) => {
      const { width, height } = snapshot.image(id);
      return [width, height];
    };
    const result = {
      aOut: size(a.output.rawImageId),
      aPrev: size(a.inputs[0].imageId),
      bFromA: size(b.inputs[0].imageId),
      bOut: size(b.output.rawImageId),
      aResolution: a.uniforms.iResolution,
      bResolution: b.uniforms.iResolution,
      imageResolution: image.uniforms.iResolution,
      drawingBuffer: snapshot.frame.drawingBuffer,
    };
    snapshot.release();
    return result;
  });

  expect(sizes.aOut).toEqual([64, 32]);
  expect(sizes.aPrev).toEqual([64, 32]);
  expect(sizes.bFromA).toEqual([64, 32]);
  expect(sizes.aResolution).toEqual([64, 32]);
  const { width, height } = sizes.drawingBuffer;
  expect(sizes.bOut).toEqual([Math.floor(width * 0.5), Math.floor(height * 0.5)]);
  expect(sizes.bResolution).toEqual(sizes.bOut);
  expect(sizes.imageResolution).toEqual([width, height]);
});

test('keeps an image slot as the shader sampled it: flip, wrap, filter, exact texels', async ({
  page,
}) => {
  const project = createProject(
    `${DECLARE}void main() { gl_FragColor = texture2D(iChannel0, gl_FragCoord.xy / iResolution.xy); }`,
    DEFAULT_VERTEX,
  );
  await open(page, 'Inspect image slot', project, 1);

  const slot = await page.evaluate(async () => {
    const engine = (window as any).ng
      .getComponent(document.querySelector('app-shader-canvas'))
      .engine();
    // A 2×2 opaque image: red, green on the top row; blue, white on the bottom.
    const source = document.createElement('canvas');
    source.width = source.height = 2;
    const draw = source.getContext('2d')!;
    [
      ['#f00', 0, 0],
      ['#0f0', 1, 0],
      ['#00f', 0, 1],
      ['#fff', 1, 1],
    ].forEach(([colour, x, y]) => {
      draw.fillStyle = colour as string;
      draw.fillRect(x as number, y as number, 1, 1);
    });
    const url = source.toDataURL('image/png');
    const channels = [{ url, wrap: 'repeat', filter: 'nearest', flipY: true }, null, null, null];

    let last: unknown = null;
    for (let attempt = 0; attempt < 50; attempt++) {
      // The canvas resets channels from the record once they resolve; reassert ours each try.
      engine.setChannels(channels);
      const snapshot = await engine.captureFrame();
      const input = snapshot.passes[0].inputs[0];
      last = { state: input.state, reason: input.reason, binding: input.binding };
      if (input.state === 'captured') {
        const image = snapshot.image(input.imageId);
        const result = {
          input: { source: input.source, sampling: input.sampling },
          image: { width: image.width, height: image.height, format: image.format },
          bottomLeft: snapshot.pixel(input.imageId, 0, 0),
          bottomRight: snapshot.pixel(input.imageId, 1, 0),
          topLeft: snapshot.pixel(input.imageId, 0, 1),
          comparison: snapshot.passes[0].output.comparison,
        };
        snapshot.release();
        return result;
      }
      snapshot.release();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`image slot never settled: ${JSON.stringify(last)}`);
  });

  expect(slot!.input.source).toBe('image-slot');
  expect(slot!.input.sampling).toMatchObject({ wrap: 'repeat', filter: 'nearest', flipY: true });
  expect(slot!.input.sampling.mipmaps).toBe(false);
  expect(slot!.image).toEqual({ width: 2, height: 2, format: 'rgba8' });
  // GL row 0 is the bottom, and flipY put the image's bottom row there.
  expect(slot!.bottomLeft).toEqual([0, 0, 255, 255]);
  expect(slot!.bottomRight).toEqual([255, 255, 255, 255]);
  expect(slot!.topLeft).toEqual([255, 0, 0, 255]);
  expect(slot!.comparison.status).toBe('match');
});

test('cancels, releases and refuses cleanly, and never half-reports a capture', async ({
  page,
}) => {
  await open(
    page,
    'Inspect states',
    pipeline((project) => project),
    3,
  );

  const states = await page.evaluate(async () => {
    const engine = (window as any).ng
      .getComponent(document.querySelector('app-shader-canvas'))
      .engine();
    const code = async (promise: Promise<unknown>) => {
      try {
        await promise;
        return 'resolved';
      } catch (error: any) {
        return error.code ?? String(error);
      }
    };

    const abort = new AbortController();
    const aborted = code(engine.captureFrame({ signal: abort.signal }));
    abort.abort();

    const first = engine.captureFrame();
    const busy = await code(engine.captureFrame());
    const snapshot = await first;
    const retained = await code(engine.captureFrame());
    snapshot.release();
    snapshot.release();
    const afterRelease = await code(engine.captureFrame());
    engine.releaseCapture();

    // A GPU that cannot read floats back is refused, not served 8-bit data.
    const gl = engine.context.renderer.getContext();
    const original = gl.getExtension.bind(gl);
    gl.getExtension = (name: string) => (name === 'EXT_color_buffer_float' ? null : original(name));
    const unsupported = await code(engine.captureFrame());
    gl.getExtension = original;

    return {
      aborted: await aborted,
      busy,
      retained,
      afterRelease,
      unsupported,
      leftover: engine.capturedFrame,
      read: await code(Promise.resolve().then(() => snapshot.image(snapshot.images[0].id))),
    };
  });

  expect(states).toEqual({
    aborted: 'aborted',
    busy: 'busy',
    retained: 'retained',
    afterRelease: 'resolved',
    unsupported: 'unsupported',
    leftover: null,
    read: 'released',
  });
});

test('refuses a capture over the payload budget without touching the picture', async ({ page }) => {
  await open(
    page,
    'Inspect budget',
    pipeline((project, ids) =>
      setPassResolution(project, ids.a, { mode: 'fixed', width: 4096, height: 2048 }),
    ),
    3,
  );

  const outcome = await page.evaluate(async () => {
    const engine = (window as any).ng
      .getComponent(document.querySelector('app-shader-canvas'))
      .engine();
    try {
      await engine.captureFrame();
      return { code: 'resolved' };
    } catch (error: any) {
      return { code: error.code, message: error.message, retained: engine.capturedFrame };
    }
  });

  expect(outcome.code).toBe('budget');
  expect(outcome.message).toContain('Nothing was captured or downsampled');
  expect(outcome.retained).toBeNull();
});

test('counts every actual feedback frame while the live profiler samples individual passes', async ({
  page,
}) => {
  await open(
    page,
    'Inspect profiled frames',
    pipeline((project) => project),
    3,
  );
  const runs = await page.evaluate(async () => {
    const engine = (window as any).ng
      .getComponent(document.querySelector('app-shader-canvas'))
      .engine();
    const take = async () => {
      const snapshot = await engine.captureFrame();
      const result = {
        index: snapshot.frame.index,
        output: snapshot.pixel(snapshot.passes[0].output.rawImageId, 0, 0)[0],
      };
      snapshot.release();
      return result;
    };
    const first = await take();
    engine.setProfilingEnabled(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    engine.setProfilingEnabled(false);
    const second = await take();
    return { first, second };
  });
  const frames = runs.second.index - runs.first.index;
  expect(runs.second.output - runs.first.output).toBe(1.5 * frames);
});

test('records renderer-provided uniforms used by the accepted shader', async ({ page }) => {
  const project = createProject(
    `void main() {
    gl_FragColor = vec4(float(isOrthographic), cameraPosition.xyz);
  }`,
    DEFAULT_VERTEX,
  );
  await open(page, 'Inspect renderer uniforms', project, 1);
  const capture = await page.evaluate(async () => {
    const engine = (window as any).ng
      .getComponent(document.querySelector('app-shader-canvas'))
      .engine();
    const snapshot = await engine.captureFrame();
    const pass = snapshot.passes[0];
    const result = {
      uniforms: pass.uniforms,
      raw: snapshot.pixel(pass.output.rawImageId, 0, 0),
      comparison: pass.output.comparison,
    };
    snapshot.release();
    return result;
  });
  expect(capture.raw).toEqual([1, 0, 0, 0]);
  expect(capture.comparison.status).toBe('match');
  expect(capture.uniforms).toMatchObject({ isOrthographic: true, cameraPosition: [0, 0, 0] });
  expect(capture.uniforms.projectionMatrix).toHaveLength(16);
  expect(capture.uniforms.modelViewMatrix).toHaveLength(16);
});

test('does not publish a released capture after completion races with handle release', async ({
  page,
}) => {
  await open(
    page,
    'Inspect capture publication',
    pipeline((project) => project),
    3,
  );
  const outcome = await page.evaluate(async () => {
    const component = (window as any).ng.getComponent(document.querySelector('app-shader-canvas'));
    const engine = component.engine();
    const handle = component.handle;
    const previous = engine.onFrameRendered;
    engine.onFrameRendered = () => {
      engine.onFrameRendered = previous;
      previous?.();
      handle.releaseCapture();
    };
    let code = 'resolved';
    try {
      await handle.captureFrame();
    } catch (error: any) {
      code = error.code;
    }
    return {
      code,
      published: handle.capturedFrame() !== null,
      engineRetained: engine.capturedFrame !== null,
    };
  });
  expect(outcome).toEqual({ code: 'released', published: false, engineRetained: false });
});
