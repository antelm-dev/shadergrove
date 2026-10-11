import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCustomEffect,
  type BloomSettings,
  type CustomEffect,
  type PostProcessingEffect,
  type RenderSettings,
  type ShaderControl,
  type VignetteSettings,
} from '@shadergrove/shared';
import type { CompileDiagnostic } from '@shadergrove/shared/diagnostic';
import { GlContext } from '../gl-context';
import { FakeMaterial, FakeRenderer, FakeScene, fakeBackend } from '../testing/fake-gl';
import { composeCustomEffect } from './custom-effect-pass';
import {
  EFFECT_COMPILE_DEBOUNCE_MS,
  PostProcessing,
  type PostProcessingModules,
} from './post-processing';

/**
 * The post-processing chain, and the decision the rest of the engine is not
 * allowed to see.
 *
 * The real `EffectComposer` allocates render targets in its constructor, which
 * needs a GPU jsdom does not have — so the post-processing classes come in
 * through the loader seam as fakes, the same way three itself comes in through
 * `GlBackend`. What is under test is not what an effect looks like; it is *when*
 * the chain and its passes are built, reused or torn down, which program each
 * instance runs, and which of the two paths a frame took.
 */

class FakeComposer {
  /**
   * Every composer ever built, newest last. A test cannot ask `PostProcessing`
   * whether it has one — that is the whole point of the type — so the fake
   * records it instead.
   */
  static readonly instances: FakeComposer[] = [];

  static reset(): void {
    FakeComposer.instances.length = 0;
  }

  static get created(): number {
    return FakeComposer.instances.length;
  }

  static last(): FakeComposer {
    const composer = FakeComposer.instances.at(-1);
    if (!composer) throw new Error('No composer was ever created.');
    return composer;
  }

  readonly passes: unknown[] = [];
  renders = 0;
  disposed = false;
  pixelRatio = 1;
  width = 0;
  height = 0;

  constructor(readonly renderer: unknown) {
    FakeComposer.instances.push(this);
  }

  addPass(pass: unknown): void {
    this.passes.push(pass);
  }
  removePass(pass: unknown): void {
    const index = this.passes.indexOf(pass);
    if (index >= 0) this.passes.splice(index, 1);
  }
  render(): void {
    this.renders++;
  }
  setPixelRatio(ratio: number): void {
    this.pixelRatio = ratio;
  }
  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }
  dispose(): void {
    this.disposed = true;
  }
}

class FakeRenderPass {
  constructor(
    readonly scene: unknown,
    readonly camera: unknown,
  ) {}
}

class FakeBloomPass {
  width = 0;
  height = 0;
  disposed = false;

  constructor(
    readonly resolution: unknown,
    public strength: number,
    public radius: number,
    public threshold: number,
  ) {}

  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** Stands in for `ShaderPass`, which Vignette and custom effects ride on. */
class FakeShaderPass {
  disposed = false;
  readonly uniforms: Record<string, { value: unknown }>;

  constructor(readonly shader: { uniforms: Record<string, { value: unknown }> }) {
    this.uniforms = Object.fromEntries(
      Object.entries(shader.uniforms).map(([key, uniform]) => [key, { value: uniform.value }]),
    );
  }

  dispose(): void {
    this.disposed = true;
  }
}

const fakeModules = {
  EffectComposer: FakeComposer,
  RenderPass: FakeRenderPass,
  UnrealBloomPass: FakeBloomPass,
  ShaderPass: FakeShaderPass,
} as unknown as PostProcessingModules;

/** A loader whose promise resolves at once; `flush` lets its continuation run. */
function controllableLoader(): {
  load: () => Promise<PostProcessingModules>;
  calls: number;
  flush: () => Promise<void>;
} {
  const state = {
    calls: 0,
    load: () => {
      state.calls++;
      return Promise.resolve(fakeModules);
    },
    flush: async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve();
    },
  };
  return state;
}

/** A loader the test settles by hand, so "the import is in flight" is a state. */
function deferredLoader(): {
  load: () => Promise<PostProcessingModules>;
  calls: number;
  resolve: () => Promise<void>;
} {
  let settle: (() => void) | null = null;
  const state = {
    calls: 0,
    load: () => {
      state.calls++;
      return new Promise<PostProcessingModules>((res) => (settle = () => res(fakeModules)));
    },
    resolve: async () => {
      settle?.();
      for (let i = 0; i < 4; i++) await Promise.resolve();
    },
  };
  return state;
}

/**
 * A chain with one Bloom effect. `enabled` toggles the effect itself;
 * `masterEnabled` the chain's master switch — independent knobs, since either
 * one off takes the direct-render path.
 */
function settings(
  overrides: Partial<BloomSettings> & { enabled?: boolean; masterEnabled?: boolean } = {},
): RenderSettings {
  const { enabled = true, masterEnabled = true, ...bloomOverrides } = overrides;
  return {
    postProcessing: {
      enabled: masterEnabled,
      effects: [{ ...bloomEffect(bloomOverrides), enabled }],
    },
  };
}

const OFF = settings({ enabled: false });

/** A chain in the exact effect order given. */
function chain(...effects: PostProcessingEffect[]): RenderSettings {
  return { postProcessing: { enabled: true, effects } };
}

function bloomEffect(
  overrides: Partial<BloomSettings> = {},
  instanceId = 'bloom',
): PostProcessingEffect {
  return {
    type: 'bloom',
    instanceId,
    enabled: true,
    settings: { strength: 0.3, radius: 0.5, threshold: 0.85, ...overrides },
  };
}

function vignetteEffect(
  overrides: Partial<VignetteSettings> = {},
  instanceId = 'vignette',
): PostProcessingEffect {
  return {
    type: 'vignette',
    instanceId,
    enabled: true,
    settings: { intensity: 0.4, softness: 0.5, roundness: 1, ...overrides },
  };
}

const GAIN: ShaderControl[] = [{ key: 'gain', type: 'number', default: 1, min: 0, max: 4 }];

function customEffect(
  instanceId: string,
  options: { source?: string; gain?: number; apiVersion?: number; name?: string } = {},
): CustomEffect {
  return createCustomEffect({
    instanceId,
    enabled: true,
    name: options.name ?? `Effect ${instanceId}`,
    source: options.source ?? 'vec4 effect(vec4 color, vec2 uv) { return color * u_gain; }',
    controls: GAIN,
    values: { gain: options.gain ?? 1 },
    ...(options.apiVersion === undefined ? {} : { apiVersion: options.apiVersion }),
  });
}

async function setup(id: string) {
  FakeComposer.reset();
  const { backend, renderers } = fakeBackend();
  const context = await GlContext.create(document.createElement('canvas'), { id, backend });
  return { context, renderer: renderers[0]!, scene: new FakeScene(), camera: {} };
}

describe('PostProcessing', () => {
  let context: GlContext;
  let renderer: FakeRenderer;
  let scene: FakeScene;
  let camera: object;
  let loader: ReturnType<typeof controllableLoader>;
  let post: PostProcessing;

  const create = (load: () => Promise<PostProcessingModules> = loader.load): PostProcessing =>
    new PostProcessing(context, scene as never, camera as never, load);

  beforeEach(async () => {
    ({ context, renderer, scene, camera } = await setup('post'));
    loader = controllableLoader();
    post = create();
  });

  afterEach(() => {
    post.dispose();
    context.dispose();
  });

  const loseContext = () => {
    context.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    post.invalidate();
  };
  const restoreContext = () => {
    context.canvas.dispatchEvent(new Event('webglcontextrestored'));
    post.restore();
  };

  // ---------------------------------------------------------------------------
  // The path a frame takes
  // ---------------------------------------------------------------------------

  it('draws straight at the canvas, and downloads nothing, while every effect is off', async () => {
    post.setSettings(OFF);
    await loader.flush();

    post.render(scene as never, camera as never);

    expect(loader.calls).toBe(0);
    expect(FakeComposer.created).toBe(0);
    expect(renderer.draws).toBe(1);
    expect(renderer.drawLog[0]!.scene).toBe(scene);
  });

  it('takes the direct path when the master switch is off, even with bloom individually enabled', async () => {
    post.setSettings(settings({ masterEnabled: false }));
    await loader.flush();

    post.render(scene as never, camera as never);

    expect(loader.calls).toBe(0);
    expect(FakeComposer.created).toBe(0);
    expect(renderer.draws).toBe(1);
  });

  it('builds the chain on the first settings that ask for an effect, then renders through it', async () => {
    post.setSettings(settings());

    // The import is in flight: the frame still reaches the canvas directly.
    post.render(scene as never, camera as never);
    expect(renderer.draws).toBe(1);

    await loader.flush();
    expect(loader.calls).toBe(1);
    expect(FakeComposer.created).toBe(1);

    post.render(scene as never, camera as never);
    expect(renderer.draws).toBe(1);
  });

  it('gives the composer a render pass for the scene it was constructed with', async () => {
    post.setSettings(settings());
    await loader.flush();

    const composer = FakeComposer.last();
    const [render, bloom] = composer.passes as [FakeRenderPass, FakeBloomPass];

    expect(composer.renderer).toBe(renderer);
    expect(render.scene).toBe(scene);
    expect(render.camera).toBe(camera);
    expect(bloom.strength).toBe(0.3);
  });

  it('asks to be sized once a composer exists, since the resize that mattered is long gone', async () => {
    const created = vi.fn();
    post.onComposerCreated = created;

    post.setSettings(settings());
    expect(created).not.toHaveBeenCalled();

    await loader.flush();
    expect(created).toHaveBeenCalledTimes(1);
  });

  it('reports only actual direct/composer render-path transitions', async () => {
    const changed = vi.fn();
    post.onRenderPathChanged = changed;

    post.setSettings(settings());
    expect(changed).not.toHaveBeenCalled();

    await loader.flush();
    expect(changed).toHaveBeenCalledTimes(1);

    post.setSettings(settings({ strength: 1.2 }));
    expect(changed).toHaveBeenCalledTimes(1);

    post.setSettings(OFF);
    expect(changed).toHaveBeenCalledTimes(2);

    post.setSettings(OFF);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  // ---------------------------------------------------------------------------
  // Live updates
  // ---------------------------------------------------------------------------

  it('pushes new bloom values through without rebuilding anything', async () => {
    post.setSettings(settings());
    await loader.flush();
    const composer = FakeComposer.last();
    const bloom = composer.passes[1] as FakeBloomPass;

    post.setSettings(settings({ strength: 1.4, radius: 0.9, threshold: 0.2 }));

    expect(composer.passes[1]).toBe(bloom);
    expect(bloom.strength).toBe(1.4);
    expect(bloom.radius).toBe(0.9);
    expect(bloom.threshold).toBe(0.2);
    expect(FakeComposer.created).toBe(1);
    expect(composer.disposed).toBe(false);
  });

  it('sizes the composer in buffer units and every bloom in real pixels', async () => {
    post.setSettings(chain(bloomEffect({}, 'a'), bloomEffect({}, 'b')));
    await loader.flush();
    const composer = FakeComposer.last();

    post.setSize(800, 600, 2);

    expect(composer.pixelRatio).toBe(2);
    expect([composer.width, composer.height]).toEqual([800, 600]);
    for (const pass of composer.passes.slice(1) as FakeBloomPass[]) {
      expect([pass.width, pass.height]).toEqual([1600, 1200]);
    }
  });

  it('accepts a size with no composer at all', () => {
    expect(() => post.setSize(800, 600, 1)).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Teardown and context loss
  // ---------------------------------------------------------------------------

  it('frees the chain when every effect is switched off, rather than leaving it bypassed', async () => {
    post.setSettings(settings());
    await loader.flush();
    const composer = FakeComposer.last();
    const bloom = composer.passes[1] as FakeBloomPass;

    post.setSettings(OFF);

    expect(composer.disposed).toBe(true);
    expect(bloom.disposed).toBe(true);
    const draws = renderer.draws;
    post.render(scene as never, camera as never);
    expect(renderer.draws).toBe(draws + 1);
  });

  it('switches off and on again, building a second chain without a second download', async () => {
    post.setSettings(settings());
    await loader.flush();
    post.setSettings(OFF);

    post.setSettings(settings({ strength: 0.8 }));
    await loader.flush();

    expect(FakeComposer.created).toBe(2);
    expect(loader.calls).toBe(1);
    expect((FakeComposer.last().passes[1] as FakeBloomPass).strength).toBe(0.8);
  });

  it('drops the chain on a lost context and rebuilds it on restore', async () => {
    post.setSettings(settings({ strength: 1.1 }));
    await loader.flush();
    const first = FakeComposer.last();

    loseContext();

    expect(first.disposed).toBe(true);
    const draws = renderer.draws;
    post.render(scene as never, camera as never);
    expect(renderer.draws).toBe(draws + 1);

    restoreContext();

    const second = FakeComposer.last();
    expect(second).not.toBe(first);
    expect((second.passes[1] as FakeBloomPass).strength).toBe(1.1);
  });

  it('restores to direct rendering when every effect was off when the context died', async () => {
    post.setSettings(OFF);
    loseContext();
    restoreContext();
    await loader.flush();

    expect(FakeComposer.created).toBe(0);
  });

  it('disposes repeatedly without complaint, and builds nothing after that', async () => {
    post.setSettings(settings());
    await loader.flush();
    const composer = FakeComposer.last();

    post.dispose();
    post.dispose();
    expect(composer.disposed).toBe(true);

    post.setSettings(settings());
    await loader.flush();
    expect(FakeComposer.created).toBe(1);
  });

  it('throws away a composer whose import landed after disposal', async () => {
    post.setSettings(settings());
    post.dispose();
    await loader.flush();

    expect(FakeComposer.created).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Races around the import
  // ---------------------------------------------------------------------------

  it('creates no composer when the effect is disabled before the import lands', async () => {
    const deferred = deferredLoader();
    const p = create(deferred.load);

    p.setSettings(settings());
    p.setSettings(OFF);
    await deferred.resolve();

    expect(FakeComposer.created).toBe(0);
    p.dispose();
  });

  it('creates no composer on a context lost before the import lands, and exactly one on restore', async () => {
    const deferred = deferredLoader();
    const p = create(deferred.load);

    p.setSettings(settings({ strength: 1.5 }));
    context.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    p.invalidate();
    await deferred.resolve();
    expect(FakeComposer.created).toBe(0);

    context.canvas.dispatchEvent(new Event('webglcontextrestored'));
    p.restore();

    expect(FakeComposer.created).toBe(1);
    expect((FakeComposer.last().passes[1] as FakeBloomPass).strength).toBe(1.5);
    expect(deferred.calls).toBe(1);
    p.dispose();
  });

  it('builds the chain in force when the import lands, not the one that asked for it', async () => {
    const deferred = deferredLoader();
    const p = create(deferred.load);

    p.setSettings(settings({ strength: 0.1 }));
    p.setSettings(OFF);
    p.setSettings(settings({ strength: 0.9 }));
    await deferred.resolve();

    expect(deferred.calls).toBe(1);
    expect(FakeComposer.created).toBe(1);
    expect((FakeComposer.last().passes[1] as FakeBloomPass).strength).toBe(0.9);
    p.dispose();
  });
});

describe('Chains of several instances', () => {
  let context: GlContext;
  let renderer: FakeRenderer;
  let scene: FakeScene;
  let camera: object;
  let loader: ReturnType<typeof controllableLoader>;
  let post: PostProcessing;

  beforeEach(async () => {
    ({ context, renderer, scene, camera } = await setup('post-chain'));
    loader = controllableLoader();
    post = new PostProcessing(context, scene as never, camera as never, loader.load);
  });

  afterEach(() => {
    post.dispose();
    context.dispose();
  });

  const installed = () => FakeComposer.last().passes.slice(1);

  it('builds a Vignette-only composer with its uniforms set', async () => {
    post.setSettings(chain(vignetteEffect({ intensity: 0.6, softness: 0.2, roundness: 0.8 })));
    await loader.flush();

    const [vignette] = installed() as [FakeShaderPass];
    expect(vignette.uniforms['uIntensity']!.value).toBe(0.6);
    expect(vignette.uniforms['uSoftness']!.value).toBe(0.2);
    expect(vignette.uniforms['uRoundness']!.value).toBe(0.8);

    post.render(scene as never, camera as never);
    expect(renderer.draws).toBe(0);
  });

  it('runs two instances of one type with their own settings', async () => {
    post.setSettings(
      chain(vignetteEffect({ intensity: 0.1 }, 'v1'), vignetteEffect({ intensity: 0.9 }, 'v2')),
    );
    await loader.flush();

    const [first, second] = installed() as [FakeShaderPass, FakeShaderPass];
    expect(first).not.toBe(second);
    expect(first.uniforms['uIntensity']!.value).toBe(0.1);
    expect(second.uniforms['uIntensity']!.value).toBe(0.9);

    post.setSettings(
      chain(vignetteEffect({ intensity: 0.1 }, 'v1'), vignetteEffect({ intensity: 0.5 }, 'v2')),
    );
    expect(first.uniforms['uIntensity']!.value).toBe(0.1);
    expect(second.uniforms['uIntensity']!.value).toBe(0.5);
  });

  it('reorders in place: same composer, same passes, new order', async () => {
    post.setSettings(chain(bloomEffect(), vignetteEffect()));
    await loader.flush();
    const composer = FakeComposer.last();
    const [bloom, vignette] = installed();

    post.setSettings(chain(vignetteEffect(), bloomEffect()));

    expect(FakeComposer.created).toBe(1);
    expect(composer.disposed).toBe(false);
    expect(installed()).toEqual([vignette, bloom]);
    expect(installed()[0]).toBe(vignette);
  });

  it('adds, disables and removes an instance without touching the others', async () => {
    post.setSettings(chain(bloomEffect()));
    await loader.flush();
    const [bloom] = installed() as [FakeBloomPass];

    post.setSettings(chain(bloomEffect(), vignetteEffect()));
    const [, vignette] = installed() as [FakeBloomPass, FakeShaderPass];
    expect(installed()).toHaveLength(2);
    expect(installed()[0]).toBe(bloom);

    // Disabled, it leaves the chain but its pass is kept for when it comes back.
    post.setSettings(chain(bloomEffect(), { ...vignetteEffect(), enabled: false }));
    expect(installed()).toEqual([bloom]);
    expect(vignette.disposed).toBe(false);
    post.setSettings(chain(bloomEffect(), vignetteEffect()));
    expect(installed()[1]).toBe(vignette);

    // Removed, it is freed.
    post.setSettings(chain(bloomEffect()));
    expect(vignette.disposed).toBe(true);
    expect(bloom.disposed).toBe(false);
    expect(FakeComposer.created).toBe(1);
  });

  it('disposes every built pass, not just the composer, on teardown', async () => {
    post.setSettings(chain(bloomEffect(), vignetteEffect()));
    await loader.flush();
    const [bloom, vignette] = installed() as [FakeBloomPass, FakeShaderPass];

    post.dispose();

    expect(bloom.disposed).toBe(true);
    expect(vignette.disposed).toBe(true);
  });
});

describe('Custom effects', () => {
  let context: GlContext;
  let renderer: FakeRenderer;
  let scene: FakeScene;
  let camera: object;
  let loader: ReturnType<typeof controllableLoader>;
  let post: PostProcessing;
  let reports: CompileDiagnostic[][];

  beforeEach(async () => {
    ({ context, renderer, scene, camera } = await setup('post-custom'));
    loader = controllableLoader();
    post = new PostProcessing(context, scene as never, camera as never, loader.load);
    reports = [];
    post.onDiagnostics = (diagnostics) => reports.push(diagnostics);
    breakCompilesOf('BROKEN');
    // Edited code compiles once the typing pauses: the tests decide when that is.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    post.dispose();
    context.dispose();
    vi.useRealTimers();
  });

  const pause = () => vi.advanceTimersByTime(EFFECT_COMPILE_DEBOUNCE_MS);

  const installed = () => FakeComposer.last().passes.slice(1) as FakeShaderPass[];
  const programOf = (pass: FakeShaderPass) => pass.shader as unknown as FakeMaterial;
  const probes = () => renderer.drawLog.filter((draw) => draw.scene !== scene).length;

  /**
   * Make the driver reject any program whose fragment contains `marker`, the
   * way three reports it: through `debug.onShaderError`, set only while probing.
   */
  function breakCompilesOf(marker: string): void {
    const original = renderer.render.bind(renderer);
    renderer.render = ((target?: unknown) => {
      const handler = renderer.debug.onShaderError as
        | ((gl: unknown, program: unknown, vertex: unknown, fragment: unknown) => void)
        | null;
      const material = (target as FakeScene | undefined)?.children?.[0] as
        | { material?: FakeMaterial }
        | undefined;
      const fragment = material?.material?.fragmentShader ?? '';
      if (handler && fragment.includes(marker)) {
        const line = fragment.split('\n').findIndex((text) => text.includes(marker)) + 1;
        handler(
          {
            getShaderSource: () => '',
            getShaderInfoLog: (shader: unknown) =>
              shader === 'fragment' ? `ERROR: 0:${line}: '${marker}' : undeclared identifier` : '',
            getProgramInfoLog: () => '',
          },
          {},
          'vertex',
          'fragment',
        );
      }
      original(target);
    }) as typeof renderer.render;
  }

  it("wraps the author's effect() in the v1 contract", () => {
    const { fragment, headerLines } = composeCustomEffect(customEffect('c').definition);
    const lines = fragment.split('\n');
    expect(lines.slice(0, headerLines)).toEqual([
      'uniform sampler2D tDiffuse;',
      'uniform vec2 u_resolution;',
      'uniform float u_time;',
      'uniform float u_gain;',
      'varying vec2 vUv;',
    ]);
    expect(lines[headerLines]).toContain('vec4 effect(vec4 color, vec2 uv)');
    expect(lines.at(-1)).toBe(
      'void main() { gl_FragColor = effect(texture2D(tDiffuse, vUv), vUv); }',
    );
  });

  it('runs two instances with their own values, which change without a recompile', async () => {
    post.setSettings(chain(customEffect('a', { gain: 0.5 }), customEffect('b', { gain: 2 })));
    await loader.flush();
    const [a, b] = installed();
    expect(a!.uniforms['u_gain']!.value).toBe(0.5);
    expect(b!.uniforms['u_gain']!.value).toBe(2);
    const probed = probes();

    post.setSettings(chain(customEffect('a', { gain: 3 }), customEffect('b', { gain: 2 })));

    expect(installed()).toEqual([a, b]);
    expect(a!.uniforms['u_gain']!.value).toBe(3);
    expect(probes()).toBe(probed);
  });

  it('probes only the instance whose code changed', async () => {
    post.setSettings(chain(customEffect('a'), customEffect('b')));
    await loader.flush();
    const [a, b] = installed();
    const probed = probes();

    const newCode = 'vec4 effect(vec4 color, vec2 uv) { return color.bgra * u_gain; }';
    post.setSettings(chain(customEffect('a'), customEffect('b', { source: newCode })));
    pause();

    expect(probes()).toBe(probed + 1);
    expect(installed()[0]).toBe(a);
    expect(installed()[1]).not.toBe(b);
    expect(b!.disposed).toBe(true);
    expect(programOf(installed()[1]!).fragmentShader).toContain('color.bgra');
  });

  it("keeps the last valid program on a bad edit, and reports the author's line", async () => {
    post.setSettings(chain(customEffect('a', { name: 'Grain' })));
    await loader.flush();
    const [valid] = installed();

    const broken = 'vec4 effect(vec4 color, vec2 uv) {\n  return BROKEN;\n}';
    post.setSettings(chain(customEffect('a', { name: 'Grain', source: broken, gain: 2 })));
    pause();

    expect(installed()).toEqual([valid]);
    expect(valid!.disposed).toBe(false);
    // Values still reach the last valid program.
    expect(valid!.uniforms['u_gain']!.value).toBe(2);
    expect(reports.at(-1)).toEqual([
      expect.objectContaining({
        severity: 'error',
        line: 2,
        docId: '@effect/a',
        docName: 'Grain',
      }),
    ]);

    // The same broken code is not probed again on every unrelated update...
    const probed = probes();
    post.setSettings(chain(customEffect('a', { name: 'Grain', source: broken, gain: 3 })));
    expect(probes()).toBe(probed);

    // ...going back to the code that runs clears the report without a recompile...
    post.setSettings(chain(customEffect('a', { name: 'Grain' })));
    expect(installed()[0]).toBe(valid);
    expect(probes()).toBe(probed);
    expect(reports.at(-1)).toEqual([]);

    // ...and new code that compiles takes over.
    const fixed = 'vec4 effect(vec4 color, vec2 uv) { return color.gbra; }';
    post.setSettings(chain(customEffect('a', { name: 'Grain', source: fixed })));
    pause();
    expect(installed()[0]).not.toBe(valid);
    expect(valid!.disposed).toBe(true);
  });

  it('keeps the last valid program when a control changes type and the new code fails', async () => {
    post.setSettings(chain(customEffect('a', { gain: 0.5 })));
    await loader.flush();
    const [valid] = installed();

    // `gain` becomes a colour while the code still uses it as a float — rejected.
    const recoloured = createCustomEffect({
      instanceId: 'a',
      enabled: true,
      source: 'vec4 effect(vec4 color, vec2 uv) { return BROKEN * u_gain; }',
      controls: [{ key: 'gain', type: 'color', default: '#ff0000' }],
      values: { gain: '#00ff00' },
    });
    expect(() => post.setSettings(chain(recoloured))).not.toThrow();
    expect(() => pause()).not.toThrow();

    expect(installed()).toEqual([valid]);
    // The old float uniform keeps a number: the colour is not written into it.
    expect(valid!.uniforms['u_gain']!.value).toBe(1);
  });

  it('compiles edited code once the typing pauses, keeping the running program until then', async () => {
    post.setSettings(chain(customEffect('a')));
    await loader.flush();
    const [running] = installed();
    const probed = probes();
    const typed = (n: number) =>
      customEffect('a', { source: `vec4 effect(vec4 c, vec2 uv) { return c * ${n}.0; }` });

    // Three keystrokes in a row: nothing compiles, the running program stays.
    for (const n of [1, 2, 3]) {
      post.setSettings(chain(typed(n)));
      vi.advanceTimersByTime(EFFECT_COMPILE_DEBOUNCE_MS - 1);
    }
    expect(probes()).toBe(probed);
    expect(installed()).toEqual([running]);

    // The pause: the last version, and only it, is compiled.
    vi.advanceTimersByTime(1);
    expect(probes()).toBe(probed + 1);
    expect(programOf(installed()[0]!).fragmentShader).toContain('c * 3.0');
  });

  it('compiles an edit at once on a forced recompile (Ctrl+Enter)', async () => {
    post.setSettings(chain(customEffect('a')));
    await loader.flush();
    const probed = probes();

    const edited = customEffect('a', { source: 'vec4 effect(vec4 c, vec2 uv) { return c.bgra; }' });
    post.setSettings(chain(edited), true);

    expect(probes()).toBe(probed + 1);
    expect(programOf(installed()[0]!).fragmentShader).toContain('c.bgra');
    // Nothing is left waiting to compile it a second time.
    pause();
    expect(probes()).toBe(probed + 1);
  });

  it('drops a pending compile when the effect leaves the chain', async () => {
    post.setSettings(chain(customEffect('a')));
    await loader.flush();
    post.setSettings(
      chain(customEffect('a', { source: 'vec4 effect(vec4 c, vec2 uv) { return c; }' })),
    );
    const probed = probes();

    post.setSettings(chain());
    pause();

    expect(probes()).toBe(probed);
  });

  it("never falls back on another shader's program for the same instance id", async () => {
    post.setScope('shader-a');
    post.setSettings(chain(customEffect('a')));
    await loader.flush();
    const [fromA] = installed();

    // A duplicate of A keeps the id; its own code for it does not compile.
    post.setScope('shader-b');
    post.setSettings(
      chain(customEffect('a', { source: 'vec4 effect(vec4 c, vec2 uv) { return BROKEN; }' })),
    );

    expect(fromA!.disposed).toBe(true);
    expect(post.usesComposer()).toBe(false);
    expect(reports.at(-1)).toEqual([expect.objectContaining({ docId: '@effect/a' })]);
  });

  it('keeps its passes while the scope stays the same', async () => {
    post.setScope('shader-a');
    post.setSettings(chain(customEffect('a')));
    await loader.flush();
    const [pass] = installed();

    post.setScope('shader-a');
    post.setSettings(chain(customEffect('a', { gain: 2 })));

    expect(installed()).toEqual([pass]);
  });

  it('leaves out an instance that has never compiled, with its diagnostic, and the rest runs', async () => {
    post.setSettings(
      chain(
        customEffect('bad', { source: 'vec4 effect(vec4 c, vec2 uv) { return BROKEN; }' }),
        bloomEffect(),
      ),
    );
    await loader.flush();

    expect(installed()).toHaveLength(1);
    expect(installed()[0]).toBeInstanceOf(FakeBloomPass);
    expect(reports.at(-1)).toEqual([expect.objectContaining({ docId: '@effect/bad', line: 1 })]);
  });

  it('draws directly when its only effect has never compiled', async () => {
    post.setSettings(chain(customEffect('bad', { source: 'BROKEN' })));
    await loader.flush();
    const draws = renderer.draws;

    post.render(scene as never, camera as never);

    expect(renderer.draws).toBe(draws + 1);
    expect(post.usesComposer()).toBe(false);
  });

  it('skips an effect from a newer API with a warning, and never compiles it', async () => {
    post.setSettings(chain(customEffect('future', { apiVersion: 2 }), bloomEffect()));
    await loader.flush();

    expect(installed()).toHaveLength(1);
    expect(probes()).toBe(0);
    expect(reports.at(-1)).toEqual([
      expect.objectContaining({ severity: 'warning', docId: '@effect/future' }),
    ]);
  });

  it('feeds u_time and u_resolution in real pixels', async () => {
    post.setSize(400, 300, 2);
    post.setSettings(chain(customEffect('a')));
    await loader.flush();
    const [pass] = installed();
    expect(pass!.uniforms['u_resolution']!.value).toMatchObject({ x: 800, y: 600 });

    post.setTime(12.5);
    post.setSize(100, 50, 1);

    expect(pass!.uniforms['u_time']!.value).toBe(12.5);
    expect(pass!.uniforms['u_resolution']!.value).toMatchObject({ x: 100, y: 50 });
  });

  it('suspends custom effects after two context losses in a row, until a forced recompile', async () => {
    const effects = chain(customEffect('a'), bloomEffect());
    post.setSettings(effects);
    await loader.flush();

    for (let i = 0; i < 2; i++) {
      context.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
      post.invalidate();
      context.canvas.dispatchEvent(new Event('webglcontextrestored'));
      post.restore();
    }

    expect(installed()).toHaveLength(1);
    expect(installed()[0]).toBeInstanceOf(FakeBloomPass);
    expect(reports.at(-1)).toEqual([
      expect.objectContaining({ severity: 'warning', docId: '@effect/a' }),
    ]);

    post.setSettings(effects, true);
    expect(installed()).toHaveLength(2);
    expect(reports.at(-1)).toEqual([]);
  });

  it('forgets what it built for an instance that left the chain', async () => {
    post.setSettings(chain(customEffect('a'), customEffect('b')));
    await loader.flush();
    const [a, b] = installed();

    post.setSettings(chain(customEffect('b')));

    expect(a!.disposed).toBe(true);
    expect(installed()).toEqual([b]);
  });
});
