import { DestroyRef, Injectable, effect, inject, signal, untracked } from '@angular/core';

import { DocumentState } from '../workspace/state/document-state';
import { RendererHandle } from './renderer-handle';

/** A frozen frame the live preview is compared against. */
export interface CompareReferenceFrame {
  readonly bitmap: ImageBitmap;
  /** The bitmap's size: the drawing buffer it was captured from, in device pixels. */
  readonly width: number;
  readonly height: number;
  /** The shader it belongs to; the overlay is shown only while that shader is open. */
  readonly shaderId: string;
  readonly capturedAt: number;
  readonly label?: string;
}

export interface CompareReferenceMeta {
  shaderId: string;
  label?: string;
}

export const DEFAULT_COMPARE_SPLIT = 0.5;

/**
 * The single pinned reference for canvas compare, and the wipe state around it.
 *
 * One reference at a time: pinning or setting another closes the bitmap it
 * replaces, and so does unpinning, deleting its shader, losing the active GPU
 * context and tearing the app down. Memory only — nothing here is persisted.
 */
@Injectable({ providedIn: 'root' })
export class CompareReference {
  private readonly state = inject(DocumentState);
  private readonly renderer = inject(RendererHandle);

  private readonly current = signal<CompareReferenceFrame | null>(null);
  private readonly splitValue = signal(DEFAULT_COMPARE_SPLIT);
  private readonly swappedValue = signal(false);
  private readonly holdingValue = signal(false);
  /** Bumped by every unpin, so a capture still in flight cannot resurrect a cleared reference. */
  private generation = 0;
  private destroyed = false;

  readonly reference = this.current.asReadonly();
  /** Where the wipe divides the stage, from 0 (left edge) to 1 (right edge). */
  readonly split = this.splitValue.asReadonly();
  /** The reference is on the right of the divider instead of the left. */
  readonly swapped = this.swappedValue.asReadonly();
  /** The reference covers the whole stage while held. */
  readonly holding = this.holdingValue.asReadonly();

  constructor() {
    // A reference whose shader left the library goes with it. The open one is
    // kept until the selection moves on, as the session snapshots do.
    effect(() => {
      const live = new Set(this.state.shaders().map((shader) => shader.id));
      const selected = this.state.selectedId();
      const shaderId = this.current()?.shaderId;
      if (shaderId !== undefined && !live.has(shaderId) && shaderId !== selected) {
        untracked(() => this.unpin());
      }
    });

    // The reference describes a frame of the active context; a lost context ends it.
    effect((onCleanup) => {
      const engine = this.renderer.engine();
      if (engine) onCleanup(engine.context.onLost(() => this.unpin()));
    });

    inject(DestroyRef).onDestroy(() => {
      this.unpin();
      this.destroyed = true;
    });
  }

  /** Reactive: whether the reference should be drawn over `shaderId`'s preview. */
  visibleFor(shaderId: string | null): boolean {
    const reference = this.current();
    return reference !== null && shaderId !== null && reference.shaderId === shaderId;
  }

  /**
   * Pin the open shader's current frame, at drawing-buffer size. Playback,
   * pause and pointer state are left alone. `false` when there is no document
   * or nothing rendering, or when the selection moved or the reference was
   * cleared while the frame was being read.
   */
  async pin(label?: string): Promise<boolean> {
    const shaderId = this.state.selectedId();
    if (shaderId === null || this.destroyed) return false;
    const generation = this.generation;

    const frame = await this.renderer.captureFrameBlob();
    if (!frame) return false;
    const bitmap = await createImageBitmap(frame);
    if (this.destroyed || generation !== this.generation || this.state.selectedId() !== shaderId) {
      bitmap.close();
      return false;
    }

    this.setReference(bitmap, { shaderId, label });
    return true;
  }

  /**
   * Make `bitmap` the reference — the hook other features (the snapshot wall)
   * use to compare against a frame they hold. Takes ownership: the bitmap is
   * closed when it is replaced or cleared, so pass one you will not draw again.
   */
  setReference(bitmap: ImageBitmap, meta: CompareReferenceMeta): void {
    if (this.destroyed) {
      bitmap.close();
      return;
    }
    const previous = this.current();
    const label = meta.label?.trim();
    this.current.set({
      bitmap,
      width: bitmap.width,
      height: bitmap.height,
      shaderId: meta.shaderId,
      capturedAt: Date.now(),
      ...(label ? { label } : {}),
    });
    if (previous && previous.bitmap !== bitmap) previous.bitmap.close();
  }

  /** Clear the reference and close its bitmap. The next pin starts centred and unswapped. */
  unpin(): void {
    this.generation++;
    const previous = this.current();
    this.current.set(null);
    this.splitValue.set(DEFAULT_COMPARE_SPLIT);
    this.swappedValue.set(false);
    this.holdingValue.set(false);
    previous?.bitmap.close();
  }

  setSplit(value: number): void {
    this.splitValue.set(clampSplit(value));
  }

  nudge(delta: number): void {
    this.setSplit(this.splitValue() + delta);
  }

  toggleSwap(): void {
    this.swappedValue.update((swapped) => !swapped);
  }

  hold(holding: boolean): void {
    this.holdingValue.set(holding && this.current() !== null);
  }
}

export function clampSplit(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : DEFAULT_COMPARE_SPLIT;
}
