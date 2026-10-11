import {
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';

import { CompareReference, type CompareReferenceFrame } from '../../rendering/compare-reference';
import { DocumentState } from '../../workspace/state/document-state';

/** shortcut: placeholder copy until the compare commands land with their translation keys. */
export const COMPARE_OVERLAY_TEXT = {
  handle: 'Reference wipe position',
  aspectMismatch: 'Reference aspect differs: letterboxed',
} as const;

/** Arrow keys move the wipe 1 %, Shift+arrow 10 %. */
export const COMPARE_NUDGE = 0.01;
export const COMPARE_NUDGE_LARGE = 0.1;

/** How far apart two aspect ratios may be before the reference is letterboxed. */
const ASPECT_TOLERANCE = 0.01;

export interface Size {
  width: number;
  height: number;
}

export interface ReferenceFit {
  x: number;
  y: number;
  width: number;
  height: number;
  letterboxed: boolean;
}

/**
 * Where a `source`-sized reference lands in a `target` box. The same aspect
 * fills the box exactly — that is what keeps it pixel-aligned with the live
 * canvas whatever the resolution scale — and a different one is fitted inside
 * it, centred, and reported as letterboxed.
 */
export function fitReference(source: Size, target: Size): ReferenceFit {
  const fill = { x: 0, y: 0, width: target.width, height: target.height, letterboxed: false };
  if (source.width <= 0 || source.height <= 0 || target.width <= 0 || target.height <= 0) {
    return fill;
  }
  // A drawing buffer is the CSS box scaled and rounded, so tiny buffers drift by a pixel.
  const tolerance = Math.max(ASPECT_TOLERANCE, 2 / Math.min(source.width, source.height));
  const ratio = source.width / source.height / (target.width / target.height);
  if (Math.abs(ratio - 1) <= tolerance) return fill;

  const scale = Math.min(target.width / source.width, target.height / source.height);
  const width = source.width * scale;
  const height = source.height * scale;
  return {
    x: (target.width - width) / 2,
    y: (target.height - height) / 2,
    width,
    height,
    letterboxed: true,
  };
}

/**
 * The pinned reference, drawn over the live canvas and wiped against it.
 *
 * A sibling of `app-shader-canvas` covering the same box. Only the handle takes
 * pointer events: everything else passes through to the shader underneath.
 * Renders nothing unless the open shader is the one the reference belongs to.
 */
@Component({
  selector: 'app-compare-overlay',
  template: `
    @if (reference()) {
      <canvas #canvas class="reference" aria-hidden="true" [style.clip-path]="clipPath()"></canvas>
      @if (aspectMismatch()) {
        <span class="note">{{ text.aspectMismatch }}</span>
      }
      @if (!compare.holding()) {
        <div
          class="handle"
          role="slider"
          tabindex="0"
          aria-orientation="horizontal"
          aria-valuemin="0"
          aria-valuemax="100"
          [attr.aria-valuenow]="percent()"
          [attr.aria-valuetext]="percent() + '%'"
          [attr.aria-label]="text.handle"
          [style.left.%]="percent()"
          (pointerdown)="onPointerDown($event)"
          (pointermove)="onPointerMove($event)"
          (pointerup)="onPointerUp($event)"
          (pointercancel)="onPointerUp($event)"
          (keydown)="onKeyDown($event)"
        ></div>
      }
    }
  `,
  styles: `
    :host {
      position: absolute;
      inset: 0;
      z-index: 2;
      display: block;
      overflow: hidden;
      pointer-events: none;
    }

    .reference {
      position: absolute;
      inset: 0;
      display: block;
      width: 100%;
      height: 100%;
    }

    .note {
      position: absolute;
      top: 8px;
      left: 50%;
      transform: translateX(-50%);
      padding: 2px 8px;
      border-radius: 4px;
      background: rgb(0 0 0 / 60%);
      color: #fff;
      font: var(--mat-sys-label-small);
      white-space: nowrap;
    }

    .handle {
      position: absolute;
      top: 0;
      bottom: 0;
      width: 16px;
      margin-left: -8px;
      cursor: ew-resize;
      pointer-events: auto;
      touch-action: none;
    }

    .handle::before {
      content: '';
      position: absolute;
      top: 0;
      bottom: 0;
      left: 7px;
      width: 2px;
      background: #fff;
      box-shadow: 0 0 2px rgb(0 0 0 / 80%);
    }

    .handle:focus-visible {
      outline: 2px solid var(--mat-sys-primary);
      outline-offset: -2px;
    }
  `,
})
export class CompareOverlay {
  protected readonly compare = inject(CompareReference);
  private readonly state = inject(DocumentState);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('canvas');

  protected readonly text = COMPARE_OVERLAY_TEXT;

  /** The host's CSS box — the live canvas's, since both fill the preview body. */
  readonly size = signal<Size>({ width: 0, height: 0 });

  /** The reference to draw, or null when it belongs to another shader (or there is none). */
  readonly reference = computed(() =>
    this.compare.visibleFor(this.state.selectedId()) ? this.compare.reference() : null,
  );

  readonly aspectMismatch = computed(() => {
    const ref = this.reference();
    return ref !== null && fitReference(ref, this.size()).letterboxed;
  });

  protected readonly percent = computed(() => Math.round(this.compare.split() * 1000) / 10);

  protected readonly clipPath = computed(() => {
    if (this.compare.holding()) return 'none';
    const split = this.compare.split() * 100;
    return this.compare.swapped() ? `inset(0 0 0 ${split}%)` : `inset(0 ${100 - split}% 0 0)`;
  });

  constructor() {
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      this.size.set({ width, height });
    });
    observer.observe(this.host.nativeElement);
    inject(DestroyRef).onDestroy(() => observer.disconnect());

    // The split, swap and hold are CSS; only a new reference, canvas or size repaints.
    effect(() => {
      const canvas = this.canvasRef()?.nativeElement;
      const ref = this.reference();
      const size = this.size();
      if (canvas && ref) paint(canvas, ref, size, window.devicePixelRatio || 1);
    });
  }

  protected onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  protected onPointerMove(event: PointerEvent): void {
    const handle = event.currentTarget as HTMLElement;
    if (!handle.hasPointerCapture(event.pointerId)) return;
    const box = this.host.nativeElement.getBoundingClientRect();
    if (box.width > 0) this.compare.setSplit((event.clientX - box.left) / box.width);
  }

  protected onPointerUp(event: PointerEvent): void {
    const handle = event.currentTarget as HTMLElement;
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
  }

  protected onKeyDown(event: KeyboardEvent): void {
    const step = event.shiftKey ? COMPARE_NUDGE_LARGE : COMPARE_NUDGE;
    if (event.key === 'ArrowLeft') this.compare.nudge(-step);
    else if (event.key === 'ArrowRight') this.compare.nudge(step);
    else return;
    event.preventDefault();
    event.stopPropagation();
  }
}

function paint(
  canvas: HTMLCanvasElement,
  reference: CompareReferenceFrame,
  box: Size,
  dpr: number,
): void {
  // Resizing the backing store also clears it.
  canvas.width = Math.max(1, Math.round(box.width * dpr));
  canvas.height = Math.max(1, Math.round(box.height * dpr));
  const context = canvas.getContext('2d');
  if (!context) return;
  const fit = fitReference(reference, canvas);
  if (fit.letterboxed) {
    context.fillStyle = '#0b0b0c';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  context.drawImage(reference.bitmap, fit.x, fit.y, fit.width, fit.height);
}
