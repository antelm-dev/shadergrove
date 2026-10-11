import { DestroyRef, Injectable, effect, inject, signal, untracked } from '@angular/core';

import { newId } from '@shadergrove/shared/project';
import { RendererHandle } from '../../rendering/renderer-handle';
import { scaleFrame } from '../../rendering/thumbnail';
import { DocumentState } from '../state/document-state';
import type { SessionSnapshot } from './snapshot-model';

/** Per shader. Past it, the oldest unlabelled snapshot goes first. */
export const SNAPSHOT_CAP = 24;
export const SNAPSHOT_THUMBNAIL = { width: 240, height: 135 } as const;
export const SNAPSHOT_LABEL_MAX = 80;

/**
 * The session's snapshot strip, per shader, newest first.
 *
 * Memory only — nothing here survives a reload. What it does hold is bounded:
 * a cap per shader, every thumbnail URL revoked the moment its snapshot is
 * dropped (removed, evicted, its shader deleted, the library closed), and all
 * of them when the app is torn down.
 */
@Injectable({ providedIn: 'root' })
export class SessionSnapshots {
  private readonly state = inject(DocumentState);
  private readonly renderer = inject(RendererHandle);

  private readonly snapshots = signal<ReadonlyMap<string, readonly SessionSnapshot[]>>(new Map());
  private destroyed = false;

  /** Every shader's snapshots, newest first. */
  readonly byShader = this.snapshots.asReadonly();

  constructor() {
    // A shader that left the library takes its snapshots with it — whichever
    // path removed it. The open one is kept until the selection moves on.
    effect(() => {
      const live = new Set(this.state.shaders().map((shader) => shader.id));
      const selected = this.state.selectedId();
      untracked(() => {
        for (const shaderId of this.snapshots().keys()) {
          if (!live.has(shaderId) && shaderId !== selected) this.clearShader(shaderId);
        }
      });
    });

    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      for (const list of this.snapshots().values()) list.forEach(revoke);
      this.snapshots.set(new Map());
    });
  }

  /** One shader's snapshots, newest first. Reactive when read inside a computed or template. */
  forShader(shaderId: string): readonly SessionSnapshot[] {
    return this.snapshots().get(shaderId) ?? [];
  }

  /**
   * Pin the open shader's draft, params and channel metadata with the frame on
   * screen. Read-only on the document: playback, the draft and its revision are
   * untouched. `null` when there is no document or nothing rendering, or when
   * the selection moved while the frame was being read.
   */
  async capture(label?: string): Promise<SessionSnapshot | null> {
    const record = this.state.record();
    const draft = this.state.draft();
    if (!record || !draft) return null;

    // Taken before the first await, so the snapshot is the state the user pinned.
    const held = structuredClone({
      draft,
      params: this.state.params(),
      channels: record.channels,
    });

    const frame = await this.renderer.captureFrameBlob();
    if (!frame) return null;
    const thumbnail = await scaleFrame(frame, SNAPSHOT_THUMBNAIL).catch(() => null);
    if (this.destroyed || this.state.selectedId() !== record.id) return null;

    const name = normaliseLabel(label);
    const snapshot: SessionSnapshot = Object.freeze({
      id: newId('snapshot'),
      shaderId: record.id,
      createdAt: Date.now(),
      revision: record.revision,
      draft: deepFreeze(held.draft),
      params: deepFreeze(held.params),
      channels: deepFreeze(held.channels),
      frame,
      // A frame that could not be scaled still gets a picture: the full PNG.
      thumbnailUrl: URL.createObjectURL(thumbnail ?? frame),
      ...(name ? { label: name } : {}),
    });

    const kept = [snapshot, ...this.forShader(record.id)];
    const evicted = evict(kept);
    this.write(record.id, kept);
    evicted.forEach(revoke);
    return snapshot;
  }

  remove(id: string): void {
    for (const [shaderId, list] of this.snapshots()) {
      const target = list.find((snapshot) => snapshot.id === id);
      if (!target) continue;
      this.write(
        shaderId,
        list.filter((snapshot) => snapshot !== target),
      );
      revoke(target);
      return;
    }
  }

  /** Set or, with blank text, clear a snapshot's label. Labelled snapshots outlive eviction. */
  label(id: string, text: string): void {
    const name = normaliseLabel(text);
    for (const [shaderId, list] of this.snapshots()) {
      const index = list.findIndex((snapshot) => snapshot.id === id);
      if (index < 0) continue;
      const { label: _previous, ...rest } = list[index];
      const next = [...list];
      next[index] = Object.freeze(name ? { ...rest, label: name } : rest);
      this.write(shaderId, next);
      return;
    }
  }

  /** Drop every snapshot of a shader. */
  clearShader(shaderId: string): void {
    const list = this.snapshots().get(shaderId);
    if (!list) return;
    this.snapshots.update((map) => {
      const next = new Map(map);
      next.delete(shaderId);
      return next;
    });
    list.forEach(revoke);
  }

  private write(shaderId: string, list: readonly SessionSnapshot[]): void {
    this.snapshots.update((map) => {
      const next = new Map(map);
      if (list.length > 0) next.set(shaderId, list);
      else next.delete(shaderId);
      return next;
    });
  }
}

/**
 * Trim `list` (newest first) to the cap in place, returning what was removed:
 * the oldest unlabelled snapshot first, then — only if everything is labelled —
 * the oldest of all. The snapshot just taken is never the one evicted.
 */
function evict(list: SessionSnapshot[]): SessionSnapshot[] {
  const evicted: SessionSnapshot[] = [];
  while (list.length > SNAPSHOT_CAP) {
    let index = list.length - 1;
    while (index > 0 && list[index].label !== undefined) index--;
    if (index === 0) index = list.length - 1;
    evicted.push(...list.splice(index, 1));
  }
  return evicted;
}

function normaliseLabel(text: string | undefined): string | undefined {
  const trimmed = text?.trim().slice(0, SNAPSHOT_LABEL_MAX);
  return trimmed ? trimmed : undefined;
}

function revoke(snapshot: SessionSnapshot): void {
  URL.revokeObjectURL(snapshot.thumbnailUrl);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
