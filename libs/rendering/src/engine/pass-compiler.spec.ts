import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { DEFAULT_RENDER, legacyTextureBindings, type ShaderControl } from '@shadergrove/shared';

import type { EngineOutputLevel, EngineOutputSource } from '../engine-output-sink';
import { GlContext } from '../gl-context';
import { BufferTargets } from '../pass-targets';
import { FakeMaterial, FakeRenderTarget, fakeBackend, type FakeRenderer } from '../testing/fake-gl';
import { ChannelBinder } from './channel-binder';
import { PassCompiler, type EnginePass, type MultiPassSpec } from './pass-compiler';
import { TextureManager } from './texture-manager';
import { UniformRegistry } from './uniform-registry';

/**
 * The compiler on its own, without an engine around it.
 *
 * `multipass.spec.ts` covers what the pipeline *looks like* from the outside;
 * this covers the bookkeeping underneath that nobody can see from there — which
 * materials were freed and when, what the registry was told, and what a lost
 * context leaves behind. Every one of those is a resource leak or a use-after-
 * free when it goes wrong, and none of them changes a single assertion about
 * render order.
 */

const VERTEX = 'void main() { gl_Position = vec4(position, 1.0); }';

function enginePass(id: string, kind: 'image' | 'buffer', fragment: string): EnginePass {
  return {
    id,
    kind,
    fragment,
    spans: [],
    channels: legacyTextureBindings(),
    resolution: { mode: 'viewport', scale: 1, width: 1, height: 1 },
    filter: 'linear',
    wrap: 'clamp',
  };
}

function spec(passes: EnginePass[], extra: Partial<MultiPassSpec> = {}): MultiPassSpec {
  return {
    vertex: VERTEX,
    controls: [],
    params: {},
    render: DEFAULT_RENDER,
    passes,
    textures: [null, null, null, null],
    ...extra,
  };
}

/** Buffer A, then the Image pass — the smallest project with two programs in it. */
function project(a = 'BUFFER_A', image = 'IMAGE'): MultiPassSpec {
  return spec([enginePass('a', 'buffer', a), enginePass('image', 'image', image)]);
}

describe('PassCompiler', () => {
  let renderer: FakeRenderer;
  let context: GlContext;
  let registry: UniformRegistry;
  let textures: TextureManager;
  let targets: BufferTargets;
  let compiler: PassCompiler;
  let write: Mock<(level: EngineOutputLevel, source: EngineOutputSource, message: string) => void>;
  let now = 0;

  beforeEach(async () => {
    FakeRenderTarget.reset();
    now = 0;

    const { backend, renderers } = fakeBackend();
    context = await GlContext.create(document.createElement('canvas'), { id: 'gl', backend });
    renderer = renderers[0] as unknown as FakeRenderer;

    registry = new UniformRegistry();
    textures = new TextureManager(context);
    targets = new BufferTargets(context);
    write = vi.fn();

    const T = context.three;
    compiler = new PassCompiler(
      context,
      context.own(new T.PlaneGeometry(2, 2)),
      new T.OrthographicCamera(-1, 1, 1, -1, 0, 1),
      registry,
      new ChannelBinder(textures, targets),
      { clickData: [], time: () => now, write },
    );
  });

  afterEach(() => {
    compiler.dispose();
    textures.dispose();
    targets.dispose();
    context.dispose();
    vi.restoreAllMocks();
  });

  /**
   * Make every compile fail the way a driver does: three.js reports it through
   * `debug.onShaderError`, which is set only while the compiler is probing.
   */
  function breakCompiles(message = "'x' : undeclared identifier"): () => void {
    const original = renderer.render.bind(renderer);
    let active = true;

    renderer.render = ((scene?: unknown) => {
      const handler = renderer.debug.onShaderError as
        | ((gl: unknown, program: unknown, vertex: unknown, fragment: unknown) => void)
        | null;

      if (handler && active) {
        handler(
          {
            getShaderSource: () => '',
            getShaderInfoLog: (shader: unknown) =>
              shader === 'fragment' ? `ERROR: 0:1: ${message}` : '',
            getProgramInfoLog: () => '',
          },
          {},
          'vertex',
          'fragment',
        );
      }

      original(scene);
    }) as typeof renderer.render;

    return () => {
      active = false;
    };
  }

  const material = (id: string): FakeMaterial => compiler.materialOf(id) as unknown as FakeMaterial;

  // ---------------------------------------------------------------------------
  // Selective recompilation
  // ---------------------------------------------------------------------------

  it('accepts every pass and reports the image program as active', () => {
    expect(compiler.compile(project())).toEqual([]);

    expect(compiler.passes.map((pass) => pass.id)).toEqual(['a', 'image']);
    expect(compiler.activeShader.fragment).toContain('IMAGE');
    expect(compiler.material).toBe(compiler.imagePass?.material);
  });

  it('reuses a program whose source and vertex have not moved', () => {
    compiler.compile(project());
    const before = material('a');

    compiler.compile(project('BUFFER_A edited'));

    expect(material('a')).not.toBe(before);
    // …and the program it replaced is gone, not merely dropped.
    expect(before.disposed).toBe(true);
    expect(material('image').disposed).toBe(false);
  });

  it('leaves an untouched pass alone entirely', () => {
    compiler.compile(project());
    const before = { a: material('a'), image: material('image') };

    compiler.compile(project());

    expect(material('a')).toBe(before.a);
    expect(material('image')).toBe(before.image);
    expect(before.a.disposed).toBe(false);
  });

  it('rebuilds every pass when the compile is forced', () => {
    compiler.compile(project());
    const before = { a: material('a'), image: material('image') };

    compiler.compile(project(), true);

    expect(material('a')).not.toBe(before.a);
    expect(material('image')).not.toBe(before.image);
    expect(before.a.disposed).toBe(true);
    expect(before.image.disposed).toBe(true);
  });

  it('rebuilds every pass when the vertex shader changes', () => {
    compiler.compile(project());
    const before = { a: material('a'), image: material('image') };

    compiler.compile(spec(project().passes as EnginePass[], { vertex: `${VERTEX}\n// v2` }));

    expect(material('a')).not.toBe(before.a);
    expect(material('image')).not.toBe(before.image);
  });

  it('disposes a pass that has left the project', () => {
    compiler.compile(project());
    const orphan = material('a');

    compiler.compile(spec([enginePass('image', 'image', 'IMAGE')]));

    expect(orphan.disposed).toBe(true);
    expect(compiler.passes.map((pass) => pass.id)).toEqual(['image']);
  });

  // ---------------------------------------------------------------------------
  // Failure
  // ---------------------------------------------------------------------------

  it('disposes a rejected candidate and keeps the last accepted program', () => {
    compiler.compile(project('GOOD'));
    const good = material('a');

    const heal = breakCompiles();
    const diagnostics = compiler.compile(project('BROKEN'));
    heal();

    expect(diagnostics.length).toBeGreaterThan(0);
    expect(compiler.materialOf('a')).toBe(good);
    expect(good.disposed).toBe(false);
    expect(good.fragmentShader).toContain('GOOD');
  });

  it('keeps the image program on screen when its candidate is rejected', () => {
    compiler.compile(project());
    const image = compiler.material;

    const heal = breakCompiles();
    compiler.compile(project('BUFFER_A', 'BROKEN IMAGE'));
    heal();

    expect(compiler.material).toBe(image);
    expect(compiler.activeShader.fragment).toContain('IMAGE');
  });

  it('accepts a pass with no previous program only once it compiles', () => {
    const heal = breakCompiles();
    expect(compiler.compile(project()).length).toBeGreaterThan(0);
    expect(compiler.passes).toEqual([]);
    // Nothing was accepted, so the placeholder is still what would be drawn.
    expect(compiler.activeShader.fragment).toContain('gl_FragColor');
    heal();

    expect(compiler.compile(project())).toEqual([]);
    expect(compiler.passes.map((pass) => pass.id)).toEqual(['a', 'image']);
  });

  // ---------------------------------------------------------------------------
  // Compile output
  // ---------------------------------------------------------------------------

  it('logs a pass failure once, however many times the same break is recompiled', () => {
    const heal = breakCompiles();

    compiler.compile(project('BROKEN'));
    const first = write.mock.calls.length;
    expect(first).toBeGreaterThan(0);

    // A debounce firing on source nobody touched, and then a forced recompile of
    // every pass: neither is news, and neither may repeat the driver's log.
    compiler.compile(project('BROKEN'));
    compiler.compile(project('BROKEN'), true);
    heal();

    const summary = write.mock.calls.filter(([, , message]) =>
      String(message).startsWith('Compilation failed with'),
    );
    expect(write.mock.calls).toHaveLength(first + summary.length);
  });

  it('logs the failure again once the pass has been fixed and broken anew', () => {
    const heal = breakCompiles();
    compiler.compile(project('BROKEN'));
    heal();

    write.mockClear();
    compiler.compile(project('FIXED'));
    expect(write).not.toHaveBeenCalled();

    const again = breakCompiles();
    compiler.compile(project('BROKEN AGAIN'));
    again();

    expect(write).toHaveBeenCalled();
  });

  it('summarises only a forced compile', () => {
    compiler.compile(project());
    expect(write).not.toHaveBeenCalled();

    compiler.compile(project(), true);
    expect(write).toHaveBeenCalledWith('info', 'compiler', 'Shader compiled successfully.');
  });

  it('summarises a forced compile that failed with a count', () => {
    const heal = breakCompiles();
    compiler.compile(project(), true);
    heal();

    expect(write).toHaveBeenCalledWith(
      'error',
      'compiler',
      expect.stringContaining('Compilation failed with'),
    );
  });

  // ---------------------------------------------------------------------------
  // The uniform registry
  // ---------------------------------------------------------------------------

  it('registers every accepted pass, buffers first', () => {
    compiler.compile(project());
    expect(registry.ids).toEqual(['a', 'image']);

    compiler.compile(spec([enginePass('image', 'image', 'IMAGE')]));
    expect(registry.ids).toEqual(['image']);
  });

  it('makes the accepted image uniforms the primary map', () => {
    compiler.compile(project());
    expect(registry.primary).toBe(compiler.imagePass?.uniforms);
  });

  it('hands the controls to the registry, so a param reaches every pass', () => {
    const controls: readonly ShaderControl[] = [
      { key: 'speed', type: 'number', default: 1, min: 0, max: 4 },
    ];
    compiler.compile(spec(project().passes as EnginePass[], { controls, params: { speed: 2 } }));

    expect(compiler.imagePass?.uniforms['u_speed'].value).toBe(2);

    registry.setParam('speed', 3);
    for (const pass of compiler.passes) expect(pass.uniforms['u_speed'].value).toBe(3);
  });

  it('re-applies params to a pass whose program was left alone', () => {
    const controls: readonly ShaderControl[] = [
      { key: 'speed', type: 'number', default: 1, min: 0, max: 4 },
    ];
    compiler.compile(spec(project().passes as EnginePass[], { controls, params: { speed: 1 } }));
    const before = compiler.materialOf('a');

    compiler.compile(spec(project().passes as EnginePass[], { controls, params: { speed: 4 } }));

    expect(compiler.materialOf('a')).toBe(before);
    expect(compiler.find('a')?.uniforms['u_speed'].value).toBe(4);
  });

  it('carries the live resolution across a recompile', () => {
    compiler.compile(project());
    (registry.primary['iResolution'].value as { set(x: number, y: number): void }).set(800, 600);

    compiler.compile(project('BUFFER_A', 'IMAGE edited'));

    expect(registry.primary['iResolution'].value).toMatchObject({ x: 800, y: 600 });
  });

  it('starts a freshly built pass at the clock it was given', () => {
    now = 12.5;
    compiler.compile(project());

    expect(compiler.imagePass?.uniforms['iTime'].value).toBe(12.5);
  });

  // ---------------------------------------------------------------------------
  // Context loss
  // ---------------------------------------------------------------------------

  it('remembers a spec it was never asked to compile', () => {
    const requested = project();
    compiler.remember(requested);

    expect(compiler.lastSpec).toBe(requested);
    expect(compiler.passes).toEqual([]);
  });

  it('forgets the accepted programs on invalidate, without disposing them', () => {
    const requested = project();
    compiler.compile(requested);
    const dead = material('a');

    compiler.invalidate();

    // The GPU freed them when the context died; disposing husks would be three
    // talking to a driver that is gone.
    expect(dead.disposed).toBe(false);
    expect(compiler.passes).toEqual([]);
    expect(registry.ids).toEqual([]);
    // What survives is the replay data and the map every read goes to.
    expect(compiler.lastSpec).toBe(requested);
    expect(registry.primary['iResolution']).toBeDefined();
  });

  it('rebuilds rather than reuses after an invalidate', () => {
    compiler.compile(project());
    const dead = material('a');

    compiler.invalidate();
    compiler.compile(project());

    // Recognising the unchanged source and "reusing" a program that no longer
    // exists on the GPU is exactly the bug the invalidation prevents.
    expect(material('a')).not.toBe(dead);
  });

  // ---------------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------------

  it('frees every accepted program and the probe target', () => {
    compiler.compile(project());
    const buffer = material('a');
    const image = material('image');
    const probe = FakeRenderTarget.created.find((target) => target.width === 1)!;

    compiler.dispose();

    expect(buffer.disposed).toBe(true);
    expect(image.disposed).toBe(true);
    expect(probe.disposed).toBe(true);
  });

  it('creates the compile probe without depth or stencil attachments', () => {
    const probe = FakeRenderTarget.created.find(
      (target) =>
        target.width === 1 &&
        target.height === 1 &&
        target.options['depthBuffer'] === false &&
        target.options['stencilBuffer'] === false,
    );
    expect(probe).toBeDefined();
  });

  it('frees the placeholder program even when nothing was ever compiled', () => {
    const placeholder = compiler.material as unknown as FakeMaterial;

    compiler.dispose();

    expect(placeholder.disposed).toBe(true);
  });

  it('is idempotent, and compiles nothing once disposed', () => {
    compiler.compile(project());
    compiler.dispose();

    expect(() => compiler.dispose()).not.toThrow();
    expect(compiler.compile(project())).toEqual([]);
    expect(compiler.passes).toEqual([]);
  });
});
