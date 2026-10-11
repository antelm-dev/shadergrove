import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_RENDER } from '@shadergrove/shared/model';
import { GlContextRegistry } from './gl-context-registry';
import { type GlContext, ShaderEngine, type ShaderSpec } from '@shadergrove/rendering';
import { FakeFrames, fakeBackend, type FakeRenderer } from '@shadergrove/rendering/testing';

/**
 * The clock seam: what makes a captured frame a function of its time and
 * nothing else.
 *
 * A live engine takes its time from `performance.now()`, its mouse from the
 * pointer and its ripples from `Math.random()`. None of those can be filmed —
 * run the same export twice and you would get two different videos. So a capture
 * takes the clock away from the wall, and these tests are about whether it
 * really got *all* of it.
 *
 * No pixels are read here, and none need to be: what can be wrong is the
 * bookkeeping, and the fake renderer records every bit of it.
 */

const FRAGMENT = 'void main() { gl_FragColor = vec4(1.0); }';

function spec(): ShaderSpec {
  return {
    fragment: FRAGMENT,
    vertex: 'void main() { gl_Position = vec4(position, 1.0); }',
    controls: [],
    params: {},
    render: DEFAULT_RENDER,
    channels: [null, null, null, null],
  };
}

/** The Image pass's uniforms — what the registry holds as its primary map. */
function uniforms(engine: ShaderEngine): Record<string, { value: unknown }> {
  return (engine as unknown as { registry: { primary: Record<string, { value: unknown }> } })
    .registry.primary;
}

/** The `iTime` the engine last drew with — the only thing a captured frame may depend on. */
function drawnTime(engine: ShaderEngine): number {
  return uniforms(engine)['iTime'].value as number;
}

function uniformVector(engine: ShaderEngine, name: string): { x: number; y: number; z: number } {
  return uniforms(engine)[name].value as { x: number; y: number; z: number };
}

describe('offline capture', () => {
  let registry: GlContextRegistry;
  let renderers: FakeRenderer[];
  let frames: FakeFrames;
  let canvas: HTMLCanvasElement;
  let context: GlContext;
  let engine: ShaderEngine;
  let renderer: FakeRenderer;

  beforeEach(async () => {
    frames = new FakeFrames();
    frames.install();

    const fake = fakeBackend();
    renderers = fake.renderers;
    registry = TestBed.inject(GlContextRegistry);

    canvas = document.createElement('canvas');
    context = await registry.create(canvas, { id: 'capture', backend: fake.backend });
    engine = await ShaderEngine.create(context);
    engine.setShader(spec());
    renderer = renderers[0];
  });

  afterEach(() => {
    registry.destroyAll();
    vi.unstubAllGlobals();
  });

  // ---------------------------------------------------------------------------
  // The clock
  // ---------------------------------------------------------------------------

  it('stops the animation loop, so no frame is drawn that the capture did not ask for', () => {
    expect(frames.pending).toBe(1);

    engine.beginOffline(1920, 1080);

    expect(engine.capturing).toBe(true);
    expect(frames.pending).toBe(0);

    // Nothing the wall clock does can put a frame on the canvas now.
    const drawn = renderer.draws;
    frames.run();
    frames.run();
    expect(renderer.draws).toBe(drawn);
  });

  it('draws at exactly the time it is given, once per call', () => {
    engine.beginOffline(640, 360);
    const before = renderer.draws;

    engine.renderAt(4.5);

    expect(drawnTime(engine)).toBe(4.5);
    expect(renderer.draws).toBe(before + 1);

    engine.renderAt(0.25);
    expect(drawnTime(engine)).toBe(0.25);
    expect(renderer.draws).toBe(before + 2);
  });

  it('lets a capture run backwards, or stand still, because time is now an argument', () => {
    engine.beginOffline(640, 360);

    for (const time of [10, 2, 2, 0]) {
      engine.renderAt(time);
      expect(drawnTime(engine)).toBe(time);
    }
  });

  it('refuses to draw a frame outside a capture', () => {
    expect(() => engine.renderAt(1)).toThrow(/beginOffline/);
  });

  it('refuses to start a capture on top of one already running', () => {
    engine.beginOffline(640, 360);
    expect(() => engine.beginOffline(640, 360)).toThrow(/already capturing/);
  });

  // ---------------------------------------------------------------------------
  // Everything else that was not the clock
  // ---------------------------------------------------------------------------

  it('freezes the pointer and ignores it for as long as the capture runs', () => {
    canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: 20, clientY: 30 }));
    engine.beginOffline(640, 360);

    // The mouse is off the canvas, its velocity is nothing, and the ripples the
    // clicks left behind are gone: their timestamps would have fired somewhere
    // in the middle of the film.
    expect(uniformVector(engine, 'iMouse')).toMatchObject({ x: -1000, y: -1000, z: 0 });
    expect(uniformVector(engine, 'iMouseVel')).toMatchObject({ x: 0, y: 0 });

    const waves = (engine as unknown as { clickData: { x: number; y: number; z: number }[] })
      .clickData;
    expect(waves.every((wave) => wave.x === 0 && wave.y === 0 && wave.z === 0)).toBe(true);

    // And a hand crossing the canvas mid-capture writes itself into nothing.
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 200, clientY: 100 }));
    canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: 200, clientY: 100 }));

    expect(uniformVector(engine, 'iMouse')).toMatchObject({ x: -1000, y: -1000, z: 0 });
    expect(waves.every((wave) => wave.z === 0)).toBe(true);
  });

  it('turns the auto-ripples off, because Math.random() is not reproducible', () => {
    engine.setAutoRipples(true);
    engine.beginOffline(640, 360);

    expect((engine as unknown as { autoRipples: boolean }).autoRipples).toBe(false);

    // …and puts them back exactly as the user left them.
    engine.endOffline();
    expect((engine as unknown as { autoRipples: boolean }).autoRipples).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // The drawing buffer
  // ---------------------------------------------------------------------------

  it('renders at the capture size, whatever size the canvas is on screen', () => {
    engine.beginOffline(3840, 2160);

    expect(renderer.pixelRatio).toBe(1);
    expect(renderer).toMatchObject({ width: 3840, height: 2160 });
    // Drawing-buffer pixels: what the shader reads as iResolution.
    expect(uniformVector(engine, 'iResolution')).toMatchObject({ x: 3840, y: 2160 });
  });

  it('keeps the capture size against anything that resizes the canvas under it', () => {
    engine.beginOffline(1920, 1080);

    // A window drag, a panel re-layout, a ResizeObserver firing — all of it lands
    // back on the size the frames are coming out at.
    engine.resize();
    engine.setResolutionScale(2);

    expect(renderer).toMatchObject({ width: 1920, height: 1080, pixelRatio: 1 });
    expect(uniformVector(engine, 'iResolution')).toMatchObject({ x: 1920, y: 1080 });
  });

  // ---------------------------------------------------------------------------
  // Giving it all back
  // ---------------------------------------------------------------------------

  it('gives the clock back to the wall, at the time the preview was left at', () => {
    // Let the live loop advance the clock a little.
    frames.run();
    frames.run();
    const live = drawnTime(engine);

    engine.beginOffline(1920, 1080);
    engine.renderAt(120);
    engine.endOffline();

    // Filming the shader is not scrubbing it: the preview resumes where it was,
    // not two minutes in.
    expect(engine.capturing).toBe(false);
    expect(drawnTime(engine)).toBe(live);

    // And it is really running again.
    expect(frames.pending).toBe(1);
    const drawn = renderer.draws;
    frames.run();
    expect(renderer.draws).toBeGreaterThan(drawn);
  });

  it('restores the preview settings that arrived while it was filming', () => {
    engine.setPaused(false);
    engine.beginOffline(1920, 1080);

    // The panel pushing preferences has no idea a capture is running, and must
    // not need to: what it asks for is applied when the capture hands back.
    engine.setPaused(true);
    engine.setAutoRipples(true);

    expect((engine as unknown as { paused: boolean }).paused).toBe(true);
    expect((engine as unknown as { autoRipples: boolean }).autoRipples).toBe(false);

    engine.endOffline();

    expect((engine as unknown as { paused: boolean }).paused).toBe(true);
    expect((engine as unknown as { autoRipples: boolean }).autoRipples).toBe(true);
  });

  it('restores the on-screen drawing buffer', () => {
    engine.setResolutionScale(1);
    engine.beginOffline(3840, 2160);
    engine.endOffline();

    // Back to the canvas's own size — the 4K buffer belonged to the capture.
    expect(renderer.pixelRatio).toBe(1);
    expect(renderer.width).not.toBe(3840);
  });

  it('is safe to end a capture that never started', () => {
    expect(() => engine.endOffline()).not.toThrow();
    expect(engine.capturing).toBe(false);
  });

  it('does not let a context restored mid-capture hand the clock back to the wall', () => {
    engine.beginOffline(1920, 1080);

    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    canvas.dispatchEvent(new Event('webglcontextrestored'));

    // The restore re-compiled the shader and would normally restart the loop.
    // While a capture owns the clock, only `endOffline` may do that.
    expect(engine.capturing).toBe(true);
    expect(frames.pending).toBe(0);

    engine.endOffline();
    expect(frames.pending).toBe(1);
  });
});
