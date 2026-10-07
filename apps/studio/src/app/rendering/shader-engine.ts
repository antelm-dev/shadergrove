import type * as THREE from 'three';

import {
  MAX_WAVES,
  legacyTextureBindings,
  type CustomEffect,
  type ParamValue,
  type RenderSettings,
  type ShaderControl,
  type ShaderParams,
} from '@shadergrove/shared';
import type { CompileDiagnostic } from '@shadergrove/shared/diagnostic';
import type { EngineOutputLevel, EngineOutputSink, EngineOutputSource } from './engine-output-sink';
import { GlContext, type GlContextOptions, type ThreeModule } from './gl-context';
import { BufferTargets, type TargetSpec } from './pass-targets';
import { CHANNEL_UNIFORMS, ChannelBinder } from './engine/channel-binder';
import { PassCompiler, type MultiPassSpec } from './engine/pass-compiler';
import { PostProcessing } from './engine/post-processing';
import { CHANNEL_COUNT, TextureManager, type ChannelSource } from './engine/texture-manager';
import { UniformRegistry } from './engine/uniform-registry';
import {
  CaptureSession,
  FrameCaptureError,
  FrameInspector,
  type CaptureOptions,
  type FrameSnapshot,
  type FrameSource,
  type InvalidationReason,
} from './render-inspection';
import {
  observeFrozenPoint,
  type ObservationRequest,
  type ObservationResult,
} from './render-observation';
import {
  IMAGE_PASS_ID,
  POST_PASS_ID,
  PerformanceProfiler,
  type ProfilerSnapshot,
} from './performance-profiler';

export type { ChannelSource } from './engine/texture-manager';
export type { EnginePass, MultiPassSpec, PassRuntime } from './engine/pass-compiler';

/**
 * The WebGL side of the studio. Knows nothing about Angular, HTTP or the
 * document model — you hand it a shader and some parameter values, and it puts
 * pixels on a canvas.
 *
 * The contract that matters: **a failed compile never takes down the picture.**
 * A candidate shader is compiled against an offscreen 1×1 target first, and the
 * live material is only swapped in once the driver has accepted it. If it did
 * not, the previous shader keeps rendering and the driver's log comes back as
 * diagnostics.
 *
 * An engine belongs to exactly one `GlContext`, and every GPU resource it makes
 * — materials, textures, the probe target — is tagged with that context's id.
 * Two engines can therefore run side by side without either being able to reach
 * into the other's GPU state, and a context lost under one of them suspends
 * only that one. Nothing here is shared at module scope.
 *
 * three.js and its post-processing passes are imported dynamically: none of
 * this exists on the server, and keeping it out of the initial bundle means the
 * app shell paints before the renderer is even downloaded.
 */

export interface ShaderSpec {
  fragment: string;
  vertex: string;
  controls: readonly ShaderControl[];
  params: ShaderParams;
  render: RenderSettings;
  /** Exactly four entries: iChannel0…3. `null` means nothing is assigned. */
  channels: readonly (ChannelSource | null)[];
}

/** The live state an offline capture displaces, kept so `endOffline` can put it back. */
interface OfflineState {
  time: number;
  paused: boolean;
  autoRipples: boolean;
  /** The drawing buffer the capture owns. Every `resize` during it lands back here. */
  width: number;
  height: number;
}

interface ProfilerWorkloadPass {
  readonly id: string;
  readonly kind: 'image' | 'buffer';
  readonly material: THREE.ShaderMaterial;
  readonly targetKey: string;
}

/** Frames a paused preview draws after a change: one into each target of a feedback buffer. */
const INVALIDATION_FRAMES = 2;

/** Uniforms the engine supplies to every shader, whether it declares them or not. */
export const BUILT_IN_UNIFORMS = [
  'iTime',
  'iResolution',
  'iMouse',
  'iMouseVel',
  'u_clickData',
  'iChannel0',
  'iChannel1',
  'iChannel2',
  'iChannel3',
] as const;

export class ShaderEngine {
  private readonly clickData: THREE.Vector3[];
  private nextWaveIndex = 0;

  private readonly scene: THREE.Scene;
  private readonly camera: THREE.OrthographicCamera;
  private readonly mesh: THREE.Mesh;

  /**
   * The quad the buffers are drawn with. Kept apart from `scene` — which the
   * composer holds a reference to — so that swapping a material through it to
   * render four buffers cannot disturb what bloom thinks it is post-processing.
   */
  private readonly bufferScene: THREE.Scene;
  private readonly bufferMesh: THREE.Mesh;

  /** Bloom, and the choice between the composer and the bare renderer. */
  private readonly post: PostProcessing;

  /**
   * Probing, accepting and disposing shader programs. Everything about *which*
   * program a pass is running lives there, including the accepted materials
   * themselves — the engine borrows them to draw with and never frees one.
   */
  private readonly compiler: PassCompiler;

  /** The only thing that writes a uniform across more than one pass. */
  private readonly registry: UniformRegistry;

  /** Turns a channel binding into the texture it names, this frame. */
  private readonly binder: ChannelBinder;

  private readonly targets: BufferTargets;

  private readonly profiler: PerformanceProfiler;

  /**
   * iChannel0…3 of the *shader record* — what a `texture` binding points into —
   * and every `THREE.Texture` behind them.
   */
  private readonly textures: TextureManager;

  /** What the buffers need from `BufferTargets`, kept so a resize can re-sync. */
  private targetSpecs: TargetSpec[] = [];

  private frame = 0;
  private lastFrameTime = 0;
  private time = 0;
  private paused = false;
  /**
   * Frames still owed to a paused preview. Paused, nothing moves, so the loop
   * draws only after something visible changed — a parameter, the shader, a
   * texture, the size, the effects — rather than redrawing the same picture
   * every frame and keeping the main thread busy for nothing.
   */
  private pendingFrames = INVALIDATION_FRAMES;
  private autoRipples = false;
  private nextAutoRipple = 0;
  private resolutionScale = 1;
  private profilerWorkload: readonly ProfilerWorkloadPass[] = [];
  private profilerBufferWidth: number | null = null;
  private profilerBufferHeight: number | null = null;

  /** Set for as long as the clock belongs to a caller rather than to the wall. */
  private offline: OfflineState | null = null;

  private fpsAccumulator = 0;
  private fpsFrames = 0;

  private readonly pointer: THREE.Vector2;
  private readonly pointerVelocity: THREE.Vector2;
  private lastPointer: THREE.Vector2 | null = null;
  private lastPointerTime = 0;

  private disposed = false;

  /** Created by the first capture request; `null` means a frame costs nothing extra. */
  private inspector: FrameInspector | null = null;
  private framesDrawn = 0;
  private projectId: string | null = null;
  private projectGeneration = 0;
  private contextGeneration = 0;
  private requestedRevision: number | null = null;
  private bufferSize = '';

  /** Fired when a pending or retained frame capture ends without the caller asking. */
  onCaptureInvalidated: ((reason: InvalidationReason) => void) | null = null;

  private readonly unsubscribe: (() => void)[] = [];

  onFps: ((fps: number) => void) | null = null;

  /** Fired when the on-screen drawing buffer changes size, in device pixels. */
  onResize: ((width: number, height: number) => void) | null = null;
  private reportedSize = '';

  /** Fired after a live animation frame has completely reached the canvas. */
  onFrameRendered: (() => void) | null = null;

  /** Fired when an asynchronously decoded channel either becomes usable or fails. */
  onTextureSettled: (() => void) | null = null;

  /** Fired when this engine's context is lost or comes back. Never fired for a sibling's. */
  onContextLost: (() => void) | null = null;
  onContextRestored: (() => void) | null = null;
  /** Custom post-processing effects' problems, whenever that list changes. See `PostProcessing.onDiagnostics`. */
  onEffectDiagnostics: ((diagnostics: CompileDiagnostic[]) => void) | null = null;

  /** Compiles a custom effect off screen, adopting nothing. See `PostProcessing.probe`. */
  probeCustomEffect(effect: CustomEffect): CompileDiagnostic[] {
    return this.post.probe(effect);
  }

  /** The custom post-processing effects' problems for the render settings in force now. */
  get effectDiagnostics(): CompileDiagnostic[] {
    return this.post.diagnostics;
  }

  private readonly three: ThreeModule;
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;

  /** The last message written, so an identical repeat (a Ctrl+Enter with nothing changed) is not logged twice. */
  private lastOutputMessage: string | null = null;

  private constructor(
    readonly context: GlContext,
    private readonly sink: EngineOutputSink | null = null,
  ) {
    const T = context.three;
    this.three = T;
    this.canvas = context.canvas;
    this.renderer = context.renderer;

    this.scene = new T.Scene();
    this.camera = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.clickData = Array.from({ length: MAX_WAVES }, () => new T.Vector3(0, 0, 0));
    this.pointer = new T.Vector2(-1000, -1000);
    this.pointerVelocity = new T.Vector2();

    this.targets = new BufferTargets(context);

    this.textures = new TextureManager(context, {
      warn: (message) => this.logOutput('warning', 'renderer', message),
    });
    // The public callback stays the engine's: this forwards to whatever it is
    // set to at the moment a decode finishes, including `null`.
    this.textures.onSettled = () => {
      this.requestFrames();
      this.onTextureSettled?.();
    };

    this.profiler = new PerformanceProfiler(
      () => this.renderer,
      () => this.textures,
    );

    const geometry = context.own(new T.PlaneGeometry(2, 2));

    this.registry = new UniformRegistry();
    this.binder = new ChannelBinder(this.textures, this.targets);
    this.compiler = new PassCompiler(context, geometry, this.camera, this.registry, this.binder, {
      // One array, shared by every pass's `u_clickData`: writing a ripple into a
      // slot is already visible to all of them.
      clickData: this.clickData,
      time: () => this.time,
      write: (level, source, message) => this.logOutput(level, source, message),
      onProbe: (passId, durationMs, success) =>
        this.profiler.recordCompile(passId, durationMs, success),
    });

    this.mesh = new T.Mesh(geometry, this.compiler.material);
    this.scene.add(this.mesh);

    this.bufferScene = new T.Scene();
    this.bufferMesh = new T.Mesh(geometry, this.compiler.material);
    this.bufferScene.add(this.bufferMesh);

    this.post = new PostProcessing(context, this.scene, this.camera);
    // A composer arrives long after the resize that would have sized it.
    this.post.onComposerCreated = () => this.resize();
    this.post.onRenderPathChanged = () => this.resetProfilerForWorkloadChange();
    this.post.onChanged = () => this.requestFrames();
    this.post.onDiagnostics = (diagnostics) => this.onEffectDiagnostics?.(diagnostics);

    this.unsubscribe.push(
      context.onLost(() => this.handleContextLost()),
      context.onRestored(() => this.handleContextRestored()),
      context.onDispose(() => this.dispose()),
    );

    this.attachPointerListeners();
    this.resize();
  }

  /**
   * Creates an engine on a context. Passing a bare canvas still works and gives
   * the engine a context of its own, which is what the single-preview case has
   * always been — it is now just the one-context case of the general one.
   */
  static async create(
    target: HTMLCanvasElement | GlContext,
    options: GlContextOptions = {},
    sink: EngineOutputSink | null = null,
  ): Promise<ShaderEngine> {
    const context = target instanceof GlContext ? target : await GlContext.create(target, options);

    const engine = new ShaderEngine(context, sink);
    engine.start();
    return engine;
  }

  // -------------------------------------------------------------------------
  // Shader lifecycle
  // -------------------------------------------------------------------------

  /**
   * Compile a single-pass shader. The original entry point, and now the
   * one-pass case of the general one: a lone Image pass sampling the four
   * texture slots, which is exactly what every shader was before buffers.
   */
  setShader(spec: ShaderSpec): CompileDiagnostic[] {
    return this.setPasses({
      vertex: spec.vertex,
      controls: spec.controls,
      params: spec.params,
      render: spec.render,
      textures: spec.channels,
      passes: [
        {
          id: 'image',
          kind: 'image',
          fragment: spec.fragment,
          spans: [],
          channels: legacyTextureBindings(),
          resolution: { mode: 'viewport', scale: 1, width: 1, height: 1 },
          filter: 'linear',
          wrap: 'clamp',
        },
      ],
    });
  }

  /**
   * Compile a whole project and, if the driver accepts it, make it the live one.
   *
   * The contract the single-pass engine kept is kept here per pass, and it is
   * the reason this is not simply "recompile everything and swap": a candidate
   * is probed offscreen, and a pass whose new source the driver rejects leaves
   * the *previously accepted* material in place. So a project whose Buffer B has
   * a typo in it keeps rendering — with the last Buffer B that worked — instead
   * of collapsing to black while you fix it, and the errors come back as
   * diagnostics rather than as a blank canvas.
   *
   * A pass whose composed source is byte-for-byte what it already compiled is
   * skipped entirely. That is what makes an edit to Buffer C recompile Buffer C
   * and nothing else, and an edit to Common recompile every pass that actually
   * uses it — the caller does not have to work out which passes are affected,
   * because an unaffected pass composes to the same string it did last time.
   */
  setPasses(spec: MultiPassSpec, force = false): CompileDiagnostic[] {
    if (this.disposed) return [];

    // A different project is a different subject: whatever was captured of the
    // last one no longer describes anything on screen. A failed edit of the same
    // project does not end a capture — its accepted programs are what it holds.
    const projectId = spec.projectId ?? null;
    if (projectId !== this.projectId) {
      this.projectId = projectId;
      this.projectGeneration++;
      this.inspector?.invalidate('project');
    }
    this.requestedRevision = spec.revision ?? null;

    // Track requested project pass IDs for compile records (real IDs, not timing synthetics).
    this.profiler.setRequestedPasses(spec.passes.map((pass) => pass.id));

    // A lost context has no driver to compile against. Remember what was asked
    // for and apply it on restore, rather than reporting a compile failure the
    // shader is not responsible for.
    if (this.context.status() === 'lost') {
      this.compiler.remember(spec);
      return [];
    }

    // Before anything is compiled: the compiler resolves a `texture` binding
    // through these, and a pass built against stale slots would come out of it
    // bound to the placeholder.
    this.textures.setSlots(spec.textures);

    const diagnostics = this.compiler.compile(spec, force);

    // Only an accepted Image program replaces what the canvas is drawing; a
    // rejected one leaves the last good picture exactly where it was.
    const image = this.compiler.imagePass;
    if (image) this.mesh.material = image.material;

    this.targetSpecs = spec.passes
      .filter((pass) => pass.kind === 'buffer')
      .map((pass) => ({
        id: pass.id,
        resolution: pass.resolution,
        filter: pass.filter,
        wrap: pass.wrap,
      }));

    // Targets first, so that a binding to a brand-new buffer has something to
    // resolve to; then bind, so the channels are right the instant this returns
    // rather than only once the next frame is drawn.
    this.syncTargets();
    for (const pass of this.compiler.passes) this.binder.bind(pass.uniforms, pass.channels);
    this.updateProfilerWorkload();

    this.post.setSettings(spec.render, force);
    this.requestFrames();

    return diagnostics;
  }

  /**
   * Writes to the sink, deduplicating an exact repeat of the last message —
   * pressing Ctrl+Enter twice with nothing changed must not double the line.
   */
  private logOutput(level: EngineOutputLevel, source: EngineOutputSource, message: string): void {
    if (!this.sink) return;

    const key = `${level}|${source}|${message}`;
    if (key === this.lastOutputMessage) return;

    this.lastOutputMessage = key;
    this.sink.write(level, source, message);
  }

  /** The shader currently on screen: the last one the driver accepted. */
  get activeShader(): { fragment: string; vertex: string } {
    return this.compiler.activeShader;
  }

  /** The passes the driver has accepted, in render order. Image last. */
  get activePasses(): readonly { id: string; kind: 'image' | 'buffer' }[] {
    return this.compiler.passes.map((pass) => ({ id: pass.id, kind: pass.kind }));
  }

  setProfilingEnabled(enabled: boolean): void {
    if (this.disposed) return;
    const generation = this.profiler.generation;
    this.profiler.setEnabled(enabled);
    if (this.profiler.generation !== generation) this.onProfilerLifecycle?.();
  }

  profilerSnapshot(): ProfilerSnapshot {
    return this.profiler.snapshot(this.targets.allocations());
  }

  /** Monotonic lifecycle generation for UI that must drop stale snapshots immediately. */
  profilerGeneration(): number {
    return this.profiler.generation;
  }

  resetProfilerSamples(): void {
    if (this.disposed) return;
    this.profiler.resetTimingSamples();
    this.onProfilerLifecycle?.();
  }

  private resetProfilerForWorkloadChange(): void {
    this.profiler.resetTimingSamples();
    this.onProfilerLifecycle?.();
  }

  /**
   * Reset timing only when the accepted live pipeline changed. Requested passes
   * that failed compilation are absent here, while skipped passes retain their
   * material identity, so neither case wipes otherwise valid samples.
   */
  private updateProfilerWorkload(): void {
    const targets = new Map(this.targetSpecs.map((target) => [target.id, target]));
    const next = this.compiler.passes.map((pass): ProfilerWorkloadPass => {
      const target = targets.get(pass.id);
      const targetKey = target
        ? [
            target.resolution.mode,
            target.resolution.scale,
            target.resolution.width,
            target.resolution.height,
            target.filter,
            target.wrap,
          ].join(':')
        : '';
      return { id: pass.id, kind: pass.kind, material: pass.material, targetKey };
    });

    const changed =
      next.length !== this.profilerWorkload.length ||
      next.some((pass, index) => {
        const previous = this.profilerWorkload[index];
        return (
          !previous ||
          pass.id !== previous.id ||
          pass.kind !== previous.kind ||
          pass.material !== previous.material ||
          pass.targetKey !== previous.targetKey
        );
      });

    this.profilerWorkload = next;
    if (changed) this.resetProfilerForWorkloadChange();
  }

  /** Fired when profiler enablement, capture, context, or sample-reset changes. */
  onProfilerLifecycle: (() => void) | null = null;

  /**
   * The program a pass is currently running.
   *
   * Its *identity* is the observable fact worth having: an unchanged object
   * across two `setPasses` calls is the engine telling you it did not recompile
   * that pass, and a changed one that it did.
   */
  passMaterial(passId: string): THREE.ShaderMaterial | null {
    return this.compiler.materialOf(passId);
  }

  /** The texture one pass's `iChannelN` is bound to right now. */
  passChannelTexture(passId: string, channel: number): THREE.Texture | null {
    const pass = this.compiler.find(passId);
    return pass ? this.binder.textureOf(pass.uniforms, channel) : null;
  }

  /** The texture holding a buffer's most recently finished frame. */
  bufferTexture(passId: string): THREE.Texture | null {
    return this.targets.front(passId);
  }

  private syncTargets(): void {
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    const offline = this.offline;

    this.targets.sync(
      this.targetSpecs,
      offline
        ? { width: offline.width, height: offline.height }
        : {
            width: width * this.resolutionScale,
            height: height * this.resolutionScale,
          },
    );
  }

  // -------------------------------------------------------------------------
  // Parameters
  // -------------------------------------------------------------------------

  setParams(params: ShaderParams): void {
    this.registry.setParams(params);
    this.requestFrames();
  }

  /**
   * A control drives the same uniform in every pass that declares it. Turning a
   * knob has to reach the buffers too, or a parameter the whole pipeline is
   * built around would only affect the last step of it.
   */
  setParam(key: string, value: ParamValue): void {
    this.registry.setParam(key, value);
    this.requestFrames();
  }

  /**
   * Set a uniform that the engine — not the shader author — owns, on every pass.
   * `iTime` has to tick in a buffer exactly as it does in the Image pass.
   */
  private setBuiltIn(name: string, apply: (uniform: THREE.IUniform) => void): void {
    this.registry.setBuiltIn(name, apply);
  }

  /**
   * Rebinds iChannel0…3 without touching the compiled program: swapping which
   * image a channel points at (or its wrap/filter/flip) is just a new uniform
   * value, never a reason to recompile.
   *
   * What changes here are the shader's four *image* slots. Which passes sample
   * them, and through which channel, is the project's business and is untouched:
   * a pass bound to `texture 2` keeps sampling slot 2, and simply sees the new
   * image in it on the next frame.
   */
  setChannels(channels: readonly (ChannelSource | null)[]): void {
    if (this.disposed) return;

    this.textures.setSlots(channels);

    // The Image pass in a single-pass shader has no buffer loop ahead of it to
    // do the rebinding, so do it here — which also keeps `channelTexture()`
    // honest the moment this returns. With no accepted image pass there is still
    // the last accepted uniform map, and the bindings it was accepted with.
    const image = this.compiler.imagePass;
    if (image) this.binder.bind(image.uniforms, image.channels);
    else this.binder.bind(this.registry.primary, this.compiler.imageChannels);
    this.requestFrames();
  }

  /** The texture a channel currently samples, placeholder included. */
  channelTexture(index: number): THREE.Texture | null {
    return this.binder.textureOf(this.registry.primary, index);
  }

  /** True once every image texture used by the current project has decoded or failed. */
  get channelsReady(): boolean {
    return this.textures.ready;
  }

  /**
   * Binds an already-created texture to a channel.
   *
   * The ownership check is the point: a `THREE.Texture` from another engine
   * looks perfectly valid here, and three would take it and quietly upload a
   * second copy into this context — two GPU allocations behind one object, and
   * whichever engine disposes first pulls the texture out from under the other.
   * Refuse it loudly instead.
   */
  setChannelTexture(index: number, texture: THREE.Texture): void {
    if (this.disposed) return;
    if (index < 0 || index >= CHANNEL_COUNT) {
      throw new RangeError(`Channel ${index} does not exist: there are ${CHANNEL_COUNT}.`);
    }
    this.context.assertOwns(texture, `texture for iChannel${index}`);

    const uniform = this.registry.primary[CHANNEL_UNIFORMS[index]];
    if (uniform) uniform.value = texture;
    this.requestFrames();
  }

  // -------------------------------------------------------------------------
  // Render settings
  // -------------------------------------------------------------------------

  setRenderSettings(render: RenderSettings): void {
    this.post.setSettings(render);
  }

  /** Which shader the next render settings belong to. See `PostProcessing.setScope`. */
  setEffectScope(shaderId: string | null): void {
    this.post.setScope(shaderId);
    this.requestFrames();
  }

  /**
   * While a capture runs, these three are the live preview's business, not the
   * capture's — and the preview's settings keep arriving, because the panel that
   * pushes them has no idea a capture is happening. So they are recorded against
   * the state `endOffline` will restore rather than applied to a clock, a
   * randomness and a resolution the capture has taken ownership of.
   */
  setPaused(paused: boolean): void {
    if (this.offline) this.offline.paused = paused;
    else this.paused = paused;
  }

  /**
   * Asks a paused preview to draw again: the next few frames are drawn even
   * though the clock is stopped. A running preview draws every frame anyway.
   *
   * More than one, because a feedback buffer only has its first useful
   * contents after a draw into each of its two targets, and because whoever
   * waits on `onFrameRendered` may count frames.
   */
  requestFrames(count = INVALIDATION_FRAMES): void {
    this.pendingFrames = Math.max(this.pendingFrames, count);
  }

  setAutoRipples(enabled: boolean): void {
    if (this.offline) this.offline.autoRipples = enabled;
    else this.autoRipples = enabled;
  }

  setResolutionScale(scale: number): void {
    const next = Math.min(Math.max(scale, 0.25), 2);
    this.resolutionScale = next;
    this.resize();
  }

  // -------------------------------------------------------------------------
  // Sizing
  // -------------------------------------------------------------------------

  resize(): void {
    if (this.disposed) return;

    // A capture owns the drawing buffer for its duration. The window can be
    // dragged, the panel re-laid-out, the ResizeObserver can fire as often as it
    // likes: every one of them lands back on the capture's size. Routing rather
    // than ignoring also means anything that legitimately needs a resize while a
    // capture runs — a composer built the moment bloom is switched on — is sized
    // for the frames being captured, not for the panel behind them.
    const offline = this.offline;
    if (offline) {
      this.setDrawingBufferSize(offline.width, offline.height, 1);
      return;
    }

    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;

    this.setDrawingBufferSize(width, height, this.resolutionScale);
  }

  /**
   * Sizes the renderer, the composer and the bloom together, and tells the
   * shader about it. `iResolution` is in drawing-buffer pixels — the space
   * `iMouse` and `u_clickData` are in — so it is the *scaled* size that goes in,
   * never the CSS one.
   */
  private setDrawingBufferSize(width: number, height: number, scale: number): void {
    let profilerBufferChanged = false;
    if (!this.offline) {
      const pixelWidth = Math.max(1, Math.floor(width * scale));
      const pixelHeight = Math.max(1, Math.floor(height * scale));
      profilerBufferChanged =
        this.profilerBufferWidth !== null &&
        (pixelWidth !== this.profilerBufferWidth || pixelHeight !== this.profilerBufferHeight);
      this.profilerBufferWidth = pixelWidth;
      this.profilerBufferHeight = pixelHeight;

      // Compared against what was last *reported*, not last set: the first
      // sizing happens inside `create`, before anyone can be listening.
      const size = `${pixelWidth}x${pixelHeight}`;
      if (this.onResize && size !== this.reportedSize) {
        this.reportedSize = size;
        this.onResize(pixelWidth, pixelHeight);
      }
    }

    const bufferSize = `${Math.floor(width * scale)}x${Math.floor(height * scale)}`;
    if (bufferSize !== this.bufferSize) {
      this.bufferSize = bufferSize;
      this.inspector?.invalidate('resize');
    }

    this.renderer.setPixelRatio(scale);
    // `false`: never touch the CSS size. On screen that keeps the canvas filling
    // its panel; during a capture it is what lets a 4K buffer sit behind an
    // 800px canvas without the layout so much as flinching.
    this.renderer.setSize(width, height, false);

    this.post.setSize(width, height, scale);

    // Only the Image pass' resolution is the canvas's. A buffer's is its own
    // target's, and `drawBuffers` sets it from the target it is about to fill.
    const resolution = this.registry.value('iResolution') as THREE.Vector2 | undefined;
    resolution?.set(width * scale, height * scale);

    // A viewport- or scale-relative buffer is now the wrong size. Re-syncing is
    // guarded inside `BufferTargets`, so a resize that did not actually change a
    // target's dimensions costs nothing — which matters, because a
    // `ResizeObserver` fires far more often than the size really changes, and a
    // reallocation would wipe every feedback buffer's history each time.
    this.targets.sync(this.targetSpecs, { width: width * scale, height: height * scale });
    if (profilerBufferChanged) this.resetProfilerForWorkloadChange();
    this.requestFrames();
  }

  // -------------------------------------------------------------------------
  // Offline capture
  // -------------------------------------------------------------------------

  /**
   * The surface the frames land on. Only meaningful between `beginOffline` and
   * `endOffline`, where its backing store is the capture's size.
   */
  get surface(): HTMLCanvasElement {
    return this.canvas;
  }

  get capturing(): boolean {
    return this.offline !== null;
  }

  /**
   * Takes the clock away from the wall and hands it to the caller.
   *
   * Everything that made the live picture depend on *when* it was drawn is shut
   * off here: the animation loop (frames now come from `renderAt`, one per
   * call), the pointer (frozen off-screen, its listeners inert), the ripples the
   * pointer left behind, and the auto-ripples, which are seeded from
   * `Math.random()` and so could never be reproduced. What is left is a pure
   * function from `iTime` to pixels — which is what makes a capture repeatable.
   *
   * The drawing buffer is resized to the capture, and the CSS size is untouched,
   * so the preview keeps its place in the layout while it fills with 4K frames.
   */
  beginOffline(width: number, height: number): void {
    if (this.disposed) throw new Error('This engine has been disposed.');
    if (this.offline) throw new Error('This engine is already capturing.');
    if (this.context.status() !== 'live') {
      throw new Error('The WebGL context is not live, so there is nothing to capture.');
    }

    cancelAnimationFrame(this.frame);

    this.inspector?.invalidate('export');
    this.profiler.onCaptureStart();
    this.onProfilerLifecycle?.();

    this.offline = {
      time: this.time,
      paused: this.paused,
      autoRipples: this.autoRipples,
      width,
      height,
    };

    this.autoRipples = false;
    this.paused = true;

    this.pointer.set(-1000, -1000);
    this.pointerVelocity.set(0, 0);
    this.lastPointer = null;
    this.setMouse((mouse) => mouse.set(-1000, -1000, 0, 0));
    this.setBuiltIn('iMouseVel', (uniform) => (uniform.value as THREE.Vector2).set(0, 0));
    // Ripples carry the timestamp of the click that made them. Left in, they
    // would fire — or worse, half-fire — somewhere in the middle of the capture.
    for (const wave of this.clickData) wave.set(0, 0, 0);
    this.nextWaveIndex = 0;

    // Pixel ratio 1: the capture's size *is* the buffer's size, and the caller
    // has already folded any supersampling into it.
    this.resize();
  }

  /**
   * Draws one frame at exactly `time`, synchronously.
   *
   * The frame is on the canvas when this returns — `preserveDrawingBuffer` is on
   * (see `GlContext`), so it stays there to be read back rather than being
   * discarded at the end of the tick.
   */
  renderAt(time: number): void {
    if (!this.offline)
      throw new Error('renderAt is only valid between beginOffline and endOffline.');
    if (this.disposed) return;

    this.time = time;
    this.setBuiltIn('iTime', (uniform) => (uniform.value = time));

    this.draw();
  }

  /** Gives the clock back to the wall, and the canvas back to its panel. */
  endOffline(): void {
    const offline = this.offline;
    if (!offline) return;

    this.offline = null;

    this.profiler.onCaptureEnd();
    this.onProfilerLifecycle?.();

    // The preview resumes where it was, not where the capture left off: filming
    // the shader is not the same as scrubbing it.
    this.time = offline.time;
    this.paused = offline.paused;
    this.autoRipples = offline.autoRipples;

    this.setBuiltIn('iTime', (uniform) => (uniform.value = this.time));

    if (this.disposed) return;

    this.resize();
    this.lastFrameTime = performance.now();
    this.requestFrames();
    this.start();
  }

  // -------------------------------------------------------------------------
  // Pointer
  // -------------------------------------------------------------------------

  private attachPointerListeners(): void {
    const canvas = this.canvas;
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('contextmenu', this.onContextMenu);
  }

  private toBufferSpace(event: PointerEvent): THREE.Vector2 {
    const rect = this.canvas.getBoundingClientRect();
    const scale = this.resolutionScale;
    return new this.three.Vector2(
      (event.clientX - rect.left) * scale,
      // GL's origin is bottom-left; the DOM's is top-left.
      (rect.height - (event.clientY - rect.top)) * scale,
    );
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    // A capture is a function of `iTime` alone. A mouse crossing the canvas
    // while it runs would write itself into the frames.
    if (this.offline) return;

    const position = this.toBufferSpace(event);
    const now = performance.now();

    if (this.lastPointer) {
      const dt = Math.max((now - this.lastPointerTime) / 1000, 1 / 240);
      // Exponential smoothing: raw per-event deltas are far too jittery to
      // drive a smear, and they spike whenever a frame is dropped.
      this.pointerVelocity.lerp(
        new this.three.Vector2().subVectors(position, this.lastPointer).divideScalar(dt),
        0.25,
      );
    }

    this.lastPointer = position.clone();
    this.lastPointerTime = now;
    this.pointer.copy(position);
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.offline) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const position = this.toBufferSpace(event);
    this.pointer.copy(position);
    this.setMouse((mouse) => mouse.set(position.x, position.y, 1, 0));
    this.spawnRipple(position.x, position.y);
    this.requestFrames();
  };

  private readonly onPointerUp = (): void => {
    if (this.offline) return;
    this.setMouse((mouse) => (mouse.z = 0));
    this.requestFrames();
  };

  private readonly onPointerLeave = (): void => {
    if (this.offline) return;
    this.pointer.set(-1000, -1000);
    this.pointerVelocity.set(0, 0);
    this.lastPointer = null;
    this.setMouse((mouse) => (mouse.z = 0));
    this.requestFrames();
  };

  private readonly onContextMenu = (event: Event): void => event.preventDefault();

  private setMouse(apply: (mouse: THREE.Vector4) => void): void {
    this.setBuiltIn('iMouse', (uniform) => apply(uniform.value as THREE.Vector4));
  }

  /**
   * Ripples live in a fixed ring of slots, oldest overwritten first.
   *
   * Nothing has to be pushed to the passes here: every pass's `u_clickData`
   * uniform holds *the same* array of vectors — the engine's — so writing into a
   * slot is already visible to all of them.
   */
  private spawnRipple(x: number, y: number): void {
    this.clickData[this.nextWaveIndex].set(x, y, this.time);
    this.nextWaveIndex = (this.nextWaveIndex + 1) % MAX_WAVES;
  }

  // -------------------------------------------------------------------------
  // Loop
  // -------------------------------------------------------------------------

  private start(): void {
    // During a capture the frames come from `renderAt`, one per call. A context
    // restored mid-capture must not quietly hand the clock back to the wall —
    // `endOffline` is the only thing that starts the loop again.
    if (this.offline) return;

    this.lastFrameTime = performance.now();
    const loop = (): void => {
      if (this.disposed) return;
      this.frame = requestAnimationFrame(loop);
      this.tick();
    };
    this.frame = requestAnimationFrame(loop);
  }

  // -------------------------------------------------------------------------
  // Context loss
  // -------------------------------------------------------------------------

  /**
   * The GPU state is gone; the CPU state is not. Stop the loop — drawing into a
   * dead context is a stream of console errors and nothing on screen — and drop
   * the composer, whose render targets died with the context. The shader spec,
   * the parameters, the clock and the texture *descriptors* all survive in
   * memory, which is what makes the restore a replay rather than a reload.
   */
  private handleContextLost(): void {
    if (this.disposed) return;

    cancelAnimationFrame(this.frame);
    this.inspector?.invalidate('context-lost');
    this.post.invalidate();
    this.profiler.onContextLost();
    this.onProfilerLifecycle?.();
    this.onContextLost?.();
  }

  private handleContextRestored(): void {
    if (this.disposed) return;

    this.contextGeneration++;

    // three re-uploads a texture on the next draw, but only if it is told the
    // pixels it holds are new. Nothing survived on the GPU, so they all are.
    this.textures.invalidate();

    // The render targets are husks: the textures behind them died with the
    // context. Rebuilt at the size they had — empty, because their contents are
    // genuinely gone, which for a feedback buffer means its history restarts.
    this.targets.invalidate(this.targetSpecs);

    // Every program the driver held is gone too. Forgetting the compiled passes
    // is what stops the next compile recognising their sources as unchanged and
    // "reusing" materials that no longer exist on the GPU.
    this.compiler.invalidate();

    this.profiler.onContextRestored();
    this.onProfilerLifecycle?.();

    // Replayed exactly once, and as a *request*, not as an error: a context loss
    // is not the shader's fault and must not be reported as one.
    const spec = this.compiler.lastSpec;
    if (spec) this.setPasses(spec);
    else this.post.restore();

    this.resize();
    this.requestFrames();
    this.start();
    this.onContextRestored?.();
  }

  private tick(): void {
    const now = performance.now();
    // Clamp: a backgrounded tab hands back a multi-second delta, which would
    // jump every in-flight ripple forward on return.
    const delta = Math.min((now - this.lastFrameTime) / 1000, 1 / 20);
    this.lastFrameTime = now;

    // Paused, the picture only changes when something asks for a frame. The
    // profiler is the exception: it measures frames, so it keeps them coming.
    const draw = !this.paused || this.pendingFrames > 0 || this.profiler.isEnabled;

    // Frames actually drawn: a paused preview with nothing to redraw reads 0.
    this.fpsAccumulator += delta;
    if (draw) this.fpsFrames++;
    if (this.fpsAccumulator >= 0.5) {
      this.onFps?.(Math.round(this.fpsFrames / this.fpsAccumulator));
      this.fpsAccumulator = 0;
      this.fpsFrames = 0;
    }
    if (!draw) return;
    if (this.pendingFrames > 0) this.pendingFrames--;

    if (!this.paused) {
      // Time advances by delta rather than tracking the wall clock, so pausing
      // does not fast-forward the simulation on resume.
      this.time += delta;

      this.setBuiltIn('iTime', (uniform) => (uniform.value = this.time));

      this.setBuiltIn('iMouse', (uniform) => {
        const mouse = uniform.value as THREE.Vector4;
        mouse.x = this.pointer.x;
        mouse.y = this.pointer.y;
      });
      this.setBuiltIn('iMouseVel', (uniform) =>
        (uniform.value as THREE.Vector2).copy(this.pointerVelocity),
      );
      // Shaders can opt into a tunable amount of pointer inertia. Treat the
      // value as retention per 60 Hz frame so the feel stays stable at other
      // refresh rates; shaders without the control retain the original decay.
      const momentum = this.registry.value('u_smearMomentum');
      const velocityRetention =
        typeof momentum === 'number' ? Math.min(Math.max(momentum, 0), 0.99) : 0.9;
      this.pointerVelocity.multiplyScalar(Math.pow(velocityRetention, delta * 60));

      if (this.autoRipples && this.time >= this.nextAutoRipple) {
        const resolution = this.registry.value('iResolution') as THREE.Vector2 | undefined;
        this.spawnRipple(
          Math.random() * (resolution?.x ?? 1),
          Math.random() * (resolution?.y ?? 1),
        );
        this.nextAutoRipple = this.time + 1.5 + Math.random() * 2.5;
      }
    }

    this.drawMeasured();
    this.onFrameRendered?.();
  }

  private drawMeasured(): void {
    if (this.disposed || this.context.status() !== 'live') return;

    // A capture frame is drawn plainly: timer queries around a capture's extra
    // reads would be measuring the inspector, not the shader.
    if (!this.profiler.isEnabled || this.offline || this.inspector?.hasPending) {
      this.drawFrame();
      return;
    }

    const usesComposer = this.post.usesComposer();
    this.profiler.schedulePasses(
      this.compiler.bufferPasses.map((pass) => pass.id),
      this.compiler.imagePass !== null,
      usesComposer,
    );

    const cpuStart = performance.now();
    if (this.profiler.isTotalFrame()) {
      this.profiler.beginGpu();
      this.drawFrame();
      this.profiler.endGpu();
    } else {
      this.drawFrameWithPassSample(this.profiler.currentPassId(), usesComposer);
    }

    this.profiler.endFrame(performance.now() - cpuStart);
  }

  /**
   * One frame: every buffer, in dependency order, into its own target — then the
   * Image pass onto the canvas.
   *
   * The order came from the graph, so by the time a pass is drawn everything it
   * samples without feedback has already been drawn this frame. The snapshot
   * taken by `beginFrame` is what the feedback bindings read, and it is taken
   * before any of this, so "the previous frame" means the same thing to every
   * pass regardless of where its owner sits in the order.
   */
  private drawFrame(): void {
    this.post.setTime(this.time);
    const session = this.offline ? null : (this.inspector?.begin(() => this.frameSource()) ?? null);
    try {
      this.drawBuffers(null, session);
      const image = this.compiler.imagePass;
      if (image) {
        this.binder.bind(image.uniforms, image.channels);
        const resolution = image.uniforms['iResolution']?.value as THREE.Vector2 | undefined;
        session?.beforeDraw(image, this.compiler.passes.length - 1, {
          width: resolution?.x ?? 0,
          height: resolution?.y ?? 0,
        });
      }
      this.post.render(this.scene, this.camera, session?.observePreEffect);
      session?.finish();
    } finally {
      session?.dispose();
      this.framesDrawn++;
    }
  }

  /** Everything a capture reads from the live frame, assembled only when one is pending. */
  private frameSource(): FrameSource {
    return {
      identity: {
        contextId: this.context.id,
        contextGeneration: this.contextGeneration,
        projectId: this.projectId,
        projectGeneration: this.projectGeneration,
        requestedRevision: this.requestedRevision,
      },
      passes: this.compiler.passes,
      targets: this.targets,
      textures: this.textures,
      frameIndex: this.framesDrawn,
      time: this.time,
      pointer: [this.pointer.x, this.pointer.y],
      pointerVelocity: [this.pointerVelocity.x, this.pointerVelocity.y],
      resolutionScale: this.resolutionScale,
      usesComposer: this.post.usesComposer(),
      geometry: this.mesh.geometry,
      object: this.mesh,
      camera: this.camera,
    };
  }

  /**
   * Captures the next frame this engine actually draws — its real inputs, uniforms
   * and accepted programs — as an immutable bounded snapshot. See `render-inspection.ts`.
   * A paused preview is asked for one ordinary frame; nothing else about it changes.
   */
  captureFrame(options?: CaptureOptions): Promise<FrameSnapshot> {
    if (this.disposed)
      return Promise.reject(new FrameCaptureError('disposed', 'The renderer was disposed.'));
    if (this.offline) {
      return Promise.reject(new FrameCaptureError('offline', 'An export owns the renderer.'));
    }
    this.inspector ??= new FrameInspector(this.context, {
      requestFrame: () => this.requestFrames(1),
      invalidated: (reason) => this.onCaptureInvalidated?.(reason),
    });
    return this.inspector.request(options);
  }

  /** The retained capture, if any. */
  get capturedFrame(): FrameSnapshot | null {
    return this.inspector?.snapshot ?? null;
  }

  /** Releases the retained capture and cancels a pending one. Idempotent. */
  releaseCapture(): void {
    this.inspector?.release();
  }

  /**
   * One frozen GPU variable measurement against the retained capture. At most one
   * is pending; any release or invalidation of the capture cancels it. See `render-observation.ts`.
   */
  observePoint(
    request: ObservationRequest,
    options: CaptureOptions = {},
  ): Promise<ObservationResult> {
    if (!this.inspector || this.disposed || this.offline) {
      return Promise.reject(
        new FrameCaptureError('released', 'There is no retained capture to observe.'),
      );
    }
    return this.inspector.observe(options, (snapshot, signal) =>
      observeFrozenPoint(this.context, snapshot, request, { signal }),
    );
  }

  /** Whether a point observation is pending. */
  get observing(): boolean {
    return this.inspector?.hasObservation ?? false;
  }

  private drawFrameWithPassSample(samplePassId: string | null, usesComposer: boolean): void {
    this.post.setTime(this.time);
    try {
      this.drawBuffers(samplePassId);
      const image = this.compiler.imagePass;
      if (image) this.binder.bind(image.uniforms, image.channels);

      const finalPassId = usesComposer ? POST_PASS_ID : IMAGE_PASS_ID;
      if (samplePassId === finalPassId) {
        this.profiler.beginGpu();
        this.post.render(this.scene, this.camera);
        this.profiler.endGpu();
        return;
      }

      this.post.render(this.scene, this.camera);
    } finally {
      // Every actual frame counts once, whichever path drew it.
      this.framesDrawn++;
    }
  }

  /** @deprecated internal alias kept for screenshot path */
  private draw(): void {
    this.drawMeasured();
  }

  private drawBuffers(
    samplePassId: string | null = null,
    session: CaptureSession | null = null,
  ): void {
    const buffers = this.compiler.bufferPasses;
    if (buffers.length === 0) return;

    this.targets.beginFrame();

    const previousTarget = this.renderer.getRenderTarget();

    for (const pass of buffers) {
      const target = this.targets.write(pass.id);
      if (!target) continue;

      // The only moment the answer is knowable: the buffers this pass depends on
      // have by now been drawn, and the ping-pong has put this frame's result in
      // front — while a feedback binding still reads the snapshot taken before
      // any of it happened.
      this.binder.bind(pass.uniforms, pass.channels);

      // A buffer's `iResolution` is *its* target's size, not the canvas's. A
      // half-resolution buffer that thought it was full-size would sample and
      // step at the wrong scale, which is the sort of thing that looks like a
      // shader bug for an hour.
      const size = this.targets.size(pass.id);
      const resolution = pass.uniforms['iResolution']?.value as THREE.Vector2 | undefined;
      if (size && resolution) resolution.set(size.width, size.height);
      if (size) session?.beforeDraw(pass, buffers.indexOf(pass), size);

      const sample = samplePassId === pass.id;
      if (sample) this.profiler.beginGpu();

      this.bufferMesh.material = pass.material;
      this.renderer.setRenderTarget(target);
      this.renderer.render(this.bufferScene, this.camera);

      if (sample) this.profiler.endGpu();

      session?.afterDraw(pass, target);

      // What was just drawn becomes the buffer's current frame, and the target
      // holding the frame before it becomes the one we draw into next time.
      this.targets.swap(pass.id);
    }

    this.renderer.setRenderTarget(previousTarget);
    this.bufferMesh.material = this.compiler.material;
  }

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------

  /** Force a frame and hand back a PNG of exactly what is on screen. */
  async screenshot(): Promise<Blob | null> {
    this.draw();
    return new Promise((resolve) => this.canvas.toBlob(resolve, 'image/png'));
  }

  /**
   * Frees everything this engine put on the GPU, then tears down its context.
   * Only this context: a sibling engine keeps its renderer, its resources and
   * its loop, because it never shared any of them.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    cancelAnimationFrame(this.frame);

    this.inspector?.dispose();

    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;

    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);

    this.post.dispose();
    this.targets.dispose();
    this.profiler.dispose();

    // Every shader program, and the probe target they were tried on.
    this.compiler.dispose();

    this.mesh.geometry.dispose();
    this.textures.dispose();

    this.onFrameRendered = null;
    this.onTextureSettled = null;

    // Disposes the renderer. Re-entrant: this is also what runs when the
    // context is destroyed from the registry rather than from here.
    this.context.dispose();
  }
}
