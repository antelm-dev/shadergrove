import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DesktopPlatform } from '../desktop/desktop-platform';
import { PerformanceProfiler } from './performance-profiler';
import { RendererHandle } from './renderer-handle';
import type { ShaderEngine } from './shader-engine';

interface StubEngine {
  readonly profiler: PerformanceProfiler;
  readonly setProfilingEnabled: ReturnType<typeof vi.fn<(enabled: boolean) => void>>;
  onProfilerLifecycle: (() => void) | null;
  profilerSnapshot: () => ReturnType<PerformanceProfiler['snapshot']>;
  resetProfilerSamples: () => void;
  releaseCapture: () => void;
  onCaptureInvalidated: (() => void) | null;
}

function stubEngine(): StubEngine {
  const textures = {
    textureAllocations: () => ({ items: [], totalBytes: 4, estimated: true as const }),
  };
  const profiler = new PerformanceProfiler(
    () => null,
    () => textures as never,
  );

  const engine: StubEngine = {
    profiler,
    onProfilerLifecycle: null,
    onCaptureInvalidated: null,
    releaseCapture: () => undefined,
    setProfilingEnabled: vi.fn((enabled: boolean) => {
      const generation = profiler.generation;
      profiler.setEnabled(enabled);
      if (profiler.generation !== generation) engine.onProfilerLifecycle?.();
    }),
    profilerSnapshot: () => profiler.snapshot([]),
    resetProfilerSamples: () => {
      profiler.resetTimingSamples();
      engine.onProfilerLifecycle?.();
    },
  };

  return engine;
}

function asEngine(engine: StubEngine): ShaderEngine {
  return engine as unknown as ShaderEngine;
}

describe('RendererHandle profiling sync', () => {
  let handle: RendererHandle;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        RendererHandle,
        { provide: DesktopPlatform, useValue: { available: false } },
      ],
    });
    handle = TestBed.inject(RendererHandle);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('is a no-op when setProfilingEnabled repeats the current state', () => {
    const primary = stubEngine();
    handle.register('preview', asEngine(primary));
    handle.setProfilingEnabled(true);

    primary.profiler.recordCompile('image', 1, true);
    for (let index = 0; index < 5; index++) primary.profiler.endFrame(1);
    const samplesBefore = primary.profiler.snapshot([]).sampleCount;
    const epochBefore = handle.profilerEpoch();
    primary.setProfilingEnabled.mockClear();

    handle.setProfilingEnabled(true);
    expect(primary.setProfilingEnabled).not.toHaveBeenCalled();
    expect(handle.profilerEpoch()).toBe(epochBefore);
    expect(primary.profiler.snapshot([]).sampleCount).toBe(samplesBefore);
  });

  it('does not reset the active profiler when an inactive engine registers', () => {
    const primary = stubEngine();
    handle.register('preview', asEngine(primary));
    handle.setProfilingEnabled(true);
    for (let index = 0; index < 4; index++) primary.profiler.endFrame(2);
    const samplesBefore = primary.profiler.snapshot([]).sampleCount;
    primary.setProfilingEnabled.mockClear();

    const secondary = stubEngine();
    handle.register('output', asEngine(secondary));

    expect(handle.engine()).toBe(asEngine(primary));
    expect(secondary.setProfilingEnabled).toHaveBeenCalledWith(false);
    // Active engine is set to the requested true without a disable/enable wipe.
    expect(primary.setProfilingEnabled).toHaveBeenCalledWith(true);
    expect(primary.setProfilingEnabled).not.toHaveBeenCalledWith(false);
    expect(primary.profiler.snapshot([]).sampleCount).toBe(samplesBefore);
  });

  it('disables the old active engine and enables the new one when switching', () => {
    const primary = stubEngine();
    const secondary = stubEngine();
    handle.register('preview', asEngine(primary));
    handle.register('output', asEngine(secondary));
    handle.setProfilingEnabled(true);
    primary.setProfilingEnabled.mockClear();
    secondary.setProfilingEnabled.mockClear();

    handle.setActive('output');

    expect(handle.engine()).toBe(asEngine(secondary));
    expect(primary.setProfilingEnabled).toHaveBeenCalledWith(false);
    expect(secondary.setProfilingEnabled).toHaveBeenCalledWith(true);
    expect(primary.setProfilingEnabled).toHaveBeenCalledTimes(1);
    expect(secondary.setProfilingEnabled).toHaveBeenCalledTimes(1);
  });

  it('leaves profiling off on the active engine when the Profiler tab exits', () => {
    const primary = stubEngine();
    handle.register('preview', asEngine(primary));
    handle.setProfilingEnabled(true);
    expect(primary.profiler.isEnabled).toBe(true);

    handle.setProfilingEnabled(false);
    expect(primary.profiler.isEnabled).toBe(false);
    expect(primary.setProfilingEnabled).toHaveBeenLastCalledWith(false);
  });

  it('keeps the surviving engine profiling when an inactive context unregisters', () => {
    const primary = stubEngine();
    const secondary = stubEngine();
    handle.register('preview', asEngine(primary));
    handle.register('output', asEngine(secondary));
    handle.setProfilingEnabled(true);
    for (let index = 0; index < 3; index++) primary.profiler.endFrame(1);
    const samplesBefore = primary.profiler.snapshot([]).sampleCount;
    primary.setProfilingEnabled.mockClear();

    handle.unregister('output');

    expect(handle.engine()).toBe(asEngine(primary));
    expect(primary.profiler.snapshot([]).sampleCount).toBe(samplesBefore);
    expect(primary.setProfilingEnabled).toHaveBeenCalledWith(true);
    expect(primary.setProfilingEnabled).not.toHaveBeenCalledWith(false);
  });
});

/** A snapshot that only knows whether it was released, and an engine that resolves it on demand. */
function stubSnapshot(): { released: boolean; release(): void } {
  return {
    released: false,
    release() {
      this.released = true;
    },
  };
}

function capturingEngine() {
  const snapshots: ReturnType<typeof stubSnapshot>[] = [];
  const pending: ((snapshot: ReturnType<typeof stubSnapshot>) => void)[] = [];
  const engine = Object.assign(stubEngine(), {
    retained: null as ReturnType<typeof stubSnapshot> | null,
    onCaptureInvalidated: null as (() => void) | null,
    captureFrame: vi.fn(
      () => new Promise<ReturnType<typeof stubSnapshot>>((resolve) => pending.push(resolve)),
    ),
    releaseCapture() {
      this.retained?.release();
      this.retained = null;
    },
  });
  // Object.assign would evaluate a getter once; the handle must see the live value.
  Object.defineProperty(engine, 'capturedFrame', { get: () => engine.retained });
  /** The engine's frame finishes: the snapshot is retained and the promise settles. */
  const finish = () => {
    const snapshot = stubSnapshot();
    snapshots.push(snapshot);
    engine.retained = snapshot;
    pending.shift()!(snapshot);
    return snapshot;
  };
  return { engine, finish };
}

describe('RendererHandle capture publication', () => {
  let handle: RendererHandle;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        RendererHandle,
        { provide: DesktopPlatform, useValue: { available: false } },
      ],
    });
    handle = TestBed.inject(RendererHandle);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  async function outcome(request: Promise<unknown>): Promise<string> {
    try {
      await request;
    } catch (error) {
      return (error as { code?: string }).code ?? 'other';
    }
    return 'resolved';
  }

  it('publishes the capture the engine still retains', async () => {
    const { engine, finish } = capturingEngine();
    handle.register('preview', engine as unknown as ShaderEngine);

    const request = handle.captureFrame();
    const snapshot = finish();

    expect(await request).toBe(snapshot);
    expect(handle.capturedFrame()).toBe(snapshot);
  });

  it.each([
    ['released by the handle', (h: RendererHandle) => h.releaseCapture()],
    ['unregistered', (h: RendererHandle) => h.unregister('preview')],
    [
      'invalidated by the engine',
      (_h: RendererHandle, engine: ReturnType<typeof capturingEngine>['engine']) =>
        engine.releaseCapture(),
    ],
  ])('ends honestly when the capture is %s before the handle continues', async (_name, end) => {
    const { engine, finish } = capturingEngine();
    handle.register('preview', engine as unknown as ShaderEngine);

    const request = handle.captureFrame();
    const snapshot = finish();
    end(handle, engine);

    expect(await outcome(request)).toBe('released');
    expect(snapshot.released).toBe(true);
    expect(handle.capturedFrame()).toBeNull();
    expect(engine.retained).toBeNull();
  });

  it('does not publish a capture of an engine that stopped being active', async () => {
    const first = capturingEngine();
    const second = capturingEngine();
    handle.register('preview', first.engine as unknown as ShaderEngine);
    handle.register('output', second.engine as unknown as ShaderEngine);

    const request = handle.captureFrame();
    const snapshot = first.finish();
    handle.setActive('output');

    expect(await outcome(request)).toBe('released');
    expect(snapshot.released).toBe(true);
    expect(handle.capturedFrame()).toBeNull();
  });

  it('never lets a stale request overwrite or release a newer retained capture', async () => {
    const { engine, finish } = capturingEngine();
    handle.register('preview', engine as unknown as ShaderEngine);

    const stale = handle.captureFrame();
    const old = finish();
    handle.releaseCapture();
    const newer = handle.captureFrame();
    const current = finish();

    expect(await outcome(stale)).toBe('released');
    expect(await newer).toBe(current);
    expect(old.released).toBe(true);
    expect(current.released).toBe(false);
    expect(handle.capturedFrame()).toBe(current);
    expect(engine.retained).toBe(current);
  });
});
