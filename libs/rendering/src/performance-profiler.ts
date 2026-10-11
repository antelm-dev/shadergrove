import type { WebGLRenderer } from 'three';

import {
  RGBA16F_BYTES_PER_PIXEL,
  RENDER_TARGETS_PER_BUFFER,
  type BufferAllocation,
} from './pass-targets';
import type { TextureManager } from './engine/texture-manager';

/** Synthetic pass id for the final image draw when bloom is off. */
export const IMAGE_PASS_ID = '__image__';

/** Synthetic pass id for the composer path when bloom is on. */
export const POST_PASS_ID = '__post__';

/** Minimum resolved GPU samples before median/p95 are published. */
export const PROFILER_MIN_GPU_SAMPLES = 30;

/** Rolling window size for timing percentiles. */
export const PROFILER_WINDOW_SIZE = 120;

export type ProfilerGpuSupport = 'warming' | 'supported' | 'unavailable' | 'disjoint';

export interface ProfilerTiming {
  readonly medianMs: number | null;
  readonly p95Ms: number | null;
}

export interface ProfilerPassTiming {
  readonly id: string;
  readonly label: string;
  readonly gpu: ProfilerTiming;
  readonly width: number | null;
  readonly height: number | null;
  readonly targetBytes: number | null;
}

export interface ProfilerCompileRecord {
  readonly passId: string;
  readonly durationMs: number;
  readonly success: boolean;
}

export interface ProfilerTextureAllocation {
  readonly slot: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly bytes: number | null;
}

export interface ProfilerSnapshot {
  readonly enabled: boolean;
  readonly gpuSupport: ProfilerGpuSupport;
  readonly sampleCount: number;
  readonly lastSampleAgeMs: number | null;
  readonly cpuSubmission: ProfilerTiming;
  readonly totalGpu: ProfilerTiming;
  readonly passes: readonly ProfilerPassTiming[];
  readonly renderTargetBytes: number;
  readonly textureBytes: number | null;
  readonly textureEstimated: true;
  readonly textures: readonly ProfilerTextureAllocation[];
  readonly compiles: readonly ProfilerCompileRecord[];
}

interface GpuTimerExtension {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

interface PendingGpuSample {
  readonly query: WebGLQuery;
  readonly kind: 'total' | 'pass';
  readonly passId?: string;
}

interface PassSchedule {
  readonly passIds: readonly string[];
  readonly mode: 'total' | 'pass';
  readonly passId: string | null;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}

function timingFrom(samples: readonly number[]): ProfilerTiming {
  if (samples.length < PROFILER_MIN_GPU_SAMPLES) return { medianMs: null, p95Ms: null };
  return { medianMs: median(samples), p95Ms: percentile(samples, 0.95) };
}

function passLabel(id: string): string {
  if (id === IMAGE_PASS_ID) return 'Image';
  if (id === POST_PASS_ID) return 'Post-processing';
  return id;
}

class RollingSamples {
  private readonly values: number[] = [];

  push(value: number): void {
    this.values.push(value);
    if (this.values.length > PROFILER_WINDOW_SIZE) this.values.shift();
  }

  get length(): number {
    return this.values.length;
  }

  stats(): ProfilerTiming {
    return timingFrom(this.values);
  }

  clear(): void {
    this.values.length = 0;
  }
}

class GpuTimerAdapter {
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: GpuTimerExtension | null;
  private activeQuery: WebGLQuery | null = null;
  private readonly pending: PendingGpuSample[] = [];
  private activeKind: 'total' | 'pass' = 'total';
  private activePassId: string | undefined;

  constructor(renderer: WebGLRenderer) {
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2') as GpuTimerExtension | null;
  }

  get supported(): boolean {
    return this.ext !== null;
  }

  begin(kind: 'total' | 'pass', passId?: string): void {
    if (!this.ext || this.activeQuery) return;

    const query = this.gl.createQuery();
    if (!query) return;

    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.activeQuery = query;
    this.activeKind = kind;
    this.activePassId = passId;
  }

  end(): void {
    if (!this.ext || !this.activeQuery) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);

    this.pending.push({
      query: this.activeQuery,
      kind: this.activeKind,
      passId: this.activePassId,
    });

    this.activeQuery = null;
    this.activePassId = undefined;
  }

  poll(): {
    readonly disjoint: boolean;
    readonly totals: readonly number[];
    readonly passes: readonly { passId: string; ms: number }[];
  } {
    const totals: number[] = [];
    const passes: { passId: string; ms: number }[] = [];

    if (!this.ext) return { disjoint: false, totals, passes };

    const disjointNow = this.gl.getParameter(this.ext.GPU_DISJOINT_EXT) as unknown as boolean;
    if (disjointNow) {
      this.discardPending();
      return { disjoint: true, totals, passes };
    }

    const stillPending: PendingGpuSample[] = [];

    for (const sample of this.pending) {
      const available = this.gl.getQueryParameter(sample.query, this.gl.QUERY_RESULT_AVAILABLE);
      if (!available) {
        stillPending.push(sample);
        continue;
      }

      const nanos = this.gl.getQueryParameter(sample.query, this.gl.QUERY_RESULT) as number;
      this.gl.deleteQuery(sample.query);
      const ms = nanos / 1_000_000;

      if (sample.kind === 'total') totals.push(ms);
      else if (sample.passId) passes.push({ passId: sample.passId, ms });
    }

    this.pending.length = 0;
    this.pending.push(...stillPending);

    return { disjoint: false, totals, passes };
  }

  clear(): void {
    for (const sample of this.pending) this.gl.deleteQuery(sample.query);
    this.pending.length = 0;
    this.activeQuery = null;
  }

  private discardPending(): void {
    for (const sample of this.pending) this.gl.deleteQuery(sample.query);
    this.pending.length = 0;
    this.activeQuery = null;
  }
}

/**
 * WebGL2 timer-query profiler.
 *
 * Core guarantees:
 * - only uses core GL query params (`gl.QUERY_RESULT_AVAILABLE` / `gl.QUERY_RESULT`)
 * - aggregates every resolved query event (never overwrites delayed batches)
 * - transient disjoint discards affected samples and recovers automatically
 * - supported requires total + every currently displayed pass bucket to have enough samples
 */
export class PerformanceProfiler {
  private requestedEnabled = false;
  private suspended = false; // offline capture suspend
  private timer: GpuTimerAdapter | null = null;

  private gpuSupport: ProfilerGpuSupport = 'unavailable';
  private frameIndex = 0;
  private lastSampleAt: number | null = null;
  private resolvedGpuSamples = 0;

  private readonly cpuSamples = new RollingSamples();
  private readonly totalGpuSamples = new RollingSamples();
  private readonly passGpuSamples = new Map<string, RollingSamples>();

  private readonly compileByPass = new Map<string, ProfilerCompileRecord>();
  /** Project pass IDs last requested for compilation (real IDs, not synthetic timing IDs). */
  private requestedCompilePassIds: readonly string[] = [];

  private passIds: readonly string[] = [];
  private currentSchedule: PassSchedule = { passIds: [], mode: 'total', passId: null };
  private lifecycleGeneration = 0;

  // 1×1 RGBA probe with depth/stencil disabled (see PassCompiler).
  private readonly compilerProbeBytes = 1 * 1 * 4;

  constructor(
    private readonly getRenderer: () => WebGLRenderer | null,
    private readonly getTextures: () => TextureManager,
  ) {}

  get generation(): number {
    return this.lifecycleGeneration;
  }

  setEnabled(requested: boolean): void {
    if (requested === this.requestedEnabled) return;
    this.requestedEnabled = requested;

    if (!requested) {
      this.suspended = false;
      this.gpuSupport = 'unavailable';
      this.timer?.clear();
      this.timer = null;
      this.clearTimingSamplesOnly();
      this.passIds = [];
      this.currentSchedule = { passIds: [], mode: 'total', passId: null };
      this.bumpGeneration();
      return;
    }

    // Requested enabled: initialize immediately unless offline-suspended.
    if (!this.suspended) this.ensureTimer();
    this.clearTimingSamplesOnly();
    this.gpuSupport = this.timer?.supported ? 'warming' : 'unavailable';
    this.bumpGeneration();
  }

  onCaptureStart(): void {
    this.suspended = true;
    this.timer?.clear();
    this.clearTimingSamplesOnly();
    this.gpuSupport = this.timer?.supported ? 'warming' : 'unavailable';
    this.bumpGeneration();
  }

  onCaptureEnd(): void {
    this.suspended = false;
    if (!this.requestedEnabled) {
      this.bumpGeneration();
      return;
    }
    this.ensureTimer();
    this.gpuSupport = this.timer?.supported ? 'warming' : 'unavailable';
    this.bumpGeneration();
  }

  onContextLost(): void {
    this.timer?.clear();
    this.timer = null;
    this.clearTimingSamplesOnly();
    if (this.requestedEnabled) this.gpuSupport = 'warming';
    this.bumpGeneration();
  }

  onContextRestored(): void {
    if (!this.requestedEnabled || this.suspended) {
      this.bumpGeneration();
      return;
    }
    this.ensureTimer();
    this.gpuSupport = this.timer?.supported ? 'warming' : 'unavailable';
    this.bumpGeneration();
  }

  dispose(): void {
    this.requestedEnabled = false;
    this.suspended = false;
    this.timer?.clear();
    this.timer = null;
    this.gpuSupport = 'unavailable';
    this.clearTimingSamplesOnly();
    this.bumpGeneration();
  }

  get isEnabled(): boolean {
    return this.requestedEnabled && !this.suspended;
  }

  /**
   * Project pass IDs involved in the latest compile request.
   * Separate from `schedulePasses` timing IDs (which use synthetic `__image__` / `__post__`).
   */
  setRequestedPasses(passIds: readonly string[]): void {
    this.requestedCompilePassIds = [...passIds];
    const active = new Set(this.requestedCompilePassIds);
    for (const passId of this.compileByPass.keys()) {
      if (!active.has(passId)) this.compileByPass.delete(passId);
    }
  }

  /**
   * Drop rolling timing samples without disabling profiling (e.g. after a scale change).
   * Pending timer queries are deleted so late results cannot land in the new generation.
   */
  resetTimingSamples(): void {
    this.timer?.clear();
    this.clearTimingSamplesOnly();
    if (this.requestedEnabled && !this.suspended) {
      this.gpuSupport = this.timer?.supported ? 'warming' : 'unavailable';
    }
    this.bumpGeneration();
  }

  schedulePasses(
    bufferIds: readonly string[],
    hasImage: boolean,
    usesComposer: boolean,
  ): PassSchedule {
    const finals: string[] = [];
    if (hasImage) finals.push(usesComposer ? POST_PASS_ID : IMAGE_PASS_ID);

    this.passIds = [...bufferIds, ...finals];

    const cycle = 1 + this.passIds.length;
    const slot = cycle === 0 ? 0 : this.frameIndex % cycle;
    if (slot === 0 || this.passIds.length === 0) {
      this.currentSchedule = { passIds: this.passIds, mode: 'total', passId: null };
    } else {
      const passId = this.passIds[slot - 1] ?? null;
      this.currentSchedule = { passIds: this.passIds, mode: 'pass', passId };
    }

    return this.currentSchedule;
  }

  isTotalFrame(): boolean {
    return this.currentSchedule.mode === 'total';
  }

  currentPassId(): string | null {
    return this.currentSchedule.passId;
  }

  beginGpu(): void {
    if (!this.requestedEnabled || this.suspended) return;
    if (!this.timer?.supported) return;
    if (this.passIds.length === 0) return;

    if (this.currentSchedule.mode === 'total') this.timer.begin('total');
    else if (this.currentSchedule.passId) this.timer.begin('pass', this.currentSchedule.passId);
  }

  endGpu(): void {
    if (!this.requestedEnabled || this.suspended) return;
    if (!this.timer?.supported) return;
    this.timer.end();
  }

  endFrame(cpuSubmissionMs: number): void {
    if (!this.requestedEnabled || this.suspended) return;

    this.cpuSamples.push(cpuSubmissionMs);
    this.frameIndex++;

    const poll = this.timer?.poll();
    if (!poll) return;

    if (poll.disjoint) {
      this.gpuSupport = 'disjoint';
      this.totalGpuSamples.clear();
      for (const samples of this.passGpuSamples.values()) samples.clear();
      this.passGpuSamples.clear();
      this.resolvedGpuSamples = 0;
      this.lastSampleAt = null;
      return;
    }

    for (const ms of poll.totals) {
      this.totalGpuSamples.push(ms);
      this.resolvedGpuSamples++;
      this.lastSampleAt = performance.now();
    }

    for (const { passId, ms } of poll.passes) {
      const bucket = this.passGpuSamples.get(passId) ?? new RollingSamples();
      bucket.push(ms);
      this.passGpuSamples.set(passId, bucket);
      this.resolvedGpuSamples++;
      this.lastSampleAt = performance.now();
    }

    this.updateGpuSupportFromSamples();
  }

  recordCompile(passId: string, durationMs: number, success: boolean): void {
    this.compileByPass.set(passId, { passId, durationMs, success });
  }

  snapshot(allocations: readonly BufferAllocation[]): ProfilerSnapshot {
    const textures = this.getTextures().textureAllocations();
    const baseRenderTargetsBytes = allocations.reduce((sum, entry) => sum + entry.bytes, 0);
    const renderTargetBytes = baseRenderTargetsBytes + this.compilerProbeBytes;

    const passes: ProfilerPassTiming[] = this.passIds.map((id) => {
      const size = allocations.find((entry) => entry.id === id);
      const isSynthetic = id === IMAGE_PASS_ID || id === POST_PASS_ID;

      return {
        id,
        label: passLabel(id),
        gpu: (this.passGpuSamples.get(id) ?? new RollingSamples()).stats(),
        width: isSynthetic ? null : (size?.width ?? null),
        height: isSynthetic ? null : (size?.height ?? null),
        targetBytes: isSynthetic ? null : (size?.bytes ?? null),
      };
    });

    return {
      enabled: this.requestedEnabled,
      gpuSupport: this.requestedEnabled ? this.gpuSupport : 'unavailable',
      sampleCount: this.resolvedGpuSamples,
      lastSampleAgeMs:
        this.lastSampleAt === null ? null : Math.max(0, performance.now() - this.lastSampleAt),
      cpuSubmission: this.cpuSamples.stats(),
      totalGpu: this.totalGpuSamples.stats(),
      passes,
      renderTargetBytes,
      textureBytes: textures.totalBytes,
      textureEstimated: true,
      textures: textures.items,
      compiles: [...this.compileByPass.values()].filter((record) =>
        this.requestedCompilePassIds.includes(record.passId),
      ),
    };
  }

  private bumpGeneration(): void {
    this.lifecycleGeneration++;
  }

  private ensureTimer(): void {
    const renderer = this.getRenderer();
    if (!renderer) {
      this.timer = null;
      this.gpuSupport = 'unavailable';
      return;
    }
    this.timer = new GpuTimerAdapter(renderer);
  }

  private updateGpuSupportFromSamples(): void {
    if (!this.timer?.supported) {
      this.gpuSupport = 'unavailable';
      return;
    }

    if (this.passIds.length === 0) {
      this.gpuSupport = 'unavailable';
      return;
    }

    if (this.totalGpuSamples.length < PROFILER_MIN_GPU_SAMPLES) {
      this.gpuSupport = 'warming';
      return;
    }

    for (const passId of this.passIds) {
      const bucket = this.passGpuSamples.get(passId);
      if (!bucket || bucket.length < PROFILER_MIN_GPU_SAMPLES) {
        this.gpuSupport = 'warming';
        return;
      }
    }

    this.gpuSupport = 'supported';
  }

  private clearTimingSamplesOnly(): void {
    this.cpuSamples.clear();
    this.totalGpuSamples.clear();
    this.passGpuSamples.clear();
    this.frameIndex = 0;
    this.resolvedGpuSamples = 0;
    this.lastSampleAt = null;
    // Keep passIds for supported gating; timings start fresh.
  }
}

export function bufferAllocationBytes(width: number, height: number): number {
  return width * height * RGBA16F_BYTES_PER_PIXEL * RENDER_TARGETS_PER_BUFFER;
}
