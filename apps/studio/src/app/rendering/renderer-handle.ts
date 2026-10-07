import { Injectable, computed, inject, signal } from '@angular/core';
import { DesktopPlatform } from '../desktop/desktop-platform';

import type { ThumbnailUpload } from '../api/shader-api';
import {
  FrameCaptureError,
  type CaptureOptions,
  type FrameSnapshot,
  type InvalidationReason,
} from './render-inspection';
import type { ShaderEngine } from './shader-engine';
import type { ProfilerSnapshot } from './performance-profiler';
import { encodeThumbnail } from './thumbnail';

/**
 * A handle on the live renderers.
 *
 * `ShaderCanvas` owns each engine's lifecycle; everything else (the toolbar's
 * screenshot button, the GUI's FPS readout) reaches one through here rather
 * than through a component reference, so no one has to know where the canvas
 * lives in the tree.
 *
 * There can be more than one engine now — a detached preview, an output window
 * — so they are held by context id. `engine` is the *active* one: the surface
 * the toolbar and the GUI act on, and the only thing the rest of the app has
 * ever needed. Consumers that predate multiple contexts keep working unchanged.
 */
@Injectable({ providedIn: 'root' })
export class RendererHandle {
  private readonly desktop = inject(DesktopPlatform);

  private readonly engines = signal<ReadonlyMap<string, ShaderEngine>>(new Map());
  private readonly activeId = signal<string | null>(null);
  private profilingEnabled = false;

  /**
   * Bumps whenever the active profiler source or its lifecycle generation changes,
   * so the Inspector can drop stale snapshots without waiting for the poll interval.
   */
  readonly profilerEpoch = signal(0);

  /** The engine the app's global actions apply to. Null until a context exists. */
  readonly engine = computed(() => {
    const id = this.activeId();
    return id === null ? null : (this.engines().get(id) ?? null);
  });

  /** FPS of the active engine. */
  readonly fps = signal(0);

  /** The drawing buffer the shader is rendered into, in device pixels. */
  readonly resolution = signal<{ width: number; height: number } | null>(null);

  readonly contextIds = computed(() => [...this.engines().keys()]);

  /** The engine on a given context, or null. */
  for(contextId: string): ShaderEngine | null {
    return this.engines().get(contextId) ?? null;
  }

  setProfilingEnabled(enabled: boolean): void {
    if (enabled === this.profilingEnabled) return;
    this.profilingEnabled = enabled;
    this.syncProfiling();
  }

  profilerSnapshot(): ProfilerSnapshot | null {
    return this.engine()?.profilerSnapshot() ?? null;
  }

  resetProfilerSamples(): void {
    this.engine()?.resetProfilerSamples();
    this.bumpProfilerEpoch();
  }

  private bumpProfilerEpoch(): void {
    this.profilerEpoch.update((value) => value + 1);
  }

  /**
   * Align each engine with the requested profiling state.
   * Inactive engines are forced off; the active engine is set to the requested
   * flag without a disable/enable cycle that would wipe samples.
   */
  private syncProfiling(): void {
    const active = this.engine();
    for (const engine of this.engines().values()) {
      if (engine !== active) engine.setProfilingEnabled(false);
    }
    active?.setProfilingEnabled(this.profilingEnabled);
    this.bumpProfilerEpoch();
  }

  /** The first engine registered becomes the active one; later ones only join the map. */
  register(contextId: string, engine: ShaderEngine): void {
    engine.onProfilerLifecycle = () => this.bumpProfilerEpoch();
    engine.onCaptureInvalidated = (reason) => {
      if (this.engines().get(this.activeId() ?? '') !== engine) return;
      this.capturedFrame.set(null);
      this.captureEnded.set(reason);
    };
    this.engines.update((engines) => new Map(engines).set(contextId, engine));
    if (this.activeId() === null) this.activeId.set(contextId);
    this.syncProfiling();
  }

  unregister(contextId: string): void {
    const leaving = this.engines().get(contextId);
    if (leaving) {
      leaving.onProfilerLifecycle = null;
      leaving.onCaptureInvalidated = null;
      leaving.releaseCapture();
    }
    if (this.activeId() === contextId) {
      if (this.capturedFrame()) this.captureEnded.set('disposed');
      this.capturedFrame.set(null);
    }

    this.engines.update((engines) => {
      const next = new Map(engines);
      next.delete(contextId);
      return next;
    });

    // Losing the active engine hands the role to whichever is still rendering,
    // rather than leaving the toolbar pointing at nothing while a preview lives.
    if (this.activeId() === contextId) {
      const [first] = this.engines().keys();
      this.activeId.set(first ?? null);
      this.fps.set(0);
      this.resolution.set(null);
    }
    this.syncProfiling();
  }

  setActive(contextId: string): void {
    if (this.engines().has(contextId)) {
      // A capture describes one context's frame; it never follows the toolbar to another.
      if (contextId !== this.activeId()) {
        const had = this.capturedFrame() !== null;
        this.releaseCapture();
        if (had) this.captureEnded.set('active-context');
      }
      this.activeId.set(contextId);
      this.syncProfiling();
    }
  }

  /** The active engine's retained frame capture, until released or invalidated. */
  readonly capturedFrame = signal<FrameSnapshot | null>(null);

  /** Why the last retained capture ended without being released by a caller; cleared by the next request. */
  readonly captureEnded = signal<InvalidationReason | null>(null);

  /** Captures the active engine's next drawn frame. See `ShaderEngine.captureFrame`. */
  async captureFrame(options?: CaptureOptions): Promise<FrameSnapshot> {
    const engine = this.engine();
    if (!engine) throw new FrameCaptureError('no-renderer', 'There is no active renderer.');
    this.captureEnded.set(null);
    const snapshot = await engine.captureFrame(options);
    // The engine resolves inside its frame, and the callbacks of that frame run before
    // this continuation: a release, unregister, invalidation, context switch or newer
    // capture may already have ended this snapshot. Never publish what the engine no
    // longer retains, and never overwrite what it retains now.
    if (snapshot.released || this.engine() !== engine || engine.capturedFrame !== snapshot) {
      snapshot.release();
      throw new FrameCaptureError('released', 'The capture was released before it was published.');
    }
    this.capturedFrame.set(snapshot);
    return snapshot;
  }

  releaseCapture(): void {
    this.engine()?.releaseCapture();
    this.capturedFrame.set(null);
    this.captureEnded.set(null);
  }

  /** Save the current frame as a PNG. No-op if there is nothing rendering. */
  async screenshot(filename: string): Promise<boolean> {
    const engine = this.engine();
    if (!engine) return false;

    const blob = await engine.screenshot();
    if (!blob) return false;

    if (this.desktop.available) {
      return this.desktop.savePng(
        `${filename}-${Date.now()}.png`,
        new Uint8Array(await blob.arrayBuffer()),
      );
    }

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${filename}-${Date.now()}.png`;
    link.click();
    URL.revokeObjectURL(url);
    return true;
  }

  /**
   * The current frame, cropped and encoded as a library preview.
   *
   * `null` whenever there is nothing to photograph — no context yet, a shader
   * that failed to compile — which is a normal outcome, not an error: a save
   * simply keeps the preview it already had.
   */
  async captureThumbnail(): Promise<ThumbnailUpload | null> {
    const engine = this.engine();
    if (!engine) return null;

    const frame = await engine.screenshot();
    return frame ? encodeThumbnail(frame) : null;
  }
}
