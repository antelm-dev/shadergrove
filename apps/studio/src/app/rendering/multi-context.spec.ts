import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_RENDER } from '@shadergrove/shared/model';
import { GlContextRegistry } from './gl-context-registry';
import {
  GlContext,
  WrongContextError,
  ownerOf,
  type GlBackend,
  ShaderEngine,
  type ChannelSource,
  type ShaderSpec,
} from '@shadergrove/rendering';
import {
  FakeFrames,
  fakeBackend,
  type FakeRenderer,
  type FakeTexture,
} from '@shadergrove/rendering/testing';

/**
 * Two WebGL contexts, side by side, in jsdom — which has no WebGL at all.
 *
 * The point of these tests is *ownership and isolation*, not pixels: whether a
 * resource made by one context can leak into another, whether destroying one
 * renderer touches the other, whether a context loss stays where it happened.
 * None of that needs a driver, and a real one would make the answers
 * non-deterministic. So three.js and the renderer come in through the backend
 * seam as fakes that record what was asked of them.
 */

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function spec(
  fragment: string,
  channels: readonly (ChannelSource | null)[] = [null, null, null, null],
): ShaderSpec {
  return {
    fragment,
    vertex: 'void main() { gl_Position = vec4(position, 1.0); }',
    controls: [],
    params: {},
    render: DEFAULT_RENDER,
    channels,
  };
}

function channel(url: string): ChannelSource {
  return { url, wrap: 'clamp', filter: 'linear', flipY: true };
}

function loseContext(context: GlContext): void {
  context.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
}

function restoreContext(context: GlContext): void {
  context.canvas.dispatchEvent(new Event('webglcontextrestored'));
}

describe('multiple WebGL contexts', () => {
  let registry: GlContextRegistry;
  let renderers: FakeRenderer[];
  let backend: GlBackend;
  let frames: FakeFrames;

  let canvasA: HTMLCanvasElement;
  let canvasB: HTMLCanvasElement;
  let contextA: GlContext;
  let contextB: GlContext;
  let engineA: ShaderEngine;
  let engineB: ShaderEngine;

  const runFrame = (): void => frames.run();

  beforeEach(async () => {
    frames = new FakeFrames();
    frames.install();

    ({ backend, renderers } = fakeBackend());
    registry = TestBed.inject(GlContextRegistry);

    canvasA = document.createElement('canvas');
    canvasB = document.createElement('canvas');

    contextA = await registry.create(canvasA, { id: 'a', backend });
    contextB = await registry.create(canvasB, { id: 'b', backend });

    engineA = await ShaderEngine.create(contextA);
    engineB = await ShaderEngine.create(contextB);
  });

  afterEach(() => {
    registry.destroyAll();
    vi.unstubAllGlobals();
  });

  it('runs two canvases and two contexts at once', () => {
    expect(registry.size()).toBe(2);
    expect(registry.ids()).toEqual(['a', 'b']);

    expect(contextA.canvas).toBe(canvasA);
    expect(contextB.canvas).toBe(canvasB);
    expect(contextA.renderer).not.toBe(contextB.renderer);
    expect(contextA.status()).toBe('live');
    expect(contextB.status()).toBe('live');

    // Both are really drawing, each through its own renderer.
    runFrame();
    expect(renderers[0].draws).toBeGreaterThan(0);
    expect(renderers[1].draws).toBeGreaterThan(0);
  });

  it('keeps a different shader and a different texture in each context', () => {
    expect(engineA.setShader(spec('// shader A', [channel('a.png'), null, null, null]))).toEqual(
      [],
    );
    expect(engineB.setShader(spec('// shader B', [channel('b.png'), null, null, null]))).toEqual(
      [],
    );

    expect(engineA.activeShader.fragment).toContain('// shader A');
    expect(engineB.activeShader.fragment).toContain('// shader B');

    const textureA = engineA.channelTexture(0) as unknown as FakeTexture;
    const textureB = engineB.channelTexture(0) as unknown as FakeTexture;

    expect(textureA.url).toBe('a.png');
    expect(textureB.url).toBe('b.png');
    expect(textureA).not.toBe(textureB);
  });

  it('reports when a complete live frame has reached the canvas', () => {
    const rendered = vi.fn();
    engineA.onFrameRendered = rendered;

    runFrame();

    expect(rendered).toHaveBeenCalledTimes(1);
  });

  it('reports channel readiness after the current textures have settled', () => {
    engineA.setShader(spec('// textured', [channel('ready.png'), null, null, null]));

    expect(engineA.channelsReady).toBe(true);
  });

  it('isolates resources: every GPU object is tagged with the context that made it', () => {
    engineA.setShader(spec('// A', [channel('a.png'), null, null, null]));
    engineB.setShader(spec('// B', [channel('b.png'), null, null, null]));

    const textureA = engineA.channelTexture(0)!;
    const textureB = engineB.channelTexture(0)!;

    expect(ownerOf(textureA)).toBe('a');
    expect(ownerOf(textureB)).toBe('b');

    expect(contextA.owns(textureA)).toBe(true);
    expect(contextA.owns(textureB)).toBe(false);
    expect(contextB.owns(textureA)).toBe(false);
  });

  it('rejects a resource that belongs to another context', () => {
    engineA.setShader(spec('// A', [channel('a.png'), null, null, null]));
    engineB.setShader(spec('// B'));

    const textureA = engineA.channelTexture(0)!;

    expect(() => engineB.setChannelTexture(0, textureA)).toThrow(WrongContextError);
    expect(() => engineB.setChannelTexture(0, textureA)).toThrow(/belongs to WebGL context "a"/);

    // And the guard is the context's, not the engine's: claiming a resource
    // twice is refused just as loudly.
    expect(() => contextB.own(textureA)).toThrow(WrongContextError);

    // B's own texture is of course fine.
    const ownTexture = engineB.channelTexture(0)!;
    expect(() => engineB.setChannelTexture(0, ownTexture)).not.toThrow();
  });

  it('destroys one context without touching the other', () => {
    runFrame();
    const drawsBefore = renderers[1].draws;

    expect(registry.destroy('a')).toBe(true);

    expect(contextA.status()).toBe('disposed');
    expect(renderers[0].disposed).toBe(true);
    expect(registry.get('a')).toBeUndefined();

    // B is untouched: still registered, still live, still drawing.
    expect(registry.size()).toBe(1);
    expect(contextB.status()).toBe('live');
    expect(renderers[1].disposed).toBe(false);

    runFrame();
    expect(renderers[1].draws).toBeGreaterThan(drawsBefore);
  });

  it('loses and restores one context, leaving the other rendering', () => {
    engineA.setShader(spec('// shader A'));
    engineB.setShader(spec('// shader B'));

    const lostA = vi.fn();
    const restoredA = vi.fn();
    const lostB = vi.fn();
    engineA.onContextLost = lostA;
    engineA.onContextRestored = restoredA;
    engineB.onContextLost = lostB;

    loseContext(contextA);

    expect(contextA.status()).toBe('lost');
    expect(lostA).toHaveBeenCalledTimes(1);

    // The loss stopped at the canvas it happened on.
    expect(contextB.status()).toBe('live');
    expect(lostB).not.toHaveBeenCalled();

    // A's loop is suspended; B's is not.
    const drawsA = renderers[0].draws;
    const drawsB = renderers[1].draws;
    runFrame();
    runFrame();
    expect(renderers[0].draws).toBe(drawsA);
    expect(renderers[1].draws).toBeGreaterThan(drawsB);

    restoreContext(contextA);

    expect(contextA.status()).toBe('live');
    expect(restoredA).toHaveBeenCalledTimes(1);

    // The shader that was on screen is back, and so is the loop.
    expect(engineA.activeShader.fragment).toContain('// shader A');
    runFrame();
    expect(renderers[0].draws).toBeGreaterThan(drawsA);

    // B never saw any of it.
    expect(engineB.activeShader.fragment).toContain('// shader B');
    expect(lostB).not.toHaveBeenCalled();
  });

  it('applies a shader set while the context was lost once it comes back', () => {
    loseContext(contextA);

    // No driver to compile against, so nothing is reported as a failure…
    expect(engineA.setShader(spec('// set while lost'))).toEqual([]);

    restoreContext(contextA);

    // …and the shader is what the restored context is showing.
    expect(engineA.activeShader.fragment).toContain('// set while lost');
  });
});
