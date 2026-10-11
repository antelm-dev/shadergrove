import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_RENDER, NO_BINDING } from '@shadergrove/shared';

import { GlContext } from './gl-context';
import { ShaderEngine, type MultiPassSpec } from './shader-engine';
import { FakeFrames, FakeRenderTarget, fakeBackend, type FakeRenderer } from './testing/fake-gl';

/**
 * A paused preview draws only when something visible changed.
 *
 * Paused, the clock is stopped and so is every feedback buffer: redrawing the
 * same picture on every animation frame only keeps the main thread busy, which
 * on a machine without a GPU starves everything else on the page.
 */

const NONE = NO_BINDING;
const VERTEX = 'void main() { gl_Position = vec4(position, 1.0); }';

/** An Image pass sampling Buffer A, which samples its own previous frame. */
const TRAIL: MultiPassSpec = {
  vertex: VERTEX,
  controls: [],
  params: {},
  render: DEFAULT_RENDER,
  textures: [null, null, null, null],
  passes: [
    {
      id: 'a',
      kind: 'buffer',
      fragment: 'TRAIL',
      spans: [],
      channels: [{ kind: 'buffer', passId: 'a', feedback: true }, NONE, NONE, NONE],
      resolution: { mode: 'viewport', scale: 1, width: 1, height: 1 },
      filter: 'linear',
      wrap: 'clamp',
    },
    {
      id: 'image',
      kind: 'image',
      fragment: 'IMAGE',
      spans: [],
      channels: [{ kind: 'buffer', passId: 'a', feedback: false }, NONE, NONE, NONE],
      resolution: { mode: 'viewport', scale: 1, width: 1, height: 1 },
      filter: 'linear',
      wrap: 'clamp',
    },
  ],
};

describe('a paused preview', () => {
  let renderer: FakeRenderer;
  let engine: ShaderEngine;
  let frames: FakeFrames;
  let canvas: HTMLCanvasElement;

  beforeEach(async () => {
    FakeRenderTarget.reset();
    frames = new FakeFrames();
    frames.install();
    const { backend, renderers } = fakeBackend();

    canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'clientWidth', 'get').mockReturnValue(800);
    vi.spyOn(canvas, 'clientHeight', 'get').mockReturnValue(600);

    const context = await GlContext.create(canvas, { id: 'gl', backend });
    engine = await ShaderEngine.create(context);
    renderer = renderers[0]!;
    engine.setPasses(TRAIL);
  });

  afterEach(() => {
    engine.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** Runs `count` animation frames and says how many of them drew anything. */
  function framesDrawn(count: number): number {
    let drawn = 0;
    for (let n = 0; n < count; n++) {
      renderer.drawLog.length = 0;
      frames.run();
      if (renderer.drawLog.length > 0) drawn++;
    }
    return drawn;
  }

  /** Lets the frames owed to everything done so far be drawn. */
  function settle(): void {
    framesDrawn(10);
  }

  it('draws every frame while playing', () => {
    expect(framesDrawn(5)).toBe(5);
  });

  it('stops drawing once paused, and keeps scheduling frames to notice a change', () => {
    engine.setPaused(true);
    settle();
    expect(framesDrawn(5)).toBe(0);
    expect(frames.pending).toBe(1);
  });

  it('freezes feedback buffers while paused', () => {
    engine.setPaused(true);
    settle();
    const before = engine.bufferTexture('a');
    framesDrawn(5);
    expect(engine.bufferTexture('a')).toBe(before);
  });

  it('draws again, briefly, after a parameter, a shader, a channel or the effects change', () => {
    engine.setPaused(true);
    const changes: [string, () => void][] = [
      ['params', () => engine.setParams({})],
      ['param', () => engine.setParam('u_gain', 1)],
      ['shader', () => engine.setPasses(TRAIL)],
      ['channels', () => engine.setChannels([null, null, null, null])],
      ['effects', () => engine.setRenderSettings(DEFAULT_RENDER)],
      ['scope', () => engine.setEffectScope('other')],
    ];
    for (const [name, change] of changes) {
      settle();
      change();
      // Two: one into each target of a feedback buffer.
      expect(framesDrawn(5), name).toBe(2);
    }
  });

  it('draws again after a resize or a click on the canvas', () => {
    engine.setPaused(true);
    settle();
    vi.spyOn(canvas, 'clientWidth', 'get').mockReturnValue(640);
    engine.resize();
    expect(framesDrawn(5)).toBe(2);

    canvas.dispatchEvent(new MouseEvent('pointerdown', { button: 0 }) as PointerEvent);
    expect(framesDrawn(5)).toBe(2);
  });

  it('draws as many frames as a caller asks for', () => {
    engine.setPaused(true);
    settle();
    engine.requestFrames(4);
    expect(framesDrawn(10)).toBe(4);
  });

  it('keeps drawing for the profiler, which measures frames', () => {
    // No GPU timer extension: the profiler falls back to CPU timings.
    Object.assign(renderer, { getContext: () => ({ getExtension: () => null }) });
    engine.setPaused(true);
    engine.setProfilingEnabled(true);
    settle();
    expect(framesDrawn(5)).toBe(5);
  });

  it('reports the frames it draws, so a still preview reads 0 fps', () => {
    const reported: number[] = [];
    engine.onFps = (fps) => reported.push(fps);
    engine.setPaused(true);
    settle();
    reported.length = 0;
    // Keep time monotonic even when suite startup has already taken over 10 seconds.
    let t = performance.now();
    const now = vi.spyOn(performance, 'now');
    now.mockImplementation(() => (t += 50));
    // The first window still holds frames drawn before the pause; the next is still.
    framesDrawn(60);
    expect(reported.length).toBeGreaterThan(1);
    expect(reported.at(-1)).toBe(0);
  });

  it('draws every frame again on resume', () => {
    engine.setPaused(true);
    settle();
    engine.setPaused(false);
    expect(framesDrawn(5)).toBe(5);
  });
});
