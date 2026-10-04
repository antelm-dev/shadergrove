import { computed, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PROFILER_MIN_GPU_SAMPLES,
  type ProfilerSnapshot,
} from '../../rendering/performance-profiler';
import { RendererHandle } from '../../rendering/renderer-handle';
import { I18n } from '../../i18n/i18n';
import { provideTestLanguages } from '../../i18n/testing/languages';
import {
  Preferences,
  createDefaultWorkspacePreferences,
  type WorkspacePreferences,
} from '../../prefs/preferences';
import { ShaderStore } from '../../workspace/shader-store';
import { ProfilerPanel } from './profiler-panel';
import {
  MIN_RESOLUTION_SCALE,
  TARGET_FRAME_MS,
  formatBytes,
  formatFrameShare,
  formatMilliseconds,
  frameSharePercent,
  recommendLowerScale,
  roundScaleDown,
} from './profiler-recommendation';

function emptySnapshot(overrides: Partial<ProfilerSnapshot> = {}): ProfilerSnapshot {
  return {
    enabled: true,
    gpuSupport: 'unavailable',
    sampleCount: 0,
    lastSampleAgeMs: null,
    cpuSubmission: { medianMs: null, p95Ms: null },
    totalGpu: { medianMs: null, p95Ms: null },
    passes: [],
    renderTargetBytes: 4,
    textureBytes: 4,
    textureEstimated: true,
    textures: [],
    compiles: [],
    ...overrides,
  };
}

describe('formatMilliseconds', () => {
  it('uses an em dash for unavailable values', () => {
    expect(formatMilliseconds(null)).toBe('—');
  });

  it('formats finite values with two decimals', () => {
    expect(formatMilliseconds(12.345)).toBe('12.35 ms');
  });
});

describe('formatBytes', () => {
  it('formats kilobytes and megabytes consistently', () => {
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(2_097_152)).toBe('2.0 MB');
  });
});

describe('roundScaleDown', () => {
  it('rounds down to the 0.05 step', () => {
    expect(roundScaleDown(0.87)).toBe(0.85);
  });
});

describe('frameSharePercent', () => {
  it('uses median/median and guards a non-positive total', () => {
    expect(frameSharePercent(5, 20)).toBe(25);
    expect(frameSharePercent(5, 0)).toBeNull();
    expect(frameSharePercent(5, null)).toBeNull();
    expect(formatFrameShare(30, 20)).toBe('100%');
    expect(formatFrameShare(null, 20)).toBe('—');
  });
});

describe('recommendLowerScale', () => {
  const base = {
    gpuSupport: 'supported' as const,
    totalGpuP95Ms: TARGET_FRAME_MS * 2,
    cpuSubmissionP95Ms: 1,
    sampleCount: PROFILER_MIN_GPU_SAMPLES,
    lastSampleAgeMs: 50,
    currentScale: 1,
    passes: [{ id: 'buf-a', gpuP95Ms: 2, fixedResolution: false }],
  };

  it('returns a lower clamped scale for sustained GPU-bound frames', () => {
    const scale = recommendLowerScale(base);
    expect(scale).not.toBeNull();
    expect(scale!).toBeLessThan(1);
    expect(scale!).toBeGreaterThanOrEqual(MIN_RESOLUTION_SCALE);
  });

  it('returns null when GPU timing is still warming', () => {
    expect(recommendLowerScale({ ...base, gpuSupport: 'warming' })).toBeNull();
  });

  it('returns null when the workload is already within budget', () => {
    expect(recommendLowerScale({ ...base, totalGpuP95Ms: TARGET_FRAME_MS })).toBeNull();
  });

  it('returns null when samples are stale', () => {
    expect(recommendLowerScale({ ...base, lastSampleAgeMs: 900 })).toBeNull();
  });

  it('returns null when rendering is CPU-bound', () => {
    expect(recommendLowerScale({ ...base, totalGpuP95Ms: 20, cpuSubmissionP95Ms: 20 })).toBeNull();
  });

  it('returns null when fixed-resolution cost dominates', () => {
    expect(
      recommendLowerScale({
        ...base,
        totalGpuP95Ms: 40,
        passes: [{ id: 'buf-a', gpuP95Ms: 38, fixedResolution: true }],
      }),
    ).toBeNull();
  });

  it('returns null when a fixed-resolution pass lacks a stable p95', () => {
    expect(
      recommendLowerScale({
        ...base,
        passes: [{ id: 'buf-a', gpuP95Ms: null, fixedResolution: true }],
      }),
    ).toBeNull();
  });

  it('never suggests a scale below the minimum or above the current value', () => {
    const scale = recommendLowerScale({ ...base, currentScale: 0.3 });
    expect(scale === null || scale < 0.3).toBe(true);
    if (scale !== null) expect(scale).toBeGreaterThanOrEqual(MIN_RESOLUTION_SCALE);
  });
});

describe('ProfilerPanel', () => {
  const prefs = signal(createDefaultWorkspacePreferences());
  const snapshot = signal<ProfilerSnapshot | null>(null);
  const epoch = signal(0);
  const engine = signal<object | null>({ id: 'engine-a' });

  const setProfilingEnabled = vi.fn();
  const resetProfilerSamples = vi.fn();
  const patch = vi.fn((partial: Partial<WorkspacePreferences>) => {
    prefs.update((current) => ({ ...current, ...partial }));
  });

  beforeEach(async () => {
    prefs.set(createDefaultWorkspacePreferences());
    snapshot.set(null);
    epoch.set(0);
    engine.set({ id: 'engine-a' });
    setProfilingEnabled.mockClear();
    resetProfilerSamples.mockClear();
    patch.mockClear();

    await TestBed.configureTestingModule({
      imports: [ProfilerPanel],
      providers: [
        provideZonelessChangeDetection(),
        provideTestLanguages(),
        I18n,
        {
          provide: Preferences,
          useValue: {
            value: prefs.asReadonly(),
            patch,
          },
        },
        {
          provide: RendererHandle,
          useValue: {
            engine: computed(() => engine()),
            profilerEpoch: epoch.asReadonly(),
            setProfilingEnabled,
            profilerSnapshot: () => snapshot(),
            resetProfilerSamples,
          },
        },
        {
          provide: ShaderStore,
          useValue: {
            passes: () => [
              { id: 'buf-a', resolution: { mode: 'scale', scale: 1, width: 0, height: 0 } },
            ],
          },
        },
      ],
    }).compileComponents();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('enables profiling when entering the Profiler tab and disables when leaving', async () => {
    const fixture = TestBed.createComponent(ProfilerPanel);
    fixture.detectChanges();
    expect(setProfilingEnabled).toHaveBeenCalledWith(false);

    patch({ bottomPanelTab: 'profiler' });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(setProfilingEnabled).toHaveBeenCalledWith(true);

    patch({ bottomPanelTab: 'output' });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(setProfilingEnabled).toHaveBeenLastCalledWith(false);
  });

  it('renders unsupported and empty states without a live region on the whole panel', async () => {
    patch({ bottomPanelTab: 'profiler' });
    snapshot.set(emptySnapshot({ gpuSupport: 'unavailable' }));

    const fixture = TestBed.createComponent(ProfilerPanel);
    fixture.detectChanges();
    await fixture.whenStable();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.profiler')?.getAttribute('aria-live')).toBeNull();
    expect(root.querySelector('.status')?.getAttribute('aria-live')).toBe('polite');
    expect(root.textContent).toContain('GPU timing is unavailable');

    snapshot.set(null);
    epoch.update((value) => value + 1);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(root.textContent).toContain('Waiting for the active preview');
  });

  it('clears a stale snapshot synchronously when the active engine is replaced', async () => {
    patch({ bottomPanelTab: 'profiler' });
    snapshot.set(emptySnapshot({ sampleCount: 12, gpuSupport: 'warming' }));

    const fixture = TestBed.createComponent(ProfilerPanel);
    fixture.detectChanges();
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('12');

    snapshot.set(null);
    engine.set({ id: 'engine-b' });
    epoch.update((value) => value + 1);
    fixture.detectChanges();
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'Waiting for the active preview',
    );
  });

  it('applies one recommendation once and announces without suggesting again from stale samples', async () => {
    patch({ bottomPanelTab: 'profiler', resolutionScale: 1 });
    snapshot.set(
      emptySnapshot({
        gpuSupport: 'supported',
        sampleCount: PROFILER_MIN_GPU_SAMPLES,
        lastSampleAgeMs: 20,
        cpuSubmission: { medianMs: 1, p95Ms: 1 },
        totalGpu: { medianMs: 40, p95Ms: 40 },
        passes: [
          {
            id: 'buf-a',
            label: 'buf-a',
            gpu: { medianMs: 20, p95Ms: 20 },
            width: 100,
            height: 100,
            targetBytes: 100,
          },
        ],
      }),
    );

    resetProfilerSamples.mockImplementation(() => {
      snapshot.set(
        emptySnapshot({
          gpuSupport: 'warming',
          sampleCount: 0,
          lastSampleAgeMs: null,
          cpuSubmission: { medianMs: null, p95Ms: null },
          totalGpu: { medianMs: null, p95Ms: null },
          passes: [],
        }),
      );
      epoch.update((value) => value + 1);
    });

    const fixture = TestBed.createComponent(ProfilerPanel);
    fixture.detectChanges();
    await fixture.whenStable();

    const button = (fixture.nativeElement as HTMLElement).querySelector('button');
    expect(button).not.toBeNull();
    button!.click();
    fixture.detectChanges();
    await fixture.whenStable();

    const appliedScale = [...patch.mock.calls]
      .map((call) => call[0].resolutionScale)
      .filter((value): value is number => typeof value === 'number' && value < 1)
      .at(-1);
    expect(appliedScale).toBeDefined();
    expect(appliedScale!).toBeLessThan(1);
    expect(resetProfilerSamples).toHaveBeenCalled();

    const status = (fixture.nativeElement as HTMLElement).querySelector('.status');
    expect(status?.textContent).toContain(appliedScale!.toFixed(2));

    // Same over-budget snapshot must not immediately propose an even lower scale.
    expect((fixture.nativeElement as HTMLElement).querySelector('.suggestion')).toBeNull();
  });

  it('clears stale values when the profiler generation advances (context/capture)', async () => {
    patch({ bottomPanelTab: 'profiler' });
    snapshot.set(emptySnapshot({ sampleCount: 40, gpuSupport: 'supported' }));

    const fixture = TestBed.createComponent(ProfilerPanel);
    fixture.detectChanges();
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('40');

    snapshot.set(emptySnapshot({ sampleCount: 0, gpuSupport: 'warming' }));
    epoch.update((value) => value + 1);
    fixture.detectChanges();
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('0');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Collecting GPU samples');
  });

  it('renders pass, memory, and compile details from a supported snapshot', async () => {
    patch({ bottomPanelTab: 'profiler' });
    snapshot.set(
      emptySnapshot({
        gpuSupport: 'supported',
        sampleCount: PROFILER_MIN_GPU_SAMPLES,
        lastSampleAgeMs: 40,
        cpuSubmission: { medianMs: 1.5, p95Ms: 2 },
        totalGpu: { medianMs: 20, p95Ms: 22 },
        renderTargetBytes: 2048,
        textureBytes: 4096,
        passes: [
          {
            id: 'buf-a',
            label: 'buf-a',
            gpu: { medianMs: 5, p95Ms: 6 },
            width: 320,
            height: 180,
            targetBytes: 1024,
          },
          {
            id: '__image__',
            label: 'Image',
            gpu: { medianMs: 30, p95Ms: 32 },
            width: null,
            height: null,
            targetBytes: null,
          },
        ],
        compiles: [
          { passId: 'buf-a', durationMs: 4.25, success: true },
          { passId: 'buf-new', durationMs: 1.5, success: false },
        ],
      }),
    );

    const fixture = TestBed.createComponent(ProfilerPanel);
    fixture.detectChanges();
    await fixture.whenStable();

    const root = fixture.nativeElement as HTMLElement;
    const text = root.textContent ?? '';
    expect(text).toContain('buf-a');
    expect(text).toContain('5.00 ms');
    expect(text).toContain('25%');
    expect(text).toContain('320×180');
    expect(text).toContain('1.0 KB');
    expect(text).toContain('2.0 KB');
    expect(text).toContain('4.0 KB');
    expect(text).toContain('estimates');
    expect(text).toContain('4.25 ms');
    expect(text).toContain('OK');
    expect(text).toContain('Failed');

    // Image pass: unavailable size/memory as em dashes; share clamped at 100%.
    const rows = [...root.querySelectorAll('.pass-table tbody tr')];
    const imageRow = rows.find((row) => row.textContent?.includes('Image'));
    expect(imageRow?.textContent).toContain('—');
    expect(imageRow?.textContent).toContain('100%');
  });

  it('guards frame-share edges for zero totals and missing medians', async () => {
    patch({ bottomPanelTab: 'profiler' });
    snapshot.set(
      emptySnapshot({
        gpuSupport: 'unavailable',
        totalGpu: { medianMs: 0, p95Ms: null },
        passes: [
          {
            id: 'buf-a',
            label: 'buf-a',
            gpu: { medianMs: 5, p95Ms: null },
            width: null,
            height: null,
            targetBytes: null,
          },
        ],
      }),
    );

    const fixture = TestBed.createComponent(ProfilerPanel);
    fixture.detectChanges();
    await fixture.whenStable();

    const shareCell = (fixture.nativeElement as HTMLElement).querySelector(
      '.pass-table tbody td:nth-child(3)',
    );
    expect(shareCell?.textContent?.trim()).toBe('—');
  });
});
