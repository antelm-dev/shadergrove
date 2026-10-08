/**
 * Contained-surface instance registry: records, activation, and z-order.
 *
 * Generalizes WorkspaceWindowStack beyond editor|preview. The most recently
 * activated stacked surface is foreground. Does not persist — Agent 06 wires
 * snapshot() into layout preferences.
 *
 * SSR-safe: no browser globals at construction or module evaluation.
 */

import { Injectable, computed, signal } from '@angular/core';

import type { Size } from '@shadergrove/shared/geometry';
import {
  DEFAULT_EDITOR_GROUP_ID,
  LAYOUT_VERSION,
  createDefaultSurface,
  defaultEditorLayout,
  editorSurfaceId,
  sanitizeEditorLayout,
  isContainedPlacement,
  isNativePlacement,
  sanitizeLayoutPreferences,
  type EditorLayoutNode,
  type LayoutPreferences,
  type SurfaceId,
  type SurfaceKind,
  type SurfaceRecord,
} from '@shadergrove/shared/surfaces';

/** Base z-index for stacked contained windows; foreground is base + order. */
export const SURFACE_STACK_Z_BASE = 3;

export interface SurfaceRegistrySnapshot {
  readonly surfaces: readonly SurfaceRecord[];
  readonly zOrder: readonly SurfaceId[];
  readonly viewport: Size;
}

@Injectable({ providedIn: 'root' })
export class SurfaceRegistry {
  private readonly records = signal<ReadonlyMap<SurfaceId, SurfaceRecord>>(new Map());
  /** Contained activation order; last entry is foreground. */
  private readonly order = signal<SurfaceId[]>([]);
  private readonly viewportSize = signal<Size>({ width: 0, height: 0 });
  private readonly layoutTree = signal<EditorLayoutNode>(defaultEditorLayout());

  readonly surfaces = computed(() => [...this.records().values()]);
  readonly zOrder = this.order.asReadonly();
  readonly viewport = this.viewportSize.asReadonly();
  /** Contained editor split tree; leaves are editor surface ids. */
  readonly editorLayout = this.layoutTree.asReadonly();

  /** Most recently activated contained stacked surface, if any. */
  readonly foreground = computed<SurfaceId | null>(() => {
    const order = this.order();
    for (let i = order.length - 1; i >= 0; i--) {
      const id = order[i]!;
      const surface = this.records().get(id);
      if (surface && surface.open && this.isStackable(surface)) return id;
    }
    return null;
  });

  /** Hydrate from a layout document (migration output or preferences). */
  hydrate(layout: LayoutPreferences | unknown): void {
    const sanitized = sanitizeLayoutPreferences(layout, { viewport: this.viewportSize() });
    const map = new Map<SurfaceId, SurfaceRecord>();
    for (const surface of sanitized.surfaces) {
      map.set(surface.id, surface);
    }
    this.records.set(map);
    this.order.set(sanitized.zOrder.filter((id) => map.has(id)));
    this.layoutTree.set(sanitized.editorLayout);
  }

  setEditorLayout(layout: EditorLayoutNode): void {
    this.layoutTree.set(layout);
  }

  /**
   * Re-check the split tree against the records as they are now (after
   * `ensure`, say): every open contained editor appears once, and the default
   * editor — the frame the split lives in — always does, open or not.
   */
  repairEditorLayout(): void {
    const editors = this.surfaces().filter(
      (surface) => surface.kind === 'editor' && isContainedPlacement(surface.placement),
    );
    const defaultId = editorSurfaceId(DEFAULT_EDITOR_GROUP_ID);
    const hasDefault = editors.some((surface) => surface.id === defaultId);
    const fallback = hasDefault ? defaultId : (editors[0]?.id ?? defaultId);
    const repaired = sanitizeEditorLayout(this.layoutTree(), {
      known: editors.map((surface) => surface.id),
      required: [
        ...(hasDefault ? [defaultId] : []),
        ...editors.filter((surface) => surface.open).map((surface) => surface.id),
      ],
      fallback,
    });
    if (JSON.stringify(repaired) !== JSON.stringify(this.layoutTree()))
      this.layoutTree.set(repaired);
  }

  /** Ensure a default instance exists for a kind (idempotent for singletons). */
  ensure(kind: SurfaceKind, overrides?: Parameters<typeof createDefaultSurface>[1]): SurfaceRecord {
    const created = createDefaultSurface(kind, overrides);
    const existing = this.records().get(created.id);
    if (existing) return existing;
    this.upsert(created);
    return created;
  }

  get(id: SurfaceId): SurfaceRecord | undefined {
    return this.records().get(id);
  }

  upsert(surface: SurfaceRecord): void {
    this.records.update((map) => {
      const next = new Map(map);
      next.set(surface.id, surface);
      return next;
    });

    if (this.isStackable(surface)) {
      this.order.update((order) => (order.includes(surface.id) ? order : [...order, surface.id]));
    } else {
      // Docked/stage/closed surfaces leave the stacking list.
      this.order.update((order) => order.filter((entry) => entry !== surface.id));
    }
  }

  remove(id: SurfaceId): void {
    this.records.update((map) => {
      const next = new Map(map);
      next.delete(id);
      return next;
    });
    this.order.update((order) => order.filter((entry) => entry !== id));
  }

  /**
   * Activate a surface for focus/z-order. Only stacked contained modes participate
   * in the foreground stack (floating, maximized, minimized, windowed preview).
   */
  activate(id: SurfaceId): void {
    const surface = this.records().get(id);
    if (!surface || !surface.open) return;
    if (!this.isStackable(surface)) return;

    this.order.update((order) => {
      const without = order.filter((entry) => entry !== id);
      without.push(id);
      return without;
    });
  }

  /**
   * Z-index for a stacked surface. Non-stacked / unknown → null (host uses CSS).
   * Foreground is highest among registered stackable surfaces.
   */
  zIndex(id: SurfaceId): number | null {
    const surface = this.records().get(id);
    if (!surface || !this.isStackable(surface)) return null;

    const order = this.order().filter((entry) => {
      const candidate = this.records().get(entry);
      return candidate !== undefined && this.isStackable(candidate);
    });
    const index = order.indexOf(id);
    if (index < 0) return SURFACE_STACK_Z_BASE;
    return SURFACE_STACK_Z_BASE + index;
  }

  /** Update the measured workspace size used for clamping/projection. */
  setViewport(size: Size): void {
    const current = this.viewportSize();
    if (current.width === size.width && current.height === size.height) return;
    this.viewportSize.set({
      width: Math.max(0, Math.round(size.width)),
      height: Math.max(0, Math.round(size.height)),
    });
  }

  /** Open editor group count — for close last-group checks. */
  openEditorGroupCount(): number {
    let count = 0;
    for (const surface of this.records().values()) {
      if (surface.kind === 'editor' && surface.open) count += 1;
    }
    return count;
  }

  /** Layout preferences snapshot for Agent 06 persistence. */
  snapshot(): LayoutPreferences {
    return {
      version: LAYOUT_VERSION,
      surfaces: this.surfaces().map((surface) => ({ ...surface })),
      zOrder: [...this.order()],
      editorLayout: this.layoutTree(),
    };
  }

  /** Test/debug helper. */
  debugState(): SurfaceRegistrySnapshot {
    return {
      surfaces: this.surfaces(),
      zOrder: this.zOrder(),
      viewport: this.viewport(),
    };
  }

  private isStackable(surface: SurfaceRecord): boolean {
    if (!surface.open) return false;
    if (isNativePlacement(surface.placement)) return false;
    if (!isContainedPlacement(surface.placement)) return false;
    const mode = surface.placement.mode;
    return mode === 'floating' || mode === 'maximized' || mode === 'minimized';
  }
}
