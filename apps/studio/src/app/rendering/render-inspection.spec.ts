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
  setPassResolution,
  setPassSource,
  type RenderPass,
  type ShaderProject,
} from '@shadergrove/shared';

import { GlContext } from './gl-context';
import { FrameCaptureError, type InvalidationReason } from './render-inspection';
import { ShaderEngine, type EnginePass, type MultiPassSpec } from './shader-engine';
import { FakeFrames, FakeRenderTarget, fakeBackend, type FakeRenderer } from './testing/fake-gl';

/**
 * The capture's *lifecycle*, on a three.js that never touches a GPU: when work
 * happens, when it is refused, and when a capture ends. What the texels hold is
 * a real GPU's to say, and is asserted against real WebGL in
 * `apps/studio-e2e/src/render-inspection.spec.ts` — a fake has no pixels to be
 * faithful to.
 */

const VERTEX = 'void main() { gl_Position = vec4(position, 1.0); }';
const CANVAS = { width: 800, height: 600 };

function toSpec(project: ShaderProject, projectId = 'p1', revision = 1): MultiPassSpec {
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
    projectId,
    revision,
  };
}

/** Buffer A samples its own previous frame; Image samples A's current one. */
function feedbackProject(): { project: ShaderProject; a: RenderPass } {
  let project = addBuffer(migrateLegacyProject('IMAGE', VERTEX));
  const a = bufferPasses(project)[0];
  project = setPassSource(project, a.id, 'GOOD');
  project = setChannelBinding(project, a.id, 0, { kind: 'buffer', passId: a.id, feedback: true });
  project = setChannelBinding(project, imagePass(project).id, 0, {
    kind: 'buffer',
    passId: a.id,
    feedback: false,
  });
  return { project, a: bufferPasses(project)[0] };
}

describe('frame capture lifecycle', () => {
  let renderer: FakeRenderer;
  let engine: ShaderEngine;
  let frames: FakeFrames;
  let canvas: HTMLCanvasElement;
  const invalidations: InvalidationReason[] = [];

  beforeEach(async () => {
    resetIdCounter();
    FakeRenderTarget.reset();
    invalidations.length = 0;

    frames = new FakeFrames();
    frames.install();

    const { backend, renderers } = fakeBackend();
    canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'clientWidth', 'get').mockReturnValue(CANVAS.width);
    vi.spyOn(canvas, 'clientHeight', 'get').mockReturnValue(CANVAS.height);

    engine = await ShaderEngine.create(await GlContext.create(canvas, { id: 'gl', backend }));
    renderer = renderers[0];
    engine.onCaptureInvalidated = (reason) => invalidations.push(reason);
  });

  afterEach(() => {
    engine.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function capture() {
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

  it('does no capture work, and touches no GL state, while nothing is pending', () => {
    const { project } = feedbackProject();
    engine.setPasses(toSpec(project));
    const getContext = vi.spyOn(renderer, 'getContext');
    const targets = FakeRenderTarget.created.length;

    frames.run();
    frames.run();

    expect(getContext).not.toHaveBeenCalled();
    expect(renderer.reads).toEqual([]);
    expect(FakeRenderTarget.created.length).toBe(targets);
    expect(engine.capturedFrame).toBeNull();
  });

  it('captures the next frame it draws, even when paused, with identity and per-pass inputs', async () => {
    const { project, a } = feedbackProject();
    engine.setPasses(toSpec(project, 'p1', 7));
    engine.setPaused(true);
    frames.run();
    frames.run();
    const drawn = renderer.draws;

    const snapshot = await capture();

    expect(renderer.draws).toBeGreaterThan(drawn);
    expect(snapshot.identity).toMatchObject({
      contextId: 'gl',
      projectId: 'p1',
      requestedRevision: 7,
    });
    expect(snapshot.frame.drawingBuffer).toEqual(CANVAS);
    expect(snapshot.mixedRevisions).toBe(false);

    const [bufferPass, image] = snapshot.passes;
    expect(bufferPass.id).toBe(a.id);
    expect(bufferPass.inputs[0]).toMatchObject({
      source: 'buffer-previous',
      state: 'captured',
      effective: 'texels',
    });
    expect(image.inputs[0]).toMatchObject({ source: 'buffer-current', state: 'captured' });
    // The Image pass read exactly what the buffer wrote this frame: one copy, two views.
    expect(image.inputs[0].imageId).toBe(bufferPass.output.rawImageId);
    expect(bufferPass.inputs[0].imageId).not.toBe(bufferPass.output.rawImageId);
    expect(image.inputs[1]).toMatchObject({
      // The legacy project binds slot 1 to a texture slot nothing is assigned to.
      state: 'empty-slot',
      effective: 'placeholder-transparent',
      imageId: null,
    });

    expect(image.output.rawOrigin).toBe('frozen-replay');
    expect(image.output.comparison).toMatchObject({ status: 'match' });
    expect(snapshot.image(image.output.rawImageId!)).toMatchObject({
      format: 'rgba32f',
      width: CANVAS.width,
      height: CANVAS.height,
    });
    expect(snapshot.image(bufferPass.output.rawImageId!).format).toBe('rgba16f');
  });

  it('disposes every temporary allocation and leaves the renderer target restored', async () => {
    const { project } = feedbackProject();
    engine.setPasses(toSpec(project));
    frames.run();
    const before = FakeRenderTarget.created.length;

    await capture();

    const extra = FakeRenderTarget.created.slice(before);
    expect(extra.length).toBeGreaterThan(0);
    expect(extra.every((target) => target.disposed)).toBe(true);
    expect(renderer.getRenderTarget()).toBeNull();
  });

  it('returns copies: a caller cannot reach the retained texels', async () => {
    const { project } = feedbackProject();
    engine.setPasses(toSpec(project));
    const snapshot = await capture();
    const id = snapshot.passes[1].output.rawImageId!;

    const first = snapshot.read(id, { x: 0, y: 0, width: 2, height: 2 });
    (first.data as Float32Array).fill(99);

    expect(Array.from(snapshot.read(id, { x: 0, y: 0, width: 2, height: 2 }).data)).not.toContain(
      99,
    );
    expect(() => snapshot.read(id, { x: 799, y: 0, width: 2, height: 1 })).toThrow(RangeError);
  });

  it('keeps the accepted program, not the failed draft, and says the capture is mixed', async () => {
    const { project, a } = feedbackProject();
    engine.setPasses(toSpec(project, 'p1', 1));

    let fired = false;
    const original = renderer.render.bind(renderer);
    renderer.render = ((scene?: unknown) => {
      const handler = renderer.debug.onShaderError as
        | ((gl: unknown, program: unknown, vertex: unknown, fragment: unknown) => void)
        | null;
      if (handler && !fired) {
        fired = true;
        handler(
          {
            getShaderSource: () => '',
            getShaderInfoLog: (shader: unknown) =>
              shader === 'fragment' ? "ERROR: 0:1: 'x' : undeclared identifier" : '',
            getProgramInfoLog: () => '',
          },
          {},
          'vertex',
          'fragment',
        );
      }
      original(scene);
    }) as typeof renderer.render;

    const diagnostics = engine.setPasses(toSpec(setPassSource(project, a.id, 'BROKEN'), 'p1', 2));
    expect(diagnostics.length).toBeGreaterThan(0);

    const snapshot = await capture();
    const accepted = snapshot.passes[0].accepted;

    expect(accepted.fragment).toContain('GOOD');
    expect(accepted.fragment).not.toContain('BROKEN');
    expect(accepted.composedFragment).toContain('GOOD');
    expect(accepted.revision).toBe(1);
    expect(accepted.stale).toBe(true);
    expect(snapshot.identity.requestedRevision).toBe(2);
    expect(snapshot.mixedRevisions).toBe(true);
    // The unchanged Image pass was accepted again at the newer revision.
    expect(snapshot.passes[1].accepted.revision).toBe(2);
    // …and the capture survived the failed edit: same project, same subject.
    expect(engine.capturedFrame).toBe(snapshot);
  });

  describe('refusals', () => {
    it('rejects a payload over budget before allocating anything, and still draws', async () => {
      let { project } = feedbackProject();
      const a = bufferPasses(project)[0];
      project = setPassResolution(project, a.id, { mode: 'fixed', width: 4096, height: 4096 });
      engine.setPasses(toSpec(project));
      frames.run();
      const targets = FakeRenderTarget.created.length;
      const draws = renderer.draws;

      const pending = engine.captureFrame();
      frames.run();

      expect(await code(pending)).toBe('budget');
      expect(renderer.reads).toEqual([]);
      expect(FakeRenderTarget.created.length).toBe(targets);
      expect(renderer.draws).toBeGreaterThan(draws);
      expect(engine.capturedFrame).toBeNull();
    });

    it('refuses, rather than lose precision, when floats cannot be read back', async () => {
      const { project } = feedbackProject();
      engine.setPasses(toSpec(project));
      renderer.floatReadback = false;

      const pending = engine.captureFrame();
      frames.run();

      await expect(pending).rejects.toThrow(/EXT_color_buffer_float/);
      expect(renderer.reads).toEqual([]);
    });

    it('allows one pending request and one retained capture', async () => {
      const { project } = feedbackProject();
      engine.setPasses(toSpec(project));

      const first = engine.captureFrame();
      expect(await code(engine.captureFrame())).toBe('busy');
      frames.run();
      const snapshot = await first;

      expect(await code(engine.captureFrame())).toBe('retained');
      snapshot.release();
      snapshot.release();
      expect(engine.capturedFrame).toBeNull();
      expect(() => snapshot.image(snapshot.images[0].id)).toThrow(FrameCaptureError);
      expect(await code(capture())).toBe('resolved');
    });

    it('rejects an already-aborted signal, and an abort while pending, with no work done', async () => {
      const { project } = feedbackProject();
      engine.setPasses(toSpec(project));

      const done = new AbortController();
      done.abort();
      expect(await code(engine.captureFrame({ signal: done.signal }))).toBe('aborted');

      const live = new AbortController();
      const pending = engine.captureFrame({ signal: live.signal });
      live.abort();
      expect(await code(pending)).toBe('aborted');

      frames.run();
      expect(renderer.reads).toEqual([]);
      expect(engine.capturedFrame).toBeNull();
      expect(await code(capture())).toBe('resolved');
    });

    it('times out when no frame is drawn', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const pending = engine.captureFrame({ timeoutMs: 50 });

      vi.advanceTimersByTime(50);

      expect(await code(pending)).toBe('timeout');
      frames.run();
      expect(renderer.reads).toEqual([]);
    });

    it('releases a pending request on releaseCapture', async () => {
      const pending = engine.captureFrame();
      engine.releaseCapture();
      expect(await code(pending)).toBe('released');
    });
  });

  describe('invalidation', () => {
    async function retained() {
      const { project } = feedbackProject();
      engine.setPasses(toSpec(project));
      return capture();
    }

    it('ends on a drawing-buffer resize', async () => {
      const snapshot = await retained();
      vi.spyOn(canvas, 'clientWidth', 'get').mockReturnValue(640);

      engine.resize();

      expect(engine.capturedFrame).toBeNull();
      expect(snapshot.released).toBe(true);
      expect(invalidations).toEqual(['resize']);
    });

    it('survives a resize that leaves the drawing buffer as it was', async () => {
      await retained();
      engine.resize();
      expect(engine.capturedFrame).not.toBeNull();
    });

    it('ends on a project switch', async () => {
      const snapshot = await retained();
      const { project } = feedbackProject();

      engine.setPasses(toSpec(project, 'p2'));

      expect(snapshot.released).toBe(true);
      expect(invalidations).toEqual(['project']);
    });

    it('ends on context loss, and refuses a request while the context is lost', async () => {
      const snapshot = await retained();

      canvas.dispatchEvent(new Event('webglcontextlost'));

      expect(snapshot.released).toBe(true);
      expect(invalidations).toEqual(['context-lost']);
      expect(await code(engine.captureFrame())).toBe('context');
    });

    it('ends on an export, and is refused while one runs', async () => {
      const snapshot = await retained();

      engine.beginOffline(64, 64);

      expect(snapshot.released).toBe(true);
      expect(invalidations).toEqual(['export']);
      expect(await code(engine.captureFrame())).toBe('offline');
    });

    it('rejects a pending request when the engine is disposed', async () => {
      const pending = engine.captureFrame();
      engine.dispose();
      expect(await code(pending)).toBe('invalidated');
      expect(await code(engine.captureFrame())).toBe('disposed');
    });
  });
});
