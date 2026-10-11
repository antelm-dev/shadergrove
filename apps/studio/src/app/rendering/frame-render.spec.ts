import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_RENDER } from '@shadergrove/shared/model';
import { GlContextRegistry } from './gl-context-registry';
import { type GlContext, ShaderEngine, type ShaderSpec } from '@shadergrove/rendering';
import { renderFrame } from './frame-render';
import { fakeBackend } from '@shadergrove/rendering/testing';

/**
 * `renderFrame` reuses the same offline-capture contract `offline-capture.spec.ts`
 * exercises for video export — these tests are about the two things export
 * doesn't need: parameter overrides that must not leak into the live session,
 * and refusing to run a second offline capture on top of one already in
 * progress (the engine's own guard, surfaced as a clean error).
 */

const FRAGMENT = 'void main() { gl_FragColor = vec4(1.0); }';

function spec(): ShaderSpec {
  return {
    fragment: FRAGMENT,
    vertex: 'void main() { gl_Position = vec4(position, 1.0); }',
    controls: [{ key: 'speed', type: 'number', default: 1, min: 0, max: 10 }],
    params: { speed: 1 },
    render: DEFAULT_RENDER,
    channels: [null, null, null, null],
  };
}

/** Read through the registry's primary map: the Image pass's uniforms. */
function uniformValue(engine: ShaderEngine, name: string): unknown {
  return (engine as unknown as { registry: { value(name: string): unknown } }).registry.value(name);
}

describe('renderFrame', () => {
  let registry: GlContextRegistry;
  let canvas: HTMLCanvasElement;
  let context: GlContext;
  let engine: ShaderEngine;
  let originalToBlob: typeof HTMLCanvasElement.prototype.toBlob;

  beforeEach(async () => {
    // jsdom does not implement canvas encoding; the pixels themselves are not
    // what these tests are about, so a deterministic stub stands in.
    originalToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function toBlob(callback: BlobCallback): void {
      callback(new Blob(['fake-png'], { type: 'image/png' }));
    };

    const fake = fakeBackend();
    registry = TestBed.inject(GlContextRegistry);
    canvas = document.createElement('canvas');
    context = await registry.create(canvas, { id: 'render', backend: fake.backend });
    engine = await ShaderEngine.create(context);
    engine.setShader(spec());
  });

  afterEach(() => {
    registry.destroyAll();
    HTMLCanvasElement.prototype.toBlob = originalToBlob;
  });

  it('renders at the requested time and size, and hands back a PNG', async () => {
    const frame = await renderFrame(engine, { speed: 1 }, { time: 4.5, width: 64, height: 32 });

    expect(frame.time).toBe(4.5);
    expect(frame.width).toBe(64);
    expect(frame.height).toBe(32);
    expect(frame.blob.type).toBe('image/png');
  });

  it('defaults to time 0, not the wall clock — deterministic without an explicit time', async () => {
    const frame = await renderFrame(engine, { speed: 1 });
    expect(frame.time).toBe(0);
  });

  it('draws at exactly the requested time, identically on every call', async () => {
    // `endOffline` deliberately hands the clock back to whatever the live
    // preview was showing (not where the capture left off), so the uniform
    // is not observable afterward — what is deterministic, and worth pinning
    // down, is the time `renderAt` was actually asked to draw.
    const renderAt = vi.spyOn(engine, 'renderAt');

    await renderFrame(engine, { speed: 1 }, { time: 2 });
    await renderFrame(engine, { speed: 1 }, { time: 2 });

    expect(renderAt.mock.calls).toEqual([[2], [2]]);
  });

  it('applies parameter overrides only for the capture, then restores the live values', async () => {
    await renderFrame(engine, { speed: 1 }, { time: 0, params: { speed: 9 } });

    // Restored once the capture ends — the resumed live loop must not keep it.
    expect(uniformValue(engine, 'u_speed')).toBe(1);
  });

  it('does not touch params at all when no override was requested', async () => {
    await renderFrame(engine, { speed: 1 }, { time: 0 });
    expect(uniformValue(engine, 'u_speed')).toBe(1);
  });

  it('leaves the engine outside capture mode once it resolves', async () => {
    await renderFrame(engine, {}, { time: 1 });
    expect(engine.capturing).toBe(false);
  });

  it('refuses to start a render while another capture is already running', async () => {
    engine.beginOffline(16, 16);
    await expect(renderFrame(engine, {}, { time: 0 })).rejects.toThrow(/already capturing/);
    engine.endOffline();
  });
});
