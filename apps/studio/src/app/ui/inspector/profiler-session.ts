import { DestroyRef, Injector, effect, signal, untracked, type Signal } from '@angular/core';

import type { PassResolution } from '@shadergrove/shared';
import { Preferences } from '../../prefs/preferences';
import type { ProfilerSnapshot } from '../../rendering/performance-profiler';
import { RendererHandle } from '../../rendering/renderer-handle';
import { ShaderStore } from '../../workspace/shader-store';
import { recommendLowerScale } from './profiler-recommendation';

/** What the Profiler tab shows: plain data, so it can also be mirrored into another window. */
export interface ProfilerState {
  readonly snapshot: ProfilerSnapshot | null;
  /** A lower resolution scale worth applying, if any. */
  readonly suggestion: number | null;
  /** What the status line announces, if anything. */
  readonly status: { readonly kind: 'applied' | 'suggestion'; readonly scale: number } | null;
}

export const IDLE_PROFILER: ProfilerState = { snapshot: null, suggestion: null, status: null };

/** How often the profiler is sampled while its tab is on screen. */
const REFRESH_MS = 500;

/**
 * The Profiler tab's live state: GPU profiling on while `active`, a snapshot
 * of the renderer every half second, and the lower resolution scale worth
 * applying when frames run over budget.
 *
 * Owned by whichever view shows the tab — the docked panel, or, while the
 * bottom panel lives in its own window, the main window's session host, which
 * mirrors `state` there. It lives as long as the injector it is created in.
 */
export class ProfilerSession {
  private readonly handle: RendererHandle;
  private readonly preferences: Preferences;
  private readonly store: ShaderStore;

  private readonly current = signal<ProfilerState>(IDLE_PROFILER);
  readonly state = this.current.asReadonly();

  private appliedSuggestion: number | null = null;
  private holdAppliedStatus = false;
  private lastSeenScale: number | null = null;

  constructor(
    private readonly active: Signal<boolean>,
    injector: Injector,
  ) {
    this.handle = injector.get(RendererHandle);
    this.preferences = injector.get(Preferences);
    this.store = injector.get(ShaderStore);

    effect(
      () => {
        const on = this.active();
        untracked(() => {
          this.handle.setProfilingEnabled(on);
          if (on) return;
          this.current.set(IDLE_PROFILER);
          this.appliedSuggestion = null;
          this.holdAppliedStatus = false;
          this.lastSeenScale = null;
        });
      },
      { injector },
    );

    effect(
      () => {
        if (!this.active()) return;

        // Track engine replacement and lifecycle generations so stale snapshots clear immediately.
        void this.handle.engine();
        void this.handle.profilerEpoch();

        const scale = this.preferences.value().resolutionScale;
        untracked(() => {
          if (this.lastSeenScale !== null && this.lastSeenScale !== scale) {
            this.patch({ suggestion: null });
          }
          this.lastSeenScale = scale;
          this.refresh();
        });
      },
      { injector },
    );

    const timer = setInterval(() => this.refresh(), REFRESH_MS);
    injector.get(DestroyRef).onDestroy(() => {
      clearInterval(timer);
      this.handle.setProfilingEnabled(false);
    });
  }

  applySuggestion(scale: number): void {
    if (this.appliedSuggestion === scale) return;
    this.preferences.patch({ resolutionScale: scale });
    this.appliedSuggestion = scale;
    this.holdAppliedStatus = true;
    this.patch({ suggestion: null, status: { kind: 'applied', scale } });
    // Drop pre-application samples immediately; canvas also resets via setResolutionScale.
    this.handle.resetProfilerSamples();
  }

  private refresh(): void {
    if (!untracked(this.active)) return;
    // Another owner may have switched profiling off while this one is showing (a docked panel
    // torn down as the bottom panel moves to its window): it stays on while the tab is shown.
    this.handle.setProfilingEnabled(true);

    const data = this.handle.profilerSnapshot();
    this.patch({ snapshot: data });
    if (!data) {
      this.patch(
        this.holdAppliedStatus ? { suggestion: null } : { suggestion: null, status: null },
      );
      return;
    }

    // Hold the applied announcement until samples restart at the new scale.
    if (this.holdAppliedStatus) {
      this.patch({ suggestion: null });
      if (data.sampleCount === 0) return;
      this.holdAppliedStatus = false;
    }

    const resolutionByPass = new Map<string, PassResolution>(
      this.store.passes().map((pass) => [pass.id, pass.resolution]),
    );

    const proposed = recommendLowerScale({
      gpuSupport: data.gpuSupport,
      totalGpuP95Ms: data.totalGpu.p95Ms,
      cpuSubmissionP95Ms: data.cpuSubmission.p95Ms,
      sampleCount: data.sampleCount,
      lastSampleAgeMs: data.lastSampleAgeMs,
      currentScale: this.preferences.value().resolutionScale,
      passes: data.passes.map((pass) => ({
        id: pass.id,
        gpuP95Ms: pass.gpu.p95Ms,
        fixedResolution: resolutionByPass.get(pass.id)?.mode === 'fixed',
      })),
    });

    if (proposed !== null && proposed === this.appliedSuggestion) {
      this.patch({ suggestion: null, status: null });
      return;
    }

    this.patch({
      suggestion: proposed,
      status: proposed === null ? null : { kind: 'suggestion', scale: proposed },
    });
  }

  private patch(patch: Partial<ProfilerState>): void {
    this.current.update((state) => ({ ...state, ...patch }));
  }
}
