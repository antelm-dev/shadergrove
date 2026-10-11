import { provideZonelessChangeDetection, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CompareReference } from '../../rendering/compare-reference';
import { RendererHandle } from '../../rendering/renderer-handle';
import { DocumentState } from '../../workspace/state/document-state';
import { CompareOverlay, fitReference } from './compare-overlay';

function fakeBitmap(width: number, height: number) {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap & {
    close: ReturnType<typeof vi.fn>;
  };
}

describe('fitReference (AC-CMP-02)', () => {
  it('fills the box when the aspect matches, at any resolution scale', () => {
    // 1600×900 at full scale, 400×225 at 0.25: both cover the 800×450 CSS box exactly.
    for (const source of [
      { width: 1600, height: 900 },
      { width: 400, height: 225 },
    ]) {
      expect(fitReference(source, { width: 800, height: 450 })).toEqual({
        x: 0,
        y: 0,
        width: 800,
        height: 450,
        letterboxed: false,
      });
    }
  });

  it('absorbs the rounding of a scaled drawing buffer', () => {
    // 563 × 0.25 = 140.75, rounded down by the renderer.
    expect(
      fitReference({ width: 250, height: 140 }, { width: 1000, height: 563 }).letterboxed,
    ).toBe(false);
  });

  it('letterboxes, centred, a reference taken at another aspect', () => {
    expect(fitReference({ width: 1600, height: 900 }, { width: 800, height: 800 })).toEqual({
      x: 0,
      y: 175,
      width: 800,
      height: 450,
      letterboxed: true,
    });
    expect(fitReference({ width: 900, height: 900 }, { width: 1600, height: 900 })).toEqual({
      x: 350,
      y: 0,
      width: 900,
      height: 900,
      letterboxed: true,
    });
  });

  it('never divides by an empty box', () => {
    expect(fitReference({ width: 10, height: 10 }, { width: 0, height: 0 }).letterboxed).toBe(
      false,
    );
  });
});

describe('CompareOverlay', () => {
  let fixture: ComponentFixture<CompareOverlay>;
  let compare: CompareReference;
  let selectedId: ReturnType<typeof signal<string | null>>;
  let resize: (width: number, height: number) => void;
  let observers: { disconnect: ReturnType<typeof vi.fn> }[];
  let draws: unknown[][];

  beforeEach(() => {
    observers = [];
    draws = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        disconnect = vi.fn();
        constructor(callback: ResizeObserverCallback) {
          observers.push(this);
          resize = (width, height) =>
            callback(
              [{ contentRect: { width, height } } as ResizeObserverEntry],
              this as unknown as ResizeObserver,
            );
        }
        observe(): void {}
      },
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () =>
        ({
          fillRect: (...args: unknown[]) => draws.push(['fillRect', ...args]),
          drawImage: (...args: unknown[]) => draws.push(['drawImage', ...args]),
        }) as never,
    );
    vi.stubGlobal('devicePixelRatio', 2);

    selectedId = signal<string | null>('waves');
    TestBed.configureTestingModule({
      imports: [CompareOverlay],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: DocumentState,
          useValue: { selectedId, shaders: signal([{ id: 'waves' }, { id: 'plasma' }]) },
        },
        { provide: RendererHandle, useValue: { engine: signal(null) } },
      ],
    });
    compare = TestBed.inject(CompareReference);
    fixture = TestBed.createComponent(CompareOverlay);
    resize(800, 450);
    fixture.detectChanges();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const el = () => fixture.nativeElement as HTMLElement;
  const canvas = () => el().querySelector<HTMLCanvasElement>('canvas.reference');
  const handle = () => el().querySelector<HTMLElement>('.handle');
  const settle = async () => {
    await fixture.whenStable();
    fixture.detectChanges();
  };

  async function pin(width = 1600, height = 900) {
    const bitmap = fakeBitmap(width, height);
    compare.setReference(bitmap, { shaderId: 'waves' });
    await settle();
    return bitmap;
  }

  it('renders nothing without a reference', () => {
    expect(el().children).toHaveLength(0);
  });

  it('draws the reference over the live canvas box, at device pixels, with a centred handle', async () => {
    const bitmap = await pin();

    expect(canvas()?.width).toBe(1600);
    expect(canvas()?.height).toBe(900);
    expect(draws).toEqual([['drawImage', bitmap, 0, 0, 1600, 900]]);
    expect(canvas()?.style.clipPath).toBe('inset(0 50% 0 0)');
    expect(handle()?.getAttribute('role')).toBe('slider');
    expect(handle()?.getAttribute('aria-valuenow')).toBe('50');
    expect(handle()?.getAttribute('aria-label')).toBeTruthy();
    expect(handle()?.style.left).toBe('50%');
    expect(el().querySelector('.note')).toBeNull();
  });

  it('stays aligned when the box is resized (AC-CMP-02)', async () => {
    const bitmap = await pin();
    draws = [];

    resize(400, 225);
    await settle();

    expect(canvas()?.width).toBe(800);
    expect(draws).toEqual([['drawImage', bitmap, 0, 0, 800, 450]]);
    expect(fixture.componentInstance.aspectMismatch()).toBe(false);
  });

  it('letterboxes and labels a reference whose aspect no longer matches', async () => {
    const bitmap = await pin();
    draws = [];

    resize(450, 450);
    await settle();

    expect(fixture.componentInstance.aspectMismatch()).toBe(true);
    expect(el().querySelector('.note')?.textContent?.trim()).toBeTruthy();
    expect(draws).toEqual([
      ['fillRect', 0, 0, 900, 900],
      ['drawImage', bitmap, 0, 196.875, 900, 506.25],
    ]);
  });

  it('is hidden on other shaders and back when its shader returns (AC-CMP-04)', async () => {
    await pin();

    selectedId.set('plasma');
    await settle();
    expect(canvas()).toBeNull();
    expect(handle()).toBeNull();

    selectedId.set('waves');
    await settle();
    expect(canvas()).not.toBeNull();
  });

  it('moves with keyboard nudges: 1 %, Shift 10 %', async () => {
    await pin();

    handle()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true }));
    expect(compare.split()).toBeCloseTo(0.49);
    const shifted = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      shiftKey: true,
      cancelable: true,
    });
    handle()?.dispatchEvent(shifted);
    expect(compare.split()).toBeCloseTo(0.59);
    expect(shifted.defaultPrevented).toBe(true);

    const other = new KeyboardEvent('keydown', { key: 'b', cancelable: true });
    handle()?.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);

    await settle();
    expect(handle()?.getAttribute('aria-valuenow')).toBe('59');
    expect(canvas()?.style.clipPath).toBe('inset(0 41% 0 0)');
  });

  it('drags the split with pointer capture', async () => {
    await pin();
    const target = handle() as HTMLElement;
    const captured = new Set<number>();
    target.setPointerCapture = (id) => captured.add(id);
    target.hasPointerCapture = (id) => captured.has(id);
    target.releasePointerCapture = (id) => captured.delete(id);
    vi.spyOn(el(), 'getBoundingClientRect').mockReturnValue({
      left: 100,
      width: 800,
    } as DOMRect);

    const pointer = (type: string, clientX: number) => {
      const event = new MouseEvent(type, { clientX, button: 0, bubbles: true, cancelable: true });
      Object.defineProperty(event, 'pointerId', { value: 7 });
      target.dispatchEvent(event);
    };

    pointer('pointermove', 300);
    expect(compare.split()).toBe(0.5);

    pointer('pointerdown', 500);
    pointer('pointermove', 300);
    expect(compare.split()).toBe(0.25);
    pointer('pointermove', 2000);
    expect(compare.split()).toBe(1);
    pointer('pointerup', 300);
    pointer('pointermove', 300);
    expect(compare.split()).toBe(1);
    expect(captured.size).toBe(0);
  });

  it('flips sides when swapped and covers the stage while held', async () => {
    await pin();
    compare.setSplit(0.25);
    compare.toggleSwap();
    await settle();
    expect(canvas()?.style.clipPath).toBe('inset(0 0 0 25%)');

    compare.hold(true);
    await settle();
    expect(canvas()?.style.clipPath).toBe('none');
    expect(handle()).toBeNull();

    compare.hold(false);
    await settle();
    expect(canvas()?.style.clipPath).toBe('inset(0 0 0 25%)');
  });

  it('disconnects its observer when destroyed', () => {
    fixture.destroy();
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
  });
});
