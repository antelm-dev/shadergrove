import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_RENDER,
  addBuffer,
  bufferPasses,
  composePass,
  imagePass,
  migrateLegacyProject,
  resetIdCounter,
  resolvePassOrder,
  setChannelBinding,
  setPassSource,
  type RenderPass,
  type ShaderProject,
} from '@shadergrove/shared';

import { GlContext } from './gl-context';
import {
  CAPTURE_BUDGET_BYTES,
  FrameCaptureError,
  HALF_ABSOLUTE,
  HALF_MAX,
  HALF_RELATIVE,
  type FrameInspector,
} from './render-inspection';
import {
  BAND_TEXELS,
  FLOAT_ABSOLUTE,
  FLOAT_RELATIVE,
  compareBand,
  observationFootprint,
} from './render-observation';
import { ShaderEngine, type EnginePass, type MultiPassSpec } from './shader-engine';
import { FakeFrames, FakeRenderTarget, fakeBackend } from './testing/fake-gl';

const FLOAT = { relative: FLOAT_RELATIVE, absolute: FLOAT_ABSOLUTE };
const HALF = { relative: HALF_RELATIVE, absolute: HALF_ABSOLUTE };

describe('observation fidelity comparison', () => {
  it('matches equal and in-tolerance finite values, and keeps raw negative/HDR values', () => {
    const live = [-3.5, 0, 1024, 7.25];
    const seen = [-3.5, 0, 1024 * (1 + FLOAT_RELATIVE / 2), 7.25];
    expect(compareBand(seen, live, FLOAT, false)).toEqual({
      maxDelta: expect.any(Number),
      mismatched: 0,
      skipped: 0,
    });
  });

  it('reports a finite difference beyond tolerance as a mismatch', () => {
    const result = compareBand([1.01], [1], FLOAT, false);
    expect(result.mismatched).toBe(1);
    expect(result.maxDelta).toBeCloseTo(0.01);
  });

  it('never matches NaN against a number, and skips NaN against NaN as unverified', () => {
    expect(compareBand([Number.NaN], [1], FLOAT, false).mismatched).toBe(1);
    expect(compareBand([1], [Number.NaN], FLOAT, false).mismatched).toBe(1);
    expect(compareBand([Number.NaN], [Number.NaN], FLOAT, false)).toMatchObject({
      mismatched: 0,
      skipped: 1,
    });
  });

  it('skips an infinite reference only when the sign agrees, and a half reference only at its range', () => {
    expect(compareBand([Infinity], [Infinity], FLOAT, false)).toMatchObject({ skipped: 1 });
    expect(compareBand([-Infinity], [Infinity], FLOAT, false).mismatched).toBe(1);
    expect(compareBand([5], [Infinity], FLOAT, false).mismatched).toBe(1);
    expect(compareBand([HALF_MAX], [Infinity], HALF, true)).toMatchObject({ skipped: 1 });
    expect(compareBand([5], [Infinity], HALF, true).mismatched).toBe(1);
  });

  it('never matches an infinite observation against a finite reference', () => {
    expect(compareBand([Infinity], [1], FLOAT, false).mismatched).toBe(1);
  });
});

describe('observation budget', () => {
  const base = { snapshotBytes: 10, width: 64, height: 32, geometryBytes: 100, textureBytes: 50 };

  it('adds the target, the geometry, the textures and two CPU bands to what is retained', () => {
    const footprint = observationFootprint(base);
    expect(footprint.target).toBe(64 * 32 * 16);
    expect(footprint.bands).toBe(2 * 32 * 64 * 16);
    expect(footprint.total).toBe(10 + footprint.target + 100 + 50 + footprint.bands);
  });

  it('bounds a band by BAND_TEXELS for a large target, and counts the whole target uncut', () => {
    const footprint = observationFootprint({ ...base, width: 4096, height: 4096 });
    expect(footprint.target).toBe(4096 * 4096 * 16);
    expect(footprint.bands).toBe(2 * Math.floor(BAND_TEXELS / 4096) * 4096 * 16);
    expect(footprint.total).toBeGreaterThan(CAPTURE_BUDGET_BYTES);
  });
});

const VERTEX = 'void main() { gl_Position = vec4(position, 1.0); }';

function toSpec(project: ShaderProject): MultiPassSpec {
  const { order } = resolvePassOrder(project);
  const passes: EnginePass[] = order.map((pass: RenderPass) => {
    const { source, spans } = composePass(project, pass);
    return {
      id: pass.id,
      kind: pass.kind === 'image' ? 'image' : 'buffer',
      fragment: source,
      spans,
      channels: pass.channels,
      resolution: pass.resolution,
      filter: pass.filter,
      wrap: pass.wrap,
    };
  });
  return {
    vertex: project.vertex,
    controls: [],
    params: {},
    render: DEFAULT_RENDER,
    passes,
    textures: [null, null, null, null],
    projectId: 'p1',
    revision: 1,
  };
}

function feedbackProject(): ShaderProject {
  let project = addBuffer(migrateLegacyProject('IMAGE', VERTEX));
  const a = bufferPasses(project)[0];
  project = setPassSource(project, a.id, 'GOOD');
  project = setChannelBinding(project, a.id, 0, { kind: 'buffer', passId: a.id, feedback: true });
  return setChannelBinding(project, imagePass(project).id, 0, {
    kind: 'buffer',
    passId: a.id,
    feedback: false,
  });
}

/** The one-pending cancellation runner, against a retained capture on a fake renderer. */
describe('observation lifecycle', () => {
  let engine: ShaderEngine;
  let frames: FakeFrames;
  let canvas: HTMLCanvasElement;

  beforeEach(async () => {
    resetIdCounter();
    FakeRenderTarget.reset();
    frames = new FakeFrames();
    frames.install();
    const { backend } = fakeBackend();
    canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'clientWidth', 'get').mockReturnValue(800);
    vi.spyOn(canvas, 'clientHeight', 'get').mockReturnValue(600);
    engine = await ShaderEngine.create(await GlContext.create(canvas, { id: 'gl', backend }));
    engine.setPasses(toSpec(feedbackProject()));
  });

  afterEach(() => {
    engine.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const inspector = () => (engine as unknown as { inspector: FrameInspector }).inspector;

  async function retain() {
    const pending = engine.captureFrame();
    frames.run();
    return pending;
  }

  async function code(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (error) {
      return error instanceof FrameCaptureError ? error.code : `other: ${String(error)}`;
    }
    return 'resolved';
  }

  /** A job that never finishes by itself; the test settles it. */
  function hang() {
    let finish!: (value: string) => void;
    const done = new Promise<string>((resolve) => (finish = resolve));
    let signal!: AbortSignal;
    return {
      job: (_: unknown, s: AbortSignal) => {
        signal = s;
        return done;
      },
      finish,
      signal: () => signal,
    };
  }

  it('refuses without a retained capture', async () => {
    await retain();
    engine.releaseCapture();
    expect(await code(inspector().observe({}, async () => 'x'))).toBe('released');
  });

  it('allows one pending observation and frees the slot afterwards', async () => {
    await retain();
    const first = hang();
    const running = inspector().observe({}, first.job);
    expect(engine.observing).toBe(true);
    expect(await code(inspector().observe({}, async () => 'second'))).toBe('busy');
    first.finish('ok');
    expect(await running).toBe('ok');
    expect(engine.observing).toBe(false);
    expect(await inspector().observe({}, async () => 'again')).toBe('again');
  });

  it('aborts on the caller signal, even if the job then resolves, and publishes nothing', async () => {
    await retain();
    const controller = new AbortController();
    const first = hang();
    const running = inspector().observe({ signal: controller.signal }, first.job);
    controller.abort();
    expect(first.signal().aborted).toBe(true);
    first.finish('late');
    expect(await code(running)).toBe('aborted');
    expect(engine.observing).toBe(false);
  });

  it('refuses a request whose signal is already aborted', async () => {
    await retain();
    const controller = new AbortController();
    controller.abort();
    expect(await code(inspector().observe({ signal: controller.signal }, async () => 'x'))).toBe(
      'aborted',
    );
  });

  it('times out and drops the late result', async () => {
    await retain();
    const first = hang();
    const running = inspector().observe({ timeoutMs: 15 }, first.job);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(first.signal().aborted).toBe(true);
    first.finish('late');
    expect(await code(running)).toBe('timeout');
  });

  it('cancels when the capture is released', async () => {
    await retain();
    const first = hang();
    const running = inspector().observe({}, first.job);
    engine.releaseCapture();
    first.finish('late');
    expect(await code(running)).toBe('released');
  });

  it.each([
    ['resize', () => vi.spyOn(canvas, 'clientWidth', 'get').mockReturnValue(640), 'resize'],
    ['context loss', () => canvas.dispatchEvent(new Event('webglcontextlost')), 'context-lost'],
    ['export', () => engine.beginOffline(64, 64), 'export'],
  ])('cancels on %s', async (_name, trigger) => {
    await retain();
    const first = hang();
    const running = inspector().observe({}, first.job);
    trigger();
    if (_name === 'resize') engine.resize();
    first.finish('late');
    expect(await code(running)).toBe('invalidated');
    expect(engine.observing).toBe(false);
  });

  it('cancels when the engine is disposed', async () => {
    await retain();
    const first = hang();
    const running = inspector().observe({}, first.job);
    engine.dispose();
    first.finish('late');
    expect(await code(running)).toBe('invalidated');
  });
});
