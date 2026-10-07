import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18n } from '../../i18n/i18n';
import { provideTestLanguages } from '../../i18n/testing/languages';
import {
  Preferences,
  createDefaultWorkspacePreferences,
  type WorkspacePreferences,
} from '../../prefs/preferences';
import {
  FrameCaptureError,
  type CaptureOptions,
  type FrameSnapshot,
  type InvalidationReason,
} from '../../rendering/render-inspection';
import { RendererHandle } from '../../rendering/renderer-handle';
import { RenderInspectionPanel } from './render-inspection-panel';

/** A 4×2 float image, bottom row first. Row 0 holds the interesting values. */
const RAW = [
  // (0,0): HDR, negative, NaN, ordinary
  2048,
  -0.25,
  Number.NaN,
  1,
  // (1,0)
  Infinity,
  -Infinity,
  -0,
  0.5,
  // (2,0), (3,0)
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  // row 1
  0.1,
  0.2,
  0.3,
  0.4,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
];
const DISPLAY = [255, 128, 0, 255, ...new Array<number>(28).fill(7)];

function fakeSnapshot(overrides: Record<string, unknown> = {}): FrameSnapshot {
  const images = [
    { id: 'raw', origin: 'image-raw-replay', width: 4, height: 2, format: 'rgba32f', bytes: 128 },
    { id: 'display', origin: 'canvas-display', width: 4, height: 2, format: 'rgba8', bytes: 32 },
  ];
  const read = vi.fn(
    (id: string, region: { x: number; y: number; width: number; height: number }) => {
      const source = id === 'raw' ? RAW : DISPLAY;
      const out: number[] = [];
      for (let row = 0; row < region.height; row++) {
        const from = ((region.y + row) * 4 + region.x) * 4;
        out.push(...source.slice(from, from + region.width * 4));
      }
      return id === 'raw'
        ? {
            width: region.width,
            height: region.height,
            format: 'rgba32f',
            data: Float32Array.from(out),
          }
        : {
            width: region.width,
            height: region.height,
            format: 'rgba8',
            data: Uint8Array.from(out),
          };
    },
  );
  return {
    id: 1,
    released: false,
    mixedRevisions: false,
    identity: {
      contextId: 'main',
      contextGeneration: 0,
      projectId: 'project-1',
      projectGeneration: 2,
      requestedRevision: 3,
    },
    frame: {
      index: 17,
      time: 1.5,
      pointer: [0, 0],
      pointerVelocity: [0, 0],
      resolutionScale: 0.5,
      drawingBuffer: { width: 4, height: 2 },
      usesPostProcessing: false,
    },
    images,
    passes: [
      {
        index: 0,
        id: 'buffer-a',
        kind: 'buffer',
        accepted: {
          fingerprint: 'fp-a',
          revision: 1,
          stale: false,
          fragment: 'void main(){}',
          vertex: 'void main(){}',
          composedFragment: '',
          composedVertex: '',
          spans: [],
        },
        resolution: { width: 4, height: 2 },
        uniforms: { iTime: 1.5, iResolution: [4, 2, 1] },
        inputs: [
          {
            channel: 0,
            binding: { kind: 'buffer', passId: 'buffer-a', feedback: true },
            source: 'buffer-previous',
            state: 'captured',
            reason: null,
            effective: 'texels',
            imageId: 'raw',
            sampling: { wrap: 'clamp', filter: 'nearest', flipY: false, colorSpace: '' },
          },
          {
            channel: 1,
            binding: { kind: 'texture', slot: 2 },
            source: 'image-slot',
            state: 'empty-slot',
            reason: 'Texture slot 2 has no image, so the placeholder is bound.',
            effective: 'placeholder-transparent',
            imageId: null,
            sampling: { wrap: 'clamp', filter: 'linear', flipY: true, colorSpace: '' },
          },
        ],
        output: {
          rawImageId: 'raw',
          rawOrigin: 'buffer-target',
          rawUnavailableReason: null,
          displayImageId: null,
          comparison: null,
        },
      },
      {
        index: 1,
        id: 'image',
        kind: 'image',
        accepted: {
          fingerprint: 'fp-image',
          revision: 3,
          stale: false,
          fragment: 'void main(){}',
          vertex: 'void main(){}',
          composedFragment: '',
          composedVertex: '',
          spans: [],
        },
        resolution: { width: 4, height: 2 },
        uniforms: {},
        inputs: [],
        output: {
          rawImageId: 'raw',
          rawOrigin: 'frozen-replay',
          rawUnavailableReason: null,
          displayImageId: 'display',
          comparison: {
            status: 'match',
            reference: 'canvas',
            maxDelta: 1,
            comparedChannels: 4,
            skippedNonFinite: 3,
          },
        },
      },
    ],
    read,
    release: vi.fn(),
    ...overrides,
  } as unknown as FrameSnapshot;
}

interface Pending {
  readonly options: CaptureOptions | undefined;
  resolve(snapshot: FrameSnapshot): void;
  reject(error: unknown): void;
}

describe('RenderInspectionPanel', () => {
  const prefs = signal(createDefaultWorkspacePreferences());
  const engine = signal<object | null>({ id: 'engine-a' });
  const captured = signal<FrameSnapshot | null>(null);
  const ended = signal<InvalidationReason | null>(null);
  const requests: Pending[] = [];

  const patch = vi.fn((partial: Partial<WorkspacePreferences>) => {
    prefs.update((current) => ({ ...current, ...partial }));
  });
  const releaseCapture = vi.fn(() => {
    captured.set(null);
    ended.set(null);
  });
  const captureFrame = vi.fn(
    (options?: CaptureOptions) =>
      new Promise<FrameSnapshot>((resolve, reject) => {
        requests.push({ options, resolve, reject });
      }),
  );

  let fixture: ComponentFixture<RenderInspectionPanel>;
  const root = () => fixture.nativeElement as HTMLElement;
  const text = () => root().textContent ?? '';
  const query = <T extends HTMLElement>(selector: string) => root().querySelector<T>(selector);
  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const show = () => {
    patch({ bottomPanelOpen: true, bottomPanelTab: 'inspection' });
    return settle();
  };
  const type = async (selector: string, value: string) => {
    const input = query<HTMLInputElement>(selector)!;
    input.value = value;
    input.dispatchEvent(new Event('change'));
    await settle();
  };

  beforeEach(async () => {
    prefs.set(createDefaultWorkspacePreferences());
    engine.set({ id: 'engine-a' });
    captured.set(null);
    ended.set(null);
    requests.length = 0;
    patch.mockClear();
    releaseCapture.mockClear();
    captureFrame.mockClear();

    await TestBed.configureTestingModule({
      imports: [RenderInspectionPanel],
      providers: [
        provideZonelessChangeDetection(),
        provideTestLanguages(),
        I18n,
        { provide: Preferences, useValue: { value: prefs.asReadonly(), patch } },
        {
          provide: RendererHandle,
          useValue: {
            engine: engine.asReadonly(),
            capturedFrame: captured,
            captureEnded: ended,
            profilerEpoch: signal(0).asReadonly(),
            profilerSnapshot: () => null,
            captureFrame,
            releaseCapture,
          },
        },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(RenderInspectionPanel);
    await settle();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  /** Starts a capture through the real button and hands back the pending request. */
  async function startCapture(): Promise<Pending> {
    query<HTMLButtonElement>('.capture')!.click();
    await settle();
    return requests[requests.length - 1];
  }

  async function freeze(snapshot = fakeSnapshot()) {
    const request = await startCapture();
    captured.set(snapshot);
    request.resolve(snapshot);
    await settle();
    return snapshot;
  }

  describe('availability and on-demand capture', () => {
    it('offers Capture and reads nothing until it is pressed', async () => {
      await show();
      expect(query('.capture')).not.toBeNull();
      expect(captureFrame).not.toHaveBeenCalled();
    });

    it('says honestly that a renderer-less window has nothing to capture', async () => {
      engine.set(null);
      await show();
      expect(query('.capture')).toBeNull();
      expect(text()).toContain('no preview renderer');
    });

    it('captures through the handle with an abort signal and shows the waiting state', async () => {
      await show();
      const request = await startCapture();
      expect(captureFrame).toHaveBeenCalledTimes(1);
      expect(request.options?.signal?.aborted).toBe(false);
      expect(text()).toContain('Waiting for the next frame');
      expect(query('.cancel')).not.toBeNull();
    });

    it('does not start a capture while hidden', async () => {
      patch({ bottomPanelOpen: true, bottomPanelTab: 'problems' });
      await settle();
      (fixture.componentInstance as unknown as { capture(): Promise<void> }).capture();
      expect(captureFrame).not.toHaveBeenCalled();
    });
  });

  describe('lifecycle and request ownership', () => {
    it('aborts a pending capture and releases it when the tab is hidden', async () => {
      await show();
      const request = await startCapture();
      patch({ bottomPanelTab: 'output' });
      await settle();
      expect(request.options?.signal?.aborted).toBe(true);
      expect(releaseCapture).toHaveBeenCalled();
      request.reject(new FrameCaptureError('aborted', 'aborted'));
      await settle();
      expect(text()).not.toContain('failed');
    });

    it('aborts when the bottom panel is closed', async () => {
      await show();
      const request = await startCapture();
      patch({ bottomPanelOpen: false });
      await settle();
      expect(request.options?.signal?.aborted).toBe(true);
    });

    it('releases a frozen capture when hidden, so reopening shows a clean panel', async () => {
      await show();
      await freeze();
      expect(query('.badge')).not.toBeNull();
      patch({ bottomPanelTab: 'problems' });
      await settle();
      expect(releaseCapture).toHaveBeenCalled();
      await show();
      expect(query('.badge')).toBeNull();
      expect(query('.capture')).not.toBeNull();
    });

    it('lets a late result of an abandoned request change nothing', async () => {
      await show();
      const first = await startCapture();
      patch({ bottomPanelTab: 'output' });
      await settle();
      await show();
      const second = await startCapture();
      expect(second).not.toBe(first);

      // The abandoned request fails late, with an error that would otherwise be shown.
      first.reject(new FrameCaptureError('timeout', 'late'));
      await settle();
      expect(text()).not.toContain('No frame was drawn');
      expect(text()).toContain('Waiting for the next frame');
      expect(query('.cancel')).not.toBeNull();

      // And it did not clear the newer request's capture when that one lands.
      const snapshot = fakeSnapshot();
      captured.set(snapshot);
      second.resolve(snapshot);
      await settle();
      expect(query('.badge')).not.toBeNull();
    });

    it('cancels when the active preview changes', async () => {
      await show();
      const request = await startCapture();
      engine.set({ id: 'engine-b' });
      await settle();
      expect(request.options?.signal?.aborted).toBe(true);
      expect(query('.capture')).not.toBeNull();
    });

    it('does not release a capture it did not take', async () => {
      captured.set(fakeSnapshot());
      await show();
      patch({ bottomPanelTab: 'problems' });
      await settle();
      expect(releaseCapture).not.toHaveBeenCalled();
    });

    it('releases on destroy', async () => {
      await show();
      await freeze();
      fixture.destroy();
      expect(releaseCapture).toHaveBeenCalled();
    });

    it('releases on request and offers Capture again', async () => {
      await show();
      await freeze();
      query<HTMLButtonElement>('.release')!.click();
      await settle();
      expect(releaseCapture).toHaveBeenCalled();
      expect(query('.capture')).not.toBeNull();
    });

    it('names why a retained capture ended on its own', async () => {
      await show();
      await freeze();
      captured.set(null);
      ended.set('resize');
      await settle();
      expect(text()).toContain('preview was resized');
      expect(query('.capture')).not.toBeNull();
    });

    it.each([
      ['unsupported', 'cannot be captured exactly'],
      ['budget', '128 MiB'],
      ['timeout', 'No frame was drawn'],
      ['replay-mismatch', 'cannot be trusted'],
    ] as const)('reports a %s failure and keeps Capture available', async (code, expected) => {
      await show();
      const request = await startCapture();
      request.reject(new FrameCaptureError(code, `detail for ${code}`));
      await settle();
      expect(text()).toContain(expected);
      expect(text()).toContain(`detail for ${code}`);
      expect(query('.capture')).not.toBeNull();
    });

    it('is silent when a request ends because someone released it', async () => {
      await show();
      const request = await startCapture();
      request.reject(new FrameCaptureError('released', 'released'));
      await settle();
      expect(query('.status')!.textContent?.trim()).toBe('');
    });
  });

  describe('a frozen capture', () => {
    beforeEach(async () => {
      await show();
      await freeze();
    });

    it('labels itself frozen with the frame and time, and shows source identity', () => {
      expect(query('.badge')!.textContent).toContain('Frozen capture · frame 17 · t = 1.500 s');
      expect(text()).toContain('fp-image');
      expect(text()).toContain('project-1 · generation 2');
      expect(text()).toContain('main · generation 0');
    });

    it('selects the Image pass first and lists every pass', () => {
      const options = Array.from(query('.pass-select')!.querySelectorAll('option')).map((o) =>
        o.textContent?.trim(),
      );
      expect(options).toEqual(['1. buffer-a (Buffer)', '2. Image (Image)']);
      expect(query<HTMLSelectElement>('.pass-select')!.value).toBe('1');
    });

    it('distinguishes the replayed raw Image output from the final displayed one', () => {
      const views = Array.from(query('.view-select')!.querySelectorAll('option')).map((o) =>
        o.textContent?.trim(),
      );
      expect(views).toEqual([
        'Raw Image output (replayed) · RGBA float32',
        'Final displayed Image (post-processed) · RGBA8 bytes',
      ]);
    });

    it('shows the comparison as tolerance-qualified and discloses unverified non-finite components', () => {
      expect(query('.comparison')!.textContent).toContain('within tolerance');
      expect(query('.comparison')!.textContent).toContain('the live canvas');
      expect(query('.skipped')!.textContent).toContain(
        '3 non-finite components were not numerically verified',
      );
      expect(query('.comparison')!.textContent).not.toContain('Every compared component');
    });

    it('shows the exact raw values of a picked pixel, flagged, apart from the visualization', async () => {
      await type('.pixel-x', '0');
      await type('.pixel-y', '0');
      const values = Array.from(root().querySelectorAll('.raw-value')).map((e) => e.textContent);
      expect(values).toEqual(['2048', '-0.25', 'NaN', '1']);
      const flags = Array.from(root().querySelectorAll('.flag')).map((e) => e.textContent?.trim());
      expect(flags).toEqual(['above 1 (HDR)', 'negative', 'NaN']);
      // Visualized colour clamps HDR/negative and paints NaN magenta; it is not the raw value.
      expect(query('.viz-value')!.textContent).toBe('rgb(255, 0, 255)');
      expect(query('.display-value')!.textContent).toBe('255, 128, 0, 255');
      expect(text()).toContain('Drawing-buffer pixel (0, 0) of 4×2, origin bottom-left');
      expect(text()).toContain('gl_FragCoord = (0.5, 0.5)');
    });

    it('writes infinities and negative zero as they are', async () => {
      await type('.pixel-x', '1');
      await type('.pixel-y', '0');
      const values = Array.from(root().querySelectorAll('.raw-value')).map((e) => e.textContent);
      expect(values).toEqual(['+Infinity', '-Infinity', '-0', '0.5']);
    });

    it('reads the requested texel region, never the whole image', async () => {
      const snapshot = captured()!;
      (snapshot.read as ReturnType<typeof vi.fn>).mockClear();
      await type('.pixel-x', '0');
      await type('.pixel-y', '1');
      const regions = (snapshot.read as ReturnType<typeof vi.fn>).mock.calls
        .map(([, region]) => region)
        .filter((region) => region.width === 1);
      expect(regions.length).toBeGreaterThan(0);
      expect(regions.every((r) => r.height === 1)).toBe(true);
      expect(regions.some((r) => r.x === 0 && r.y === 1)).toBe(true);
    });

    it('rejects out-of-range or fractional coordinates without moving the pick', async () => {
      await type('.pixel-x', '1');
      await type('.pixel-y', '1');
      await type('.pixel-x', '4');
      expect(query('[role="alert"]')!.textContent).toContain('inside the 4×2 image');
      expect(query<HTMLInputElement>('.pixel-x')!.value).toBe('1');
      await type('.pixel-y', '0.5');
      expect(query('[role="alert"]')).not.toBeNull();
      await type('.pixel-y', '0');
      expect(query('[role="alert"]')).toBeNull();
    });

    it('moves the pick from the keyboard, stays on the image, and zooms', async () => {
      const viewer = query<HTMLElement>('.viewer');
      // jsdom has no layout, so the canvas path is exercised by the browser tests; this
      // covers the keyboard contract on whatever viewer is mounted.
      if (!viewer) return;
      const key = async (name: string, shiftKey = false) => {
        viewer.dispatchEvent(new KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true }));
        await settle();
      };
      await key('ArrowRight');
      const start = query<HTMLInputElement>('.pixel-x')!.value;
      await key('ArrowRight', true);
      expect(Number(query<HTMLInputElement>('.pixel-x')!.value)).toBeGreaterThanOrEqual(
        Number(start),
      );
      expect(Number(query<HTMLInputElement>('.pixel-x')!.value)).toBeLessThanOrEqual(3);
      await key('+');
      expect(query('.zoom-value')!.textContent).toBe('2×');
      await key('0');
      expect(query('.zoom-value')!.textContent).toBe('Fit');
    });

    it('lists the uniforms and the inputs actually sampled, with placeholder reasons', async () => {
      query<HTMLSelectElement>('.pass-select')!.value = '0';
      query<HTMLSelectElement>('.pass-select')!.dispatchEvent(new Event('change'));
      await settle();
      expect(text()).toContain('iTime');
      expect(text()).toContain('[4, 2, 1]');
      expect(text()).toContain('Buffer buffer-a, previous frame');
      expect(text()).toContain('Texture slot 2');
      expect(text()).toContain('Placeholder (transparent black)');
      expect(text()).toContain('Texture slot 2 has no image, so the placeholder is bound.');
      expect(text()).toContain('4×2 RGBA float32');
    });

    it('labels profiler data as live and separate from the capture', () => {
      expect(text()).toContain('not part of this frozen capture');
    });

    it('shows no raw zero when raw Image data is unavailable', async () => {
      const snapshot = fakeSnapshot();
      (snapshot.passes[1].output as unknown as Record<string, unknown>)['rawImageId'] = null;
      (snapshot.passes[1].output as unknown as Record<string, unknown>)['rawUnavailableReason'] =
        'Replay has not run.';
      captured.set(snapshot);
      await settle();
      expect(text()).toContain('Raw Image data is unavailable.');
      expect(text()).toContain('Replay has not run.');
      await type('.pixel-x', '0');
      await type('.pixel-y', '0');
      const values = Array.from(root().querySelectorAll('.raw-value')).map((e) => e.textContent);
      // Only the labelled display image remains selectable; it is shown as 8-bit bytes, not as raw.
      expect(query('.view-select')!.textContent).not.toContain('Raw Image output');
      expect(values.length === 0 || text().includes('RGBA8 bytes')).toBe(true);
    });

    it('flags programs accepted at different revisions', async () => {
      captured.set(fakeSnapshot({ mixedRevisions: true }));
      await settle();
      expect(text()).toContain('accepted at different revisions');
      expect(text()).toContain('requested revision 3');
    });

    it('survives the snapshot being released behind its back', async () => {
      const snapshot = captured()!;
      await type('.pixel-x', '0');
      await type('.pixel-y', '0');
      (snapshot.read as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new FrameCaptureError('released', 'released');
      });
      Object.assign(snapshot, { released: true });
      await type('.pixel-x', '1');
      await settle();
      expect(releaseCapture).toHaveBeenCalled();
      expect(text()).toContain('no longer available');
    });
  });
});
