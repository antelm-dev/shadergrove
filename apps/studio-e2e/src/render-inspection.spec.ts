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

test('refuses one-sided NaN corruption in the observed live Image or its frozen replay', async ({
  page,
}) => {
  await open(
    page,
    'Inspect nonfinite fidelity',
    createProject('void main() { gl_FragColor = vec4(0.25, 0.5, 0.75, 1.0); }', DEFAULT_VERTEX),
    1,
  );
  const results = await page.evaluate(async (render) => {
    const engine = (window as any).ng
      .getComponent(document.querySelector('app-shader-canvas'))
      .engine();
    let baseline: any;
    for (let attempt = 0; attempt < 20; attempt++) {
      engine.setRenderSettings(render);
      const snapshot = await engine.captureFrame();
      if (snapshot.frame.usesPostProcessing) {
        const image = snapshot.passes[0];
        baseline = {
          comparison: image.output.comparison,
          raw: snapshot.pixel(image.output.rawImageId, 0, 0),
        };
        snapshot.release();
        break;
      }
      snapshot.release();
    }
    if (!baseline) throw new Error('The real composer did not start');
    const renderer = engine.context.renderer;
    const originalRender = renderer.render.bind(renderer);
    const originalRead = renderer.readRenderTargetPixels.bind(renderer);
    let replayDraw = false;
    renderer.render = (scene: any, camera: any) => {
      // The live Image writes half float in the composer; only its replay writes float32.
      // The copy-reader has a different shader, so buffer/reference copies cannot be mistaken for replay.
      const target = renderer.getRenderTarget();
      replayDraw =
        target?.texture.type === engine.context.three.FloatType &&
        scene.children[0]?.material.fragmentShader === engine.activeShader.fragment;
      return originalRender(scene, camera);
    };
    try {
      const outcomes = [];
      for (const corrupt of ['replay', 'reference']) {
        let injected = false;
        let finiteBefore = false;
        renderer.readRenderTargetPixels = (...args: any[]) => {
          originalRead(...args);
          const out = args[args.length - 1];
          if (out instanceof Float32Array && (corrupt === 'replay') === replayDraw) {
            finiteBefore = Number.isFinite(out[0]);
            out[0] = NaN;
            injected = true;
          }
        };
        engine.setRenderSettings(render);
        let code = 'resolved';
        let comparison: any = null;
        let rawIsNaN = false;
        try {
          const snapshot = await engine.captureFrame();
          const image = snapshot.passes[0];
          comparison = image.output.comparison;
          rawIsNaN = Number.isNaN(snapshot.pixel(image.output.rawImageId, 0, 0)[0]);
          snapshot.release();
        } catch (error: any) {
          code = error.code;
        }
        outcomes.push({
          corrupt,
          code,
          injected,
          finiteBefore,
          comparison,
          rawIsNaN,
          retained: engine.capturedFrame !== null,
        });
      }
      return { baseline, outcomes };
    } finally {
      renderer.render = originalRender;
      renderer.readRenderTargetPixels = originalRead;
    }
  }, VIGNETTE);
  expect(results.baseline.raw).toEqual([0.25, 0.5, 0.75, 1]);
  expect(results.baseline.comparison).toMatchObject({
    status: 'match',
    reference: 'pre-effect-live',
    skippedNonFinite: 0,
  });
  for (const outcome of results.outcomes) {
    expect(outcome.injected && outcome.finiteBefore).toBe(true);
    expect(outcome.code, JSON.stringify(outcome)).toBe('replay-mismatch');
    expect(outcome.retained).toBe(false);
  }
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

const VIGNETTE = {
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
};

test('compares the frozen replay with the live pre-effect Image behind an enabled vignette', async ({
  page,
}) => {
  await open(
    page,
    'Inspect behind effects',
    pipeline((project) => project),
    3,
  );
  const frame = await page.evaluate(async (render) => {
    const engine = (window as any).ng
      .getComponent(document.querySelector('app-shader-canvas'))
      .engine();
    // The canvas re-applies its own settings, so assert ours until the composer is in use.
    let snapshot: any;
    for (let attempt = 0; attempt < 20; attempt++) {
      engine.setRenderSettings(render);
      snapshot = await engine.captureFrame();
      if (snapshot.frame.usesPostProcessing) break;
      snapshot.release();
    }
    const image = snapshot.passes[snapshot.passes.length - 1];
    const result = {
      usesPostProcessing: snapshot.frame.usesPostProcessing,
      raw: snapshot.pixel(image.output.rawImageId, 0, 0),
      input: snapshot.pixel(image.inputs[0].imageId, 0, 0),
      display: snapshot.pixel(image.output.displayImageId, 0, 0),
      rawOrigin: image.output.rawOrigin,
      comparison: image.output.comparison,
      index: snapshot.frame.index,
      a: snapshot.pixel(snapshot.passes[0].output.rawImageId, 0, 0)[0],
    };
    snapshot.release();
    // History is untouched: a later capture continues from the same buffer by 1.5 a frame.
    const later = await engine.captureFrame();
    const next = {
      index: later.frame.index,
      a: later.pixel(later.passes[0].output.rawImageId, 0, 0)[0],
    };
    later.release();
    return { ...result, next };
  }, VIGNETTE);

  expect(frame.usesPostProcessing).toBe(true);
  // Negative and HDR channels survive in the raw replay, and it is the Image program's output.
  expect(frame.raw).toEqual([frame.input[0] * 0.5, frame.input[1], -1, 1]);
  expect(frame.raw[0]).toBeGreaterThan(1);
  expect(frame.rawOrigin).toBe('frozen-replay');
  expect(frame.comparison).toMatchObject({ status: 'match', reference: 'pre-effect-live' });
  // The processed canvas is a separate 8-bit image and is not what raw reports.
  expect(frame.display).not.toEqual(frame.raw);
  expect(frame.next.a - frame.a).toBe(1.5 * (frame.next.index - frame.index));
});

test('refuses a replay that disagrees with the live pre-effect Image', async ({ page }) => {
  await open(
    page,
    'Inspect mismatched replay',
    pipeline((project) => project),
    3,
  );
  const outcome = await page.evaluate(async (render) => {
    const engine = (window as any).ng
      .getComponent(document.querySelector('app-shader-canvas'))
      .engine();
    const renderer = engine.context.renderer;
    const original = renderer.readRenderTargetPixels.bind(renderer);
    // The live pre-effect reference is the first float read of a capture; perturb the later ones.
    let reads = 0;
    renderer.readRenderTargetPixels = (...args: any[]) => {
      original(...args);
      reads++;
      const out = args[args.length - 1];
      if (reads > 1 && out instanceof Float32Array) out[0] += 8;
    };
    try {
      let code = 'resolved';
      for (let attempt = 0; attempt < 20; attempt++) {
        engine.setRenderSettings(render);
        reads = 0;
        try {
          const snapshot = await engine.captureFrame();
          const used = snapshot.frame.usesPostProcessing;
          snapshot.release();
          if (used) break;
        } catch (error: any) {
          code = error.code;
          break;
        }
      }
      return { code, retained: engine.capturedFrame };
    } finally {
      renderer.readRenderTargetPixels = original;
    }
  }, VIGNETTE);
  expect(outcome.code).toBe('replay-mismatch');
  expect(outcome.retained).toBeNull();
});

// --- The inspector UI, driven through its real controls ---------------------------
// The debug API below only observes the engine; every action is a click, key or typed value.

const retained = (page: Page) =>
  page.evaluate(
    () =>
      (window as any).ng.getComponent(document.querySelector('app-shader-canvas')).engine()
        .capturedFrame !== null,
  );

/** Ctrl+J is the workspace's own bottom-panel shortcut; the tab is the panel's own control. */
async function openInspection(page: Page) {
  await page.keyboard.press('Control+j');
  await page.locator('#bottom-panel-tab-inspection').click();
  const panel = page.locator('app-render-inspection-panel');
  await expect(panel.locator('.capture')).toBeVisible();
  return panel;
}

const rawValues = (panel: ReturnType<Page['locator']>) =>
  panel.locator('.raw-value').allTextContents();

async function pickByTyping(panel: ReturnType<Page['locator']>, x: number, y: number) {
  await panel.locator('.pixel-x').fill(String(x));
  await panel.locator('.pixel-x').dispatchEvent('change');
  await panel.locator('.pixel-y').fill(String(y));
  await panel.locator('.pixel-y').dispatchEvent('change');
}

test('keeps the frozen capture through later frames and a rejected edit, and says it is frozen', async ({
  page,
}) => {
  await open(
    page,
    'Inspect frozen UI',
    pipeline((project) => project),
    3,
  );
  const panel = await openInspection(page);
  await panel.locator('.capture').click();
  await expect(panel.locator('.badge')).toContainText('Frozen capture');
  await expect(panel.locator('.release')).toBeVisible();

  await pickByTyping(panel, 0, 0);
  await expect(panel.locator('.raw-value')).toHaveCount(4);
  const badge = await panel.locator('.badge').textContent();
  const before = await rawValues(panel);
  // Buffer B's blue channel is -1 beyond [0, 1], and the raw Image replay keeps it.
  expect(before[2]).toBe('-1');
  expect(before[3]).toBe('1');
  expect(Number(before[0])).toBeGreaterThan(1);

  // Later frames, then a source the engine rejects.
  await page.evaluate(() => {
    (window as any).ng
      .getComponent(document.querySelector('app-shader-canvas'))
      .engine()
      .requestFrames(5);
  });
  await page.locator('.monaco-editor').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\nvoid broken( {');
  await expect(page.locator('.doc-errors')).toBeVisible();

  await expect(panel.locator('.badge')).toHaveText(badge!);
  expect(await rawValues(panel)).toEqual(before);
  await expect(panel.locator('.profiler-note')).toContainText('not part of this frozen capture');
  expect(await retained(page)).toBe(true);

  await panel.locator('.release').click();
  await expect(panel.locator('.capture')).toBeVisible();
  await expect(panel.locator('.badge')).toHaveCount(0);
  expect(await retained(page)).toBe(false);
});

test('picks the right drawing-buffer texel when zoomed, and keeps raw HDR apart from the display', async ({
  page,
}) => {
  await open(
    page,
    'Inspect zoomed pick',
    pipeline((project, ids) =>
      setPassResolution(project, ids.a, { mode: 'fixed', width: 64, height: 32 }),
    ),
    3,
  );
  const panel = await openInspection(page);
  await panel.locator('.capture').click();
  await expect(panel.locator('.badge')).toBeVisible();

  await panel.locator('.pass-select').selectOption({ index: 0 });
  await panel.locator('.zoom-in').click();
  await expect(panel.locator('.zoom-value')).not.toHaveText('Fit');

  // Texel (10, 5) counted from the bottom-left of this pass's own 64×32 target.
  const canvas = panel.locator('canvas.image');
  const box = (await canvas.boundingBox())!;
  await canvas.click({
    position: { x: box.width * (10.5 / 64), y: box.height * ((32 - 5 - 0.5) / 32) },
  });
  await expect(panel.locator('.pixel-x')).toHaveValue('10');
  await expect(panel.locator('.pixel-y')).toHaveValue('5');

  const raw = await rawValues(panel);
  expect(raw.slice(1)).toEqual(['-0.25', '2048', '1']);
  await expect(panel.locator('.flag')).toContainText(['negative', 'above 1 (HDR)']);
  // The display transform only clamps what it draws: blue 2048 is white, red follows the frame.
  await expect(panel.locator('.viz-value')).toHaveText('rgb(255, 0, 255)');
  await panel.locator('.channel-select').selectOption('b');
  await expect(panel.locator('.viz-value')).toHaveText('rgb(255, 255, 255)');
  expect(await rawValues(panel)).toEqual(raw);

  // The keyboard moves the same pick one texel, inside the image.
  await canvas.press('ArrowLeft');
  await expect(panel.locator('.pixel-x')).toHaveValue('9');
  await panel.locator('.pixel-x').fill('64');
  await panel.locator('.pixel-x').dispatchEvent('change');
  await expect(panel.locator('[role="alert"]')).toBeVisible();
  await expect(panel.locator('.pixel-x')).toHaveValue('9');
});

test('releases on hide, release and resize, and refuses an unsupported GPU honestly', async ({
  page,
}) => {
  await open(
    page,
    'Inspect lifecycle UI',
    pipeline((project) => project),
    3,
  );
  const panel = await openInspection(page);

  // Hiding the tab releases the capture instead of holding it behind the scenes.
  await panel.locator('.capture').click();
  await expect(panel.locator('.badge')).toBeVisible();
  expect(await retained(page)).toBe(true);
  await page.locator('#bottom-panel-tab-problems').click();
  await expect.poll(() => retained(page)).toBe(false);
  await page.locator('#bottom-panel-tab-inspection').click();
  await expect(panel.locator('.capture')).toBeVisible();
  await expect(panel.locator('.badge')).toHaveCount(0);

  // A resize ends the capture, and the panel names why.
  await panel.locator('.capture').click();
  await expect(panel.locator('.badge')).toBeVisible();
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: size.width - 40, height: size.height - 40 });
  await expect(panel.getByText('preview was resized')).toBeVisible();
  await expect(panel.locator('.badge')).toHaveCount(0);
  expect(await retained(page)).toBe(false);

  // A GPU that cannot read floats back is refused: nothing is faked from 8-bit data.
  await page.evaluate(() => {
    const gl = (window as any).ng
      .getComponent(document.querySelector('app-shader-canvas'))
      .engine()
      .context.renderer.getContext();
    const original = gl.getExtension.bind(gl);
    (window as any).restoreExtensions = () => (gl.getExtension = original);
    gl.getExtension = (name: string) => (name === 'EXT_color_buffer_float' ? null : original(name));
  });
  await panel.locator('.capture').click();
  await expect(panel.getByText('cannot be captured exactly')).toBeVisible();
  await expect(panel.locator('.badge')).toHaveCount(0);
  await expect(panel.locator('.raw-value')).toHaveCount(0);
  expect(await retained(page)).toBe(false);
  await page.evaluate(() => (window as any).restoreExtensions());

  // Context loss ends a capture taken afterwards.
  await panel.locator('.capture').click();
  await expect(panel.locator('.badge')).toBeVisible();
  await page.evaluate(() =>
    (window as any).ng
      .getComponent(document.querySelector('app-shader-canvas'))
      .engine()
      .context.renderer.getContext()
      .getExtension('WEBGL_lose_context')
      .loseContext(),
  );
  await expect(panel.getByText('WebGL context was lost')).toBeVisible();
  await expect(panel.locator('.badge')).toHaveCount(0);
});
