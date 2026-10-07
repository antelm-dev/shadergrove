import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import { DEFAULT_RENDER } from '@shadergrove/shared/model';
import { composePass } from '@shadergrove/shared/pass-source';
import { Preferences } from '../prefs/preferences';
import type { CompileDiagnostic } from '@shadergrove/shared/diagnostic';
import { ShaderStore } from '../workspace/shader-store';
import { TextureAssets } from '../assets/texture-assets';
import { OutputLog } from '../ui/bottom-panel/output-log';
import type { GlContext } from './gl-context';
import { GlContextRegistry } from './gl-context-registry';
import { RendererHandle } from './renderer-handle';
import { type ChannelSource, type EnginePass, ShaderEngine } from './shader-engine';

const EMPTY_CHANNELS: readonly (ChannelSource | null)[] = [null, null, null, null];
const TRANSITION_DURATION_MS = 220;
const SETTLE_FRAMES = 2;

interface ChannelState {
  shaderId: string | null;
  sources: readonly (ChannelSource | null)[];
  resolved: boolean;
}

/** Also used by `McpBridge` to know how long to wait before reading back diagnostics. */
export const RECOMPILE_DEBOUNCE_MS = 400;

@Component({
  selector: 'app-shader-canvas',
  template: `
    <canvas #canvas class="shader-canvas" aria-hidden="true"></canvas>
    <canvas
      #transitionFrame
      class="transition-frame"
      [class.active]="transitionActive()"
      [class.fading]="transitionFading()"
      aria-hidden="true"
    ></canvas>
  `,
  styles: `
    /*
     * The canvas fills whatever it is given and knows nothing about what that
     * is. Where the preview sits — the stage, a floating window, maximized,
     * collapsed to a bar — is PreviewShell's business, and the whole point of
     * the split: this component is mounted once, and no window transition can
     * cost it its WebGL context, its compiled programs or the shader's clock.
     */
    :host {
      display: block;
      position: relative;
      background: #0b0b0c;
    }

    .shader-canvas {
      display: block;
      width: 100%;
      height: 100%;
      touch-action: none;
    }

    /* A frozen copy of the last complete frame hides compilation, target
       recreation and texture decoding while the live canvas keeps rendering. */
    .transition-frame {
      position: absolute;
      inset: 0;
      z-index: 1;
      display: block;
      width: 100%;
      height: 100%;
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
    }

    .transition-frame.active {
      opacity: 1;
      visibility: visible;
    }

    .transition-frame.active.fading {
      opacity: 0;
      transition: opacity ${TRANSITION_DURATION_MS}ms ease-out;
    }

    @media (prefers-reduced-motion: reduce) {
      .transition-frame.active.fading {
        transition-duration: 1ms;
      }
    }
  `,
})
export class ShaderCanvas {
  private readonly store = inject(ShaderStore);
  private readonly preferences = inject(Preferences);
  private readonly handle = inject(RendererHandle);
  private readonly contexts = inject(GlContextRegistry);
  private readonly destroyRef = inject(DestroyRef);
  private readonly textures = inject(TextureAssets);
  private readonly outputLog = inject(OutputLog);

  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly transitionFrameRef =
    viewChild.required<ElementRef<HTMLCanvasElement>>('transitionFrame');
  private readonly engine = signal<ShaderEngine | null>(null);

  /**
   * The project, composed into the passes the engine wants.
   *
   * Composition is what turns "which passes does this edit affect?" from a
   * question somebody has to answer into one nobody has to ask: a pass that an
   * edit did not touch composes to the same string it did last time, and the
   * engine skips it. Editing Buffer C recompiles Buffer C. Editing Common — or a
   * file two passes include — recompiles exactly the passes that use it.
   */
  private readonly passes = computed<readonly EnginePass[] | null>(() => {
    const project = this.store.project();
    if (!project) return null;

    return this.store.renderOrder().map((pass): EnginePass => {
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
  });

  /** The `#include` failures, which are ours to report — the driver never sees them. */
  private readonly compositionErrors = computed<readonly CompileDiagnostic[]>(() => {
    const project = this.store.project();
    if (!project) return [];

    return this.store.renderOrder().flatMap((pass) =>
      composePass(project, pass).errors.map(
        (error): CompileDiagnostic => ({
          severity: 'error',
          line: error.line,
          message: error.message,
          source: 'fragment',
          docId: error.docId,
        }),
      ),
    );
  });

  private readonly debouncedPasses = signal<readonly EnginePass[] | null>(null);
  /** The `draftRevision` that produced `debouncedPasses` — what the compile effect reports its result against. */
  private readonly debouncedRevision = signal(0);
  private readonly channelState = signal<ChannelState>({
    shaderId: null,
    sources: EMPTY_CHANNELS,
    resolved: true,
  });

  protected readonly transitionActive = signal(false);
  protected readonly transitionFading = signal(false);
  private readonly transitionTarget = signal<string | null>(null);
  private readonly compiledShaderId = signal<string | null>(null);
  private renderedShaderId: string | null = null;
  private settleFramesRemaining = 0;
  private transitionTimer: ReturnType<typeof setTimeout> | null = null;

  /** The last `recompileRequest` acted on, so a new one can be told from a redraw. */
  private lastRecompile = 0;
  /** The last `immediateCompileRequest` acted on — flush the debounce timer instead of waiting it out. */
  private lastImmediateCompile = 0;
  /** Shader selection compiles immediately; only edits within one shader are debounced. */
  private lastQueuedShaderId: string | null = null;

  constructor() {
    afterNextRender(() => {
      void this.boot();
    });

    // Debounced: a compile is expensive and a keystroke is not an edit. Every
    // pass whose composed source is unchanged when the dust settles is skipped
    // by the engine anyway, so the cost of a burst of typing is one recompile of
    // the one pass being typed into.
    //
    // Keyed off `draftRevision` rather than `passes()` alone: a controls- or
    // render-only edit bumps the revision without changing the composed
    // fragment sources, and `compileNow()`/`waitForCompile()` still need a
    // compile record to resolve against — the engine's own "unchanged source"
    // fast path makes that cheap.
    effect((onCleanup) => {
      const revision = this.store.draftRevision();
      const passes = this.passes();
      const immediate = this.store.immediateCompileRequest();
      const shaderId = this.store.selectedId();

      if (!passes) {
        this.debouncedPasses.set(null);
        return;
      }

      this.store.compiling.set(new Set(passes.map((pass) => pass.id)));

      // `compileNow()` wants the debounce flushed immediately rather than
      // waited out — the same "force" idea as Ctrl+Enter, but for timing
      // instead of the engine's unchanged-source skip.
      const shaderChanged = shaderId !== this.lastQueuedShaderId;
      this.lastQueuedShaderId = shaderId;
      if (shaderChanged || immediate !== this.lastImmediateCompile) {
        this.lastImmediateCompile = immediate;
        this.debouncedPasses.set(passes);
        this.debouncedRevision.set(revision);
        return;
      }

      const timer = setTimeout(() => {
        this.debouncedPasses.set(passes);
        this.debouncedRevision.set(revision);
      }, RECOMPILE_DEBOUNCE_MS);
      onCleanup(() => clearTimeout(timer));
    });

    effect(() => {
      const engine = this.engine();
      const passes = this.debouncedPasses();
      const revision = this.debouncedRevision();
      const controls = this.store.controls();
      const shaderId = this.store.selectedId();

      // Ctrl+Enter. Tracked, so asking for a recompile of a source nobody touched
      // still runs one — which is the entire point of asking.
      const requested = this.store.recompileRequest();
      const force = requested !== this.lastRecompile;
      this.lastRecompile = requested;

      if (!engine || !passes) return;

      untracked(() => {
        if (shaderId && this.renderedShaderId && shaderId !== this.renderedShaderId) {
          this.beginTransition(shaderId);
        }

        const draft = this.store.draft();
        const channelState = this.channelState();
        engine.setEffectScope(this.store.record()?.id ?? null);
        const diagnostics = engine.setPasses(
          {
            vertex: this.store.vertex(),
            controls,
            params: this.store.params(),
            render: draft?.render ?? DEFAULT_RENDER,
            passes,
            textures: channelState.shaderId === shaderId ? channelState.sources : EMPTY_CHANNELS,
            projectId: shaderId ?? undefined,
            revision,
          },
          force,
        );

        this.renderedShaderId = shaderId;
        this.compiledShaderId.set(shaderId);
        // Stated, not only reported on change: the renderer may already hold this
        // list from before the shader was switched, and would not repeat it.
        this.store.setEffectDiagnostics(engine.effectDiagnostics);
        this.store.recordCompileResult(revision, [...this.compositionErrors(), ...diagnostics]);
        this.store.compiling.set(new Set());
        this.armRevealWhenReady();
      });
    });

    effect(() => {
      const engine = this.engine();
      const params = this.store.params();
      engine?.setParams(params);
    });

    // Resolving a channel to a URL is async (an HTTP fetch, or an IPC round
    // trip on desktop), so it goes through its own signal rather than
    // blocking the (synchronous) compile effect above.
    effect((onCleanup) => {
      const record = this.store.record();
      const channels = this.store.channels();
      if (!record) {
        this.channelState.set({ shaderId: null, sources: EMPTY_CHANNELS, resolved: true });
        return;
      }

      // Change ownership immediately. Until the new URLs resolve, the new
      // program gets placeholders rather than the previous shader's textures.
      this.channelState.set({
        shaderId: record.id,
        sources: EMPTY_CHANNELS,
        resolved: false,
      });

      let cancelled = false;
      onCleanup(() => {
        cancelled = true;
      });

      void Promise.allSettled(
        channels.map((channel, index) =>
          this.textures.resolve(record.id, index, channel, record.updatedAt),
        ),
      ).then((results) => {
        if (cancelled) return;

        const sources = results.map((result, index) => {
          if (result.status === 'fulfilled') return result.value;
          this.outputLog.warning(
            'renderer',
            `Could not resolve texture channel ${index}: ${String(result.reason)}`,
          );
          return null;
        });
        this.channelState.set({ shaderId: record.id, sources, resolved: true });
      });
    });

    effect(() => {
      const engine = this.engine();
      const state = this.channelState();
      const shaderId = this.store.selectedId();
      engine?.setChannels(state.shaderId === shaderId ? state.sources : EMPTY_CHANNELS);
      this.armRevealWhenReady();
    });

    effect(() => {
      const engine = this.engine();
      const render = this.store.draft()?.render;
      // The record and the draft are adopted together, so this id is the draft's own.
      const shaderId = this.store.record()?.id ?? null;
      if (!engine || !render) return;
      engine.setEffectScope(shaderId);
      engine.setRenderSettings(render);
    });

    effect(() => {
      const engine = this.engine();
      const { paused, resolutionScale, autoRipples } = this.preferences.value();
      if (!engine) return;
      engine.setPaused(paused);
      engine.setResolutionScale(resolutionScale);
      engine.setAutoRipples(autoRipples);
    });

    this.destroyRef.onDestroy(() => {
      if (this.transitionTimer !== null) clearTimeout(this.transitionTimer);
    });
  }

  private async boot(): Promise<void> {
    const canvas = this.canvasRef().nativeElement;

    let engine: ShaderEngine;
    let context: GlContext;
    try {
      context = await this.contexts.create(canvas);
      engine = await ShaderEngine.create(context, {}, this.outputLog);
    } catch (error) {
      const message = `WebGL is unavailable, so the preview is disabled: ${String(error)}`;
      this.store.notice.set({ text: message, error: true });
      this.outputLog.error('renderer', message);
      return;
    }

    engine.onFps = (fps) => this.handle.fps.set(fps);
    engine.onResize = (width, height) => this.handle.resolution.set({ width, height });
    engine.onFrameRendered = () => this.onFrameRendered();
    engine.onTextureSettled = () => this.armRevealWhenReady();
    engine.onEffectDiagnostics = (diagnostics) => this.store.setEffectDiagnostics(diagnostics);

    // A lost context is recoverable and usually brief (a driver reset, a GPU
    // switch), so say so rather than reporting a failure: the shader, the
    // parameters and the clock are all still here, waiting to be replayed.
    engine.onContextLost = () => {
      this.store.notice.set({
        text: 'The GPU context was lost. Restoring the preview…',
        error: false,
      });
      this.outputLog.warning('renderer', 'The GPU context was lost. Restoring the preview…');
    };
    engine.onContextRestored = () => {
      this.store.notice.set({ text: 'The GPU context was restored.', error: false });
      this.outputLog.info('renderer', 'The GPU context was restored.');
    };

    this.engine.set(engine);
    this.handle.register(context.id, engine);

    const observer = new ResizeObserver(() => engine.resize());
    observer.observe(canvas);

    this.destroyRef.onDestroy(() => {
      observer.disconnect();
      this.handle.unregister(context.id);
      // Disposes this context and nothing else: any other preview keeps running.
      this.contexts.destroy(context.id);
    });
  }

  /** Freeze the last complete WebGL frame before installing another project. */
  private beginTransition(shaderId: string): void {
    if (this.transitionTimer !== null) {
      clearTimeout(this.transitionTimer);
      this.transitionTimer = null;
    }

    // During rapid navigation retain the original clean frame. Recapturing now
    // could photograph the half-prepared shader the overlay is hiding.
    if (!this.transitionActive()) {
      const source = this.canvasRef().nativeElement;
      const frame = this.transitionFrameRef().nativeElement;
      if (source.width === 0 || source.height === 0) return;

      frame.width = source.width;
      frame.height = source.height;
      const context = frame.getContext('2d');
      if (!context) return;

      try {
        context.drawImage(source, 0, 0);
      } catch {
        // If the drawing buffer is unavailable, switching the shader still
        // matters more than decorating the switch.
        return;
      }
      this.transitionActive.set(true);
    }

    this.transitionFading.set(false);
    this.transitionTarget.set(shaderId);
    this.settleFramesRemaining = 0;
  }

  /** Arm the fade only when source, textures and GPU programs belong to one shader. */
  private armRevealWhenReady(): void {
    const target = this.transitionTarget();
    const engine = this.engine();
    const channels = this.channelState();
    if (
      !target ||
      !this.transitionActive() ||
      this.transitionFading() ||
      this.store.selectedId() !== target ||
      this.compiledShaderId() !== target ||
      channels.shaderId !== target ||
      !channels.resolved ||
      !engine?.channelsReady
    ) {
      return;
    }

    // Two complete draws let newly allocated multipass targets receive useful
    // contents before they become visible. Asked for explicitly: a paused
    // preview only draws when told to, and the reveal waits on these frames.
    if (this.settleFramesRemaining === 0) {
      this.settleFramesRemaining = SETTLE_FRAMES;
      engine.requestFrames(SETTLE_FRAMES);
    }
  }

  private onFrameRendered(): void {
    const target = this.transitionTarget();
    if (!target || this.settleFramesRemaining === 0 || this.store.selectedId() !== target) return;

    this.settleFramesRemaining--;
    if (this.settleFramesRemaining > 0) return;

    this.transitionFading.set(true);
    const finishingTarget = target;
    this.transitionTimer = setTimeout(() => {
      this.transitionTimer = null;
      if (this.transitionTarget() !== finishingTarget) return;
      this.transitionActive.set(false);
      this.transitionFading.set(false);
      this.transitionTarget.set(null);
    }, TRANSITION_DURATION_MS);
  }
}
