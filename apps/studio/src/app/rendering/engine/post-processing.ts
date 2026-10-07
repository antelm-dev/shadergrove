import type * as THREE from 'three';
import type { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import type { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import type { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import type { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

import {
  CUSTOM_EFFECT_API_VERSION,
  DEFAULT_RENDER,
  isCustomEffectRunnable,
  sanitizeParams,
  type CustomEffect,
  type PostProcessingEffect,
  type PostProcessingEffectType,
  type RenderSettings,
  type ShaderControl,
} from '@shadergrove/shared';
import type { CompileDiagnostic } from '@shadergrove/shared/diagnostic';
import type { GlContext } from '../gl-context';
import {
  CustomEffectCompiler,
  applyCustomValues,
  customEffectKey,
  effectDocId,
} from './custom-effect-pass';
import { VIGNETTE_SHADER, setVignetteUniforms } from './vignette-pass';

/** One built pass, whichever effect type it belongs to. */
type EffectPass = UnrealBloomPass | ShaderPass;

/** Sees the scene pass's result, in the composer's own buffer, before any effect has touched it. */
export type PreEffectObserver = (texture: THREE.Texture, width: number, height: number) => void;

/**
 * What happens to a frame between the shader and the canvas: the ordered
 * `postProcessing` chain from `RenderSettings`, applied after the final Image
 * pass.
 *
 * "Nothing active" is the case that matters most: a shader with no active
 * effect must reach the screen through `renderer.render` exactly as it always
 * did, with no composer allocated, no extra render targets, and — this is the
 * part worth protecting — no post-processing code downloaded at all.
 * `EffectComposer` and its passes are imported dynamically, inside a method,
 * so they stay out of the initial bundle and are never evaluated on the server,
 * where there is no WebGL for them to touch.
 *
 * Passes are built per `instanceId` and kept for as long as that instance is
 * in the chain, so each kind of change costs only what it has to:
 *
 * - a value (a slider drag) is a uniform push into the pass already built;
 * - an order, enable or add/remove change re-lists the composer's passes in
 *   place, reusing every pass that is still wanted — no recompile, no frame
 *   without effects;
 * - new code for a custom effect compiles one candidate on a 1×1 probe — at
 *   once when it is first seen, after `EFFECT_COMPILE_DEBOUNCE_MS` without
 *   change when it is an edit, at once again on a forced recompile. The
 *   driver rejecting it leaves that instance's last accepted pass running and
 *   reports why; a code that has never compiled leaves the instance out of the
 *   chain, with its diagnostic, and the document is never changed for it.
 *
 * The composer is freed the moment nothing in the chain is active, and dies
 * with the context: its render targets are GPU objects, so a lost context
 * leaves a husk to drop and rebuild rather than resize.
 *
 * `render()` is the whole point of the type: callers hand over a scene and a
 * camera and never learn which of the two paths drew them.
 */

/**
 * The three.js post-processing surface, as the dynamic import hands it over.
 * Named as an interface so a test can stand in for it, exactly as `GlBackend`
 * stands in for three itself — there is no WebGL in jsdom for a real
 * `EffectComposer` to allocate its render targets against.
 */
export interface PostProcessingModules {
  EffectComposer: typeof EffectComposer;
  RenderPass: typeof RenderPass;
  UnrealBloomPass: typeof UnrealBloomPass;
  ShaderPass: typeof ShaderPass;
}

export type PostProcessingLoader = () => Promise<PostProcessingModules>;

/**
 * The one place post-processing is pulled in. `import()` inside a function is
 * what keeps it out of the initial bundle and off the server: nothing here is
 * evaluated until something actually asks for an effect, which on the server
 * is never, because there is no renderer to ask.
 */
const loadPostProcessing: PostProcessingLoader = async () => {
  const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { ShaderPass }] =
    await Promise.all([
      import('three/examples/jsm/postprocessing/EffectComposer.js'),
      import('three/examples/jsm/postprocessing/RenderPass.js'),
      import('three/examples/jsm/postprocessing/UnrealBloomPass.js'),
      import('three/examples/jsm/postprocessing/ShaderPass.js'),
    ]);
  return { EffectComposer, RenderPass, UnrealBloomPass, ShaderPass };
};

interface BuiltPass {
  /** What the pass was built from: its type, plus a custom effect's code and controls. */
  key: string;
  pass: EffectPass;
  type: PostProcessingEffectType;
  /** A custom pass's controls as compiled: the only shape its uniforms can take values in. */
  controls: readonly ShaderControl[];
}

/**
 * Two context losses this close together, with custom effects running, and
 * they are suspended for the session: a GPU that resets while drawing an
 * effect would otherwise reset again on every restore.
 * (ponytail: a time-window heuristic; a per-effect GPU timer would pin the
 * culprit, if one ever proves necessary.)
 */
const REPEATED_LOSS_WINDOW_MS = 30_000;

/**
 * How long edited custom code has to stand still before it is compiled. The
 * draft takes every keystroke — so a save always has the latest text — and the
 * running program stays on screen until the typing pauses.
 */
export const EFFECT_COMPILE_DEBOUNCE_MS = 300;

function effectKey(effect: PostProcessingEffect): string {
  return effect.type === 'custom' ? `custom:${customEffectKey(effect.definition)}` : effect.type;
}

export class PostProcessing {
  private modules: PostProcessingModules | null = null;
  private loading: Promise<void> | null = null;

  private composer: EffectComposer | null = null;
  /** Built passes by `instanceId`, enabled or not, for as long as the instance is in the chain. */
  private readonly built = new Map<string, BuiltPass>();
  /** The passes the composer is drawing, after its `RenderPass`, in order. */
  private installed: EffectPass[] = [];

  /**
   * Custom code the driver rejected, by instance, with the key that failed: it
   * is not probed again until the code changes or a recompile is forced.
   */
  private readonly rejected = new Map<string, { key: string; diagnostics: CompileDiagnostic[] }>();
  private compiler: CustomEffectCompiler | null = null;

  /** Edited custom code waiting for the typing to pause, by instance. */
  private readonly pendingCompiles = new Map<
    string,
    { key: string; timer: ReturnType<typeof setTimeout> }
  >();
  /** Code whose wait is over: compiled on the next sync if it is still what the chain holds. */
  private readonly dueCompiles = new Map<string, string>();
  /** Set for the duration of a forced sync (Ctrl+Enter): nothing waits. */
  private compileNow = false;

  private current: RenderSettings = DEFAULT_RENDER;
  private size = { width: 1, height: 1, scale: 1 };
  private time = 0;

  /** Custom effects are off for the session, after repeated context losses. */
  private suspended = false;
  private lastLossWithCustom = -Infinity;

  /** Which shader's chain the built passes belong to; see `setScope`. */
  private scope: string | null = null;
  private reported = '[]';
  private reportedList: CompileDiagnostic[] = [];
  private disposed = false;

  /**
   * Fired once a composer has actually been created. A composer arrives
   * asynchronously, long after the resize that would have sized it, so whoever
   * owns the drawing-buffer size is asked to state it again.
   */
  onComposerCreated: (() => void) | null = null;

  /** Fired only when rendering actually switches between direct and composer paths. */
  onRenderPathChanged: (() => void) | null = null;

  /**
   * Fired whenever the chain may draw differently — including when it changes
   * asynchronously, after the modules load or edited custom code compiles — so
   * a paused preview knows to draw again.
   */
  onChanged: (() => void) | null = null;

  /**
   * Every custom-effect problem in the chain, whenever that list changes:
   * rejected code, an API this app does not run, a suspension. Each points at
   * its effect's document (`effectDocId`).
   */
  onDiagnostics: ((diagnostics: CompileDiagnostic[]) => void) | null = null;

  /**
   * `scene` and `camera` are the ones the composer's `RenderPass` will draw, and
   * are held only for the moment a composer is built. They are not this type's
   * state — the engine owns them — which is why `render()` is handed them again
   * rather than assuming the direct path should use these.
   */
  constructor(
    private readonly context: GlContext,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly load: PostProcessingLoader = loadPostProcessing,
  ) {}

  /** The settings in force. The engine reads these back on a context restore. */
  get settings(): RenderSettings {
    return this.current;
  }

  /**
   * The chain's effects that would actually run: the master switch on, the
   * effect enabled and, for custom code, an API this app runs while custom
   * effects are not suspended. An empty list is the direct-render case.
   */
  private runnable(): PostProcessingEffect[] {
    if (!this.current.postProcessing.enabled) return [];
    return this.current.postProcessing.effects.filter(
      (effect) =>
        effect.enabled &&
        (effect.type !== 'custom' || (!this.suspended && isCustomEffectRunnable(effect))),
    );
  }

  /**
   * Adopt new render settings. `force` is a recompile the user asked for: code
   * that was rejected is probed again, and suspended custom effects resume.
   */
  setSettings(render: RenderSettings, force = false): void {
    if (this.disposed) return;
    this.current = render;
    if (force) {
      this.rejected.clear();
      this.suspended = false;
    }

    const before = this.usesComposer();
    if (this.runnable().length === 0) {
      this.disposeComposer();
    } else if (!this.modules) {
      void this.ensureModules();
    } else if (this.context.status() !== 'lost') {
      this.compileNow = force;
      try {
        this.sync();
      } finally {
        this.compileNow = false;
      }
    }
    this.report();
    if (before !== this.usesComposer()) this.onRenderPathChanged?.();
    this.onChanged?.();
  }

  /**
   * Draw, without telling the caller how. With a composer drawing at least one
   * pass the frame goes through the chain; otherwise straight at the canvas —
   * which is also what happens while the import is still in flight.
   */
  render(scene: THREE.Scene, camera: THREE.Camera, observe?: PreEffectObserver): void {
    if (!this.usesComposer()) {
      this.context.renderer.render(scene, camera);
      return;
    }
    const composer = this.composer!;
    if (!observe) {
      composer.render();
      return;
    }
    // A capture asks to see the Image pass's own output, after the scene pass and before
    // any effect: a pass of the composer's own kind that draws nothing, for this one frame.
    const tap = {
      enabled: true,
      needsSwap: false,
      renderToScreen: false,
      setSize: () => undefined,
      render: (_renderer: unknown, _write: unknown, read: THREE.WebGLRenderTarget) =>
        observe(read.texture, read.width, read.height),
    };
    composer.insertPass(tap as unknown as EffectPass, 1);
    try {
      composer.render();
    } finally {
      composer.removePass(tap as unknown as EffectPass);
    }
  }

  /** The clock custom effects see as `u_time`, in seconds. */
  setTime(seconds: number): void {
    this.time = seconds;
    for (const { pass, type } of this.built.values()) {
      if (type === 'custom') (pass as ShaderPass).uniforms['u_time']!.value = seconds;
    }
  }

  /**
   * Size the chain with the drawing buffer. `scale` is the pixel ratio: the
   * composer takes CSS-ish size plus ratio. Bloom's kernel and custom effects'
   * `u_resolution` need real pixels; Vignette is pure UV math.
   */
  setSize(width: number, height: number, scale: number): void {
    this.size = { width, height, scale };
    this.composer?.setPixelRatio(scale);
    this.composer?.setSize(width, height);
    for (const built of this.built.values()) this.sizePass(built);
  }

  /**
   * The context is gone and so are the composer's render targets. Drop it; a
   * later `restore()` or `setSettings()` builds a fresh one if an effect is
   * still active. A second loss soon after one with custom effects running
   * suspends them, so a restore can come back at all.
   */
  invalidate(): void {
    if (this.runnable().some((effect) => effect.type === 'custom')) {
      const now = performance.now();
      if (now - this.lastLossWithCustom < REPEATED_LOSS_WINDOW_MS) this.suspended = true;
      this.lastLossWithCustom = now;
    }
    this.disposeComposer();
    this.rejected.clear();
  }

  /**
   * Name the shader whose chain is about to be set. Instance ids are unique
   * within one chain only — a duplicated shader keeps its effects' ids — so a
   * new scope forgets every built pass and rejection rather than let one
   * shader's last valid program stand in for another's.
   */
  setScope(scope: string | null): void {
    if (scope === this.scope) return;
    this.scope = scope;
    this.disposeComposer();
    this.rejected.clear();
  }

  /** Re-apply the settings in force, rebuilding the chain a lost context took. */
  restore(): void {
    this.setSettings(this.current);
  }

  /** Frees the chain. Safe to call repeatedly, and blocks an import still in flight. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.disposeComposer();
    this.compiler?.dispose();
    this.compiler = null;
    this.onComposerCreated = null;
    this.onDiagnostics = null;
  }

  /** Whether a frame goes through the composer rather than straight to the canvas. */
  usesComposer(): boolean {
    return this.composer !== null && this.installed.length > 0;
  }

  private async ensureModules(): Promise<void> {
    this.loading ??= this.load().then((modules) => {
      this.modules = modules;
    });
    await this.loading;
    // The import is long enough for anything to have happened: re-derive
    // everything from the settings in force now rather than at the request.
    if (!this.disposed) this.setSettings(this.current);
  }

  /** Brings the composer's pass list in line with the chain, building only what is missing. */
  private sync(): void {
    const { EffectComposer, RenderPass } = this.modules!;
    let created = false;
    if (!this.composer) {
      this.composer = new EffectComposer(this.context.renderer);
      this.composer.setPixelRatio(this.size.scale);
      this.composer.setSize(this.size.width, this.size.height);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.installed = [];
      created = true;
    }

    // An instance that left the chain takes its pass and its failure with it.
    const present = new Set(this.current.postProcessing.effects.map((e) => e.instanceId));
    for (const [id, built] of this.built) {
      if (present.has(id)) continue;
      built.pass.dispose();
      this.built.delete(id);
    }
    for (const id of this.rejected.keys()) if (!present.has(id)) this.rejected.delete(id);

    const next: EffectPass[] = [];
    for (const effect of this.runnable()) {
      const pass = this.passFor(effect);
      if (pass) next.push(pass);
    }

    if (next.length !== this.installed.length || next.some((p, i) => p !== this.installed[i])) {
      for (const pass of this.installed) this.composer.removePass(pass);
      for (const pass of next) this.composer.addPass(pass);
      this.installed = next;
    }

    if (created) this.onComposerCreated?.();
  }

  /**
   * The pass `effect` should draw with: the one already built if it was built
   * from the same thing (with its values pushed), otherwise a new one. `null`
   * for custom code that has never compiled.
   */
  private passFor(effect: PostProcessingEffect): EffectPass | null {
    const key = effectKey(effect);
    const built = this.built.get(effect.instanceId);
    if (built?.key === key) {
      // Back to the code it is already running: whatever a later edit broke is moot.
      this.rejected.delete(effect.instanceId);
      this.applyValues(effect, built.pass);
      return built.pass;
    }

    if (effect.type === 'custom') {
      const failed = this.rejected.get(effect.instanceId);
      if (failed?.key === key) return this.keepLastValid(effect, built);
      // An edit to code that already ran (or already failed) waits for the typing
      // to pause; code seen for the first time — a load, a new effect — compiles now.
      const editing = built !== undefined || failed !== undefined;
      if (editing && !this.compileNow && this.dueCompiles.get(effect.instanceId) !== key) {
        this.scheduleCompile(effect.instanceId, key);
        return this.keepLastValid(effect, built);
      }
      this.cancelCompile(effect.instanceId);
      const result = this.customCompiler().build(effect, this.time, {
        x: this.size.width * this.size.scale,
        y: this.size.height * this.size.scale,
      });
      if ('diagnostics' in result) {
        this.rejected.set(effect.instanceId, { key, diagnostics: result.diagnostics });
        return this.keepLastValid(effect, built);
      }
      this.rejected.delete(effect.instanceId);
      return this.install(
        effect.instanceId,
        key,
        new this.modules!.ShaderPass(result.material),
        'custom',
        built,
        effect.definition.controls,
      );
    }

    return this.install(effect.instanceId, key, this.createBuiltIn(effect), effect.type, built);
  }

  /** While new code fails, the last pass that compiled keeps running, with what values still fit it. */
  private keepLastValid(effect: CustomEffect, built: BuiltPass | undefined): EffectPass | null {
    if (!built) return null;
    // The values are read against the controls the pass was compiled with: an edit that
    // renamed a control or changed its type must not write, say, a colour into a float.
    applyCustomValues(
      (built.pass as ShaderPass).uniforms,
      built.controls,
      sanitizeParams(built.controls, effect.values),
    );
    return built.pass;
  }

  private install(
    instanceId: string,
    key: string,
    pass: EffectPass,
    type: PostProcessingEffectType,
    previous: BuiltPass | undefined,
    controls: readonly ShaderControl[] = [],
  ): EffectPass {
    previous?.pass.dispose();
    const built = { key, pass, type, controls };
    this.built.set(instanceId, built);
    this.sizePass(built);
    return pass;
  }

  /** A Bloom or Vignette pass with its live settings already applied. */
  private createBuiltIn(effect: Exclude<PostProcessingEffect, CustomEffect>): EffectPass {
    const { UnrealBloomPass, ShaderPass } = this.modules!;
    if (effect.type === 'bloom') {
      return new UnrealBloomPass(
        new this.context.three.Vector2(1, 1),
        effect.settings.strength,
        effect.settings.radius,
        effect.settings.threshold,
      );
    }
    const pass = new ShaderPass(VIGNETTE_SHADER);
    setVignetteUniforms(pass, effect.settings);
    return pass;
  }

  /** Pushes `effect`'s live settings or values into its already-built pass. */
  private applyValues(effect: PostProcessingEffect, pass: EffectPass): void {
    switch (effect.type) {
      case 'bloom': {
        const bloom = pass as UnrealBloomPass;
        bloom.strength = effect.settings.strength;
        bloom.radius = effect.settings.radius;
        bloom.threshold = effect.settings.threshold;
        break;
      }
      case 'vignette':
        setVignetteUniforms(pass as ShaderPass, effect.settings);
        break;
      case 'custom':
        applyCustomValues((pass as ShaderPass).uniforms, effect.definition.controls, effect.values);
        break;
    }
  }

  private sizePass({ pass, type }: BuiltPass): void {
    const { width, height, scale } = this.size;
    if (type === 'custom') {
      ((pass as ShaderPass).uniforms['u_resolution']!.value as THREE.Vector2).set(
        width * scale,
        height * scale,
      );
    } else if (type === 'bloom') {
      (pass as UnrealBloomPass).setSize(width * scale, height * scale);
    }
  }

  private customCompiler(): CustomEffectCompiler {
    this.compiler ??= new CustomEffectCompiler(this.context, this.camera);
    return this.compiler;
  }

  /** Tells the owner about every custom-effect problem in the chain, when the list changes. */
  private report(): void {
    const diagnostics: CompileDiagnostic[] = [];
    const { enabled, effects } = this.current.postProcessing;
    for (const effect of effects) {
      if (effect.type !== 'custom' || !effect.enabled || !enabled) continue;
      const at = { docId: effectDocId(effect.instanceId), docName: effect.definition.name };
      if (!isCustomEffectRunnable(effect)) {
        diagnostics.push({
          ...at,
          severity: 'warning',
          line: 0,
          source: 'fragment',
          message: `Skipped: written for effect API v${effect.definition.apiVersion}; this app runs v${CUSTOM_EFFECT_API_VERSION}.`,
        });
      } else if (this.suspended) {
        diagnostics.push({
          ...at,
          severity: 'warning',
          line: 0,
          source: 'fragment',
          message:
            'Paused after the graphics context was lost twice. Recompile (Ctrl+Enter) to resume.',
        });
      } else {
        diagnostics.push(...(this.rejected.get(effect.instanceId)?.diagnostics ?? []));
      }
    }
    const serialized = JSON.stringify(diagnostics);
    if (serialized === this.reported) return;
    this.reported = serialized;
    this.reportedList = diagnostics;
    this.onDiagnostics?.(diagnostics);
  }

  /**
   * Compile `effect` on the 1×1 probe without putting it anywhere: what the
   * driver says, or nothing if it compiles. How a plugin's effect is checked
   * before the host copies it into a shader.
   */
  probe(effect: CustomEffect): CompileDiagnostic[] {
    if (this.disposed || this.context.status() !== 'live') {
      return [{ severity: 'error', line: 0, source: 'fragment', message: 'No graphics context' }];
    }
    const result = this.customCompiler().build(effect, this.time, {
      x: this.size.width * this.size.scale,
      y: this.size.height * this.size.scale,
    });
    if ('diagnostics' in result) return result.diagnostics;
    result.material.dispose();
    return [];
  }

  /** The custom-effect problems for the settings in force, as last reported. */
  get diagnostics(): CompileDiagnostic[] {
    return this.reportedList;
  }

  /** (Re)starts the wait for one instance's edited code; the same code does not restart it. */
  private scheduleCompile(instanceId: string, key: string): void {
    const pending = this.pendingCompiles.get(instanceId);
    if (pending?.key === key) return;
    if (pending) clearTimeout(pending.timer);
    const timer = setTimeout(() => {
      this.pendingCompiles.delete(instanceId);
      this.dueCompiles.set(instanceId, key);
      this.setSettings(this.current);
    }, EFFECT_COMPILE_DEBOUNCE_MS);
    this.pendingCompiles.set(instanceId, { key, timer });
  }

  private cancelCompile(instanceId: string): void {
    const pending = this.pendingCompiles.get(instanceId);
    if (pending) clearTimeout(pending.timer);
    this.pendingCompiles.delete(instanceId);
    this.dueCompiles.delete(instanceId);
  }

  private disposeComposer(): void {
    for (const pending of this.pendingCompiles.values()) clearTimeout(pending.timer);
    this.pendingCompiles.clear();
    this.dueCompiles.clear();
    for (const built of this.built.values()) built.pass.dispose();
    this.built.clear();
    this.installed = [];
    this.composer?.dispose();
    this.composer = null;
  }
}
