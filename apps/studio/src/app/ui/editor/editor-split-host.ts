import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  PLATFORM_ID,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChildren,
} from '@angular/core';

import { clamp } from '@shadergrove/shared/geometry';
import {
  COMPACT_VIEWPORT_WIDTH,
  DEFAULT_EDITOR_GROUP_ID,
  DEFAULT_SPLIT_RATIO,
  SPLIT_RATIO_MAX,
  SPLIT_RATIO_MIN,
  editorSurfaceId,
  type EditorGroupId,
  type EditorLayoutNode,
  type SplitAxis,
  type SplitNodeId,
  type SurfaceId,
} from '@shadergrove/shared/surfaces';

import { I18n } from '../../i18n/i18n';
import { SurfaceRegistry } from '../../surfaces/surface-registry';
import { EditorGroups } from './editor-groups';
import { EditorPanel } from './editor-panel';

/** Smallest pixel size a group keeps along a split's axis while it is resized. */
export const MIN_EDITOR_GROUP_PX: Readonly<Record<SplitAxis, number>> = {
  horizontal: 220,
  vertical: 120,
};

/** Keyboard step for a focused splitter; Shift moves further. */
const RATIO_STEP = 0.05;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EditorLeafFrame extends Box {
  surfaceId: SurfaceId;
}

export interface EditorSplitFrame extends Box {
  id: SplitNodeId;
  axis: SplitAxis;
  ratio: number;
}

/**
 * Where each leaf and split of the tree sits, as fractions of the host. A live
 * ratio (a drag in progress) overrides the stored one for its split only.
 */
export function layoutEditorTree(
  node: EditorLayoutNode,
  live: { id: SplitNodeId; ratio: number } | null = null,
  box: Box = { x: 0, y: 0, width: 1, height: 1 },
  out: { leaves: EditorLeafFrame[]; splits: EditorSplitFrame[] } = { leaves: [], splits: [] },
): { leaves: EditorLeafFrame[]; splits: EditorSplitFrame[] } {
  if (node.kind === 'leaf') {
    out.leaves.push({ surfaceId: node.surfaceId, ...box });
    return out;
  }
  const ratio = live?.id === node.id ? live.ratio : node.ratio;
  out.splits.push({ id: node.id, axis: node.axis, ratio, ...box });
  const across = node.axis === 'horizontal';
  const first = across
    ? { ...box, width: box.width * ratio }
    : { ...box, height: box.height * ratio };
  const second = across
    ? { ...box, x: box.x + first.width, width: box.width - first.width }
    : { ...box, y: box.y + first.height, height: box.height - first.height };
  layoutEditorTree(node.first, live, first, out);
  layoutEditorTree(node.second, live, second, out);
  return out;
}

/**
 * The ratio a split may take: within the layout contract's fraction bounds and
 * leaving both children at least `minPx` along an axis `sizePx` long. A split
 * too small for both minimums sits at the middle.
 */
export function clampGroupRatio(ratio: number, sizePx: number, minPx: number): number {
  const floor = sizePx > 0 ? minPx / sizePx : 0;
  const low = Math.max(SPLIT_RATIO_MIN, floor);
  const high = Math.min(SPLIT_RATIO_MAX, 1 - floor);
  return low > high ? DEFAULT_SPLIT_RATIO : clamp(ratio, low, high);
}

/** Whether every split leaves both its sides their minimum pixel size; true until measured. */
export function splitsFit(
  splits: readonly EditorSplitFrame[],
  size: { width: number; height: number },
): boolean {
  if (size.width <= 0 || size.height <= 0) return true;
  return splits.every((split) => {
    const across = split.axis === 'horizontal';
    const length = across ? split.width * size.width : split.height * size.height;
    const min = MIN_EDITOR_GROUP_PX[split.axis];
    return length * split.ratio >= min && length * (1 - split.ratio) >= min;
  });
}

interface Drag {
  id: SplitNodeId;
  axis: SplitAxis;
  start: number;
  size: number;
}

/**
 * The contained split editor: one group-bound `EditorPanel` per leaf of the
 * workspace's split tree, with a splitter between each pair, inside the one
 * editor frame (`EditorShell`) the default editor surface places. With a lone
 * leaf it shows the single legacy, unbound panel. Panels are a flat list keyed
 * by surface, positioned from the tree, so splitting, closing and resizing
 * never rebuild a surviving group's Monaco editor. Below the compact
 * breakpoint, and while the frame is minimized, the groups stack in one column;
 * the stored tree and ratios are kept for when there is room again.
 */
@Component({
  selector: 'app-editor-split-host',
  imports: [EditorPanel],
  template: `
    @for (leaf of leaves(); track leaf.surfaceId; let first = $first) {
      <div
        class="leaf"
        [class.active]="split() && leaf.groupId === groups.activeGroupId()"
        [style.left.%]="stacked() ? null : leaf.x * 100"
        [style.top.%]="stacked() ? null : leaf.y * 100"
        [style.width.%]="stacked() ? null : leaf.width * 100"
        [style.height.%]="stacked() ? null : leaf.height * 100"
        [attr.role]="split() ? 'region' : null"
        [attr.aria-label]="split() ? groupLabel(leaf.groupId) : null"
        [attr.data-editor-group]="split() ? leaf.groupId : null"
        [attr.data-surface-id]="leaf.surfaceId"
        (focusin)="activate(leaf.groupId)"
        (pointerdown)="activate(leaf.groupId)"
      >
        <app-editor-panel
          [groupId]="split() ? leaf.groupId : groupId()"
          [surfaceId]="surfaceId()"
          [collapsed]="collapsed()"
          [dragEnabled]="dragEnabled()"
          [explorer]="first"
          (dragStart)="dragStart.emit($event)"
        />
      </div>
    }

    @if (split() && !stacked()) {
      @for (bar of splits(); track bar.id) {
        <div
          class="splitter"
          role="separator"
          tabindex="0"
          [class.across]="bar.axis === 'horizontal'"
          [class.dragging]="drag?.id === bar.id"
          [style.left.%]="(bar.axis === 'horizontal' ? bar.x + bar.width * bar.ratio : bar.x) * 100"
          [style.top.%]="(bar.axis === 'horizontal' ? bar.y : bar.y + bar.height * bar.ratio) * 100"
          [style.width.%]="bar.axis === 'horizontal' ? null : bar.width * 100"
          [style.height.%]="bar.axis === 'horizontal' ? bar.height * 100 : null"
          [attr.aria-orientation]="bar.axis === 'horizontal' ? 'vertical' : 'horizontal'"
          [attr.aria-label]="splitterLabel(bar.axis)"
          [attr.aria-valuenow]="percent(bar.ratio)"
          [attr.aria-valuemin]="percent(minRatio)"
          [attr.aria-valuemax]="percent(maxRatio)"
          [attr.data-split-id]="bar.id"
          (pointerdown)="startDrag($event, bar)"
          (pointermove)="moveDrag($event)"
          (pointerup)="endDrag($event, true)"
          (pointercancel)="endDrag($event, false)"
          (keydown)="onSplitterKey($event, bar)"
        ></div>
      }
    }
  `,
  styles: `
    :host {
      position: relative;
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-width: 0;
      min-height: 0;
    }

    :host(.split:not(.stacked)) {
      overflow: hidden;
    }

    .leaf {
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
    }

    .leaf > app-editor-panel {
      flex: 1 1 auto;
      min-height: 0;
    }

    :host(.split:not(.stacked)) .leaf {
      position: absolute;
      overflow: hidden;
      box-shadow: inset 0 0 0 1px var(--mat-sys-outline-variant);
    }

    :host(.stacked) .leaf {
      position: relative;
      flex: 1 1 0;
    }

    :host(.stacked.collapsed) .leaf {
      flex: 0 0 auto;
    }

    // Compact: every group keeps a usable height and the column scrolls.
    :host(.stacked.split:not(.collapsed)) {
      overflow-y: auto;
    }

    :host(.stacked.split:not(.collapsed)) .leaf {
      flex: 1 0 auto;
      min-height: 160px;
    }

    :host(.stacked.split) .leaf + .leaf {
      border-top: 1px solid var(--mat-sys-outline-variant);
    }

    .leaf.active {
      box-shadow: inset 0 2px 0 var(--mat-sys-primary);
    }

    .splitter {
      position: absolute;
      z-index: 2;
      touch-action: none;
      background: transparent;
    }

    .splitter.across {
      width: 8px;
      margin-left: -4px;
      cursor: ew-resize;
    }

    .splitter:not(.across) {
      height: 8px;
      margin-top: -4px;
      cursor: ns-resize;
    }

    .splitter:hover,
    .splitter.dragging,
    .splitter:focus-visible {
      background: color-mix(in srgb, var(--mat-sys-primary) 30%, transparent);
    }

    .splitter:focus-visible {
      outline: 2px solid var(--mat-sys-primary);
      outline-offset: -2px;
    }
  `,
  host: {
    '[class.split]': 'split()',
    '[class.stacked]': 'stacked()',
    '[class.collapsed]': 'collapsed()',
  },
})
export class EditorSplitHost {
  protected readonly groups = inject(EditorGroups);
  private readonly registry = inject(SurfaceRegistry);
  private readonly i18n = inject(I18n);
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly panels = viewChildren(EditorPanel);

  /** The lone group the frame shows when the shell is bound to one; null is the legacy editor. */
  readonly groupId = input<EditorGroupId | null>(null);
  /** The editor frame's surface, which every panel's window controls act on. */
  readonly surfaceId = input<SurfaceId>(editorSurfaceId(DEFAULT_EDITOR_GROUP_ID));
  readonly collapsed = input(false);
  readonly dragEnabled = input(false);
  readonly dragStart = output<PointerEvent>();

  protected readonly minRatio = SPLIT_RATIO_MIN;
  protected readonly maxRatio = SPLIT_RATIO_MAX;

  private readonly liveRatio = signal<{ id: SplitNodeId; ratio: number } | null>(null);
  protected drag: Drag | null = null;

  /** Group ids are bound only here, where every shown group is rendered. */
  protected readonly split = computed(
    () => this.groupId() === null && this.groups.visibleGroupIds().length > 1,
  );

  /** Measured host size; zero until the browser has laid it out. */
  private readonly size = signal({ width: 0, height: 0 });

  /**
   * One column on a compact workspace, in a minimized frame, or whenever the
   * frame is too small to give every group its minimum size side by side.
   */
  protected readonly stacked = computed(() => {
    if (!this.split() || this.collapsed()) return true;
    const { width } = this.registry.viewport();
    if (width > 0 && width < COMPACT_VIEWPORT_WIDTH) return true;
    return !splitsFit(this.frames().splits, this.size());
  });

  private readonly frames = computed(() =>
    layoutEditorTree(this.registry.editorLayout(), this.liveRatio()),
  );

  protected readonly leaves = computed(() => {
    if (!this.split()) {
      const surfaceId = editorSurfaceId(this.groupId() ?? DEFAULT_EDITOR_GROUP_ID);
      return [{ surfaceId, groupId: DEFAULT_EDITOR_GROUP_ID, x: 0, y: 0, width: 1, height: 1 }];
    }
    return this.frames().leaves.flatMap((frame) => {
      const groupId = this.groups.groupForSurface(frame.surfaceId);
      return groupId ? [{ ...frame, groupId }] : [];
    });
  });

  protected readonly splits = computed(() => this.frames().splits);

  constructor() {
    afterNextRender(() => {
      if (typeof ResizeObserver === 'undefined') return;
      const element = this.host.nativeElement as HTMLElement;
      const observer = new ResizeObserver(() => {
        const { width, height } = element.getBoundingClientRect();
        this.size.set({ width, height });
      });
      observer.observe(element);
      this.destroyRef.onDestroy(() => observer.disconnect());
    });

    // A new group takes focus once its panel and editor are on screen.
    effect(() => {
      const groupId = this.groups.pendingFocus();
      if (!groupId || !this.isBrowser) return;
      untracked(() => {
        this.groups.clearFocusRequest();
        this.focusWhenReady(groupId, 60);
      });
    });
  }

  relayout(): void {
    for (const panel of this.panels()) panel.relayout();
  }

  /** Focus the active group's editor (the lone one when there is no split). */
  focusEditor(): void {
    const active = this.groups.activeGroupId();
    const panels = this.panels();
    (panels.find((panel) => panel.groupId() === active) ?? panels[0])?.focusEditor();
  }

  protected activate(groupId: EditorGroupId): void {
    if (this.split() && this.groups.activeGroupId() !== groupId) {
      this.groups.activateGroup(groupId);
    }
  }

  protected groupLabel(groupId: EditorGroupId): string {
    return this.i18n.t('editor.groupLabel', { n: this.groups.groupNumber(groupId) });
  }

  protected splitterLabel(axis: SplitAxis): string {
    return this.i18n.t(
      axis === 'horizontal' ? 'editor.resizeGroupsAcross' : 'editor.resizeGroupsDown',
    );
  }

  protected percent(ratio: number): number {
    return Math.round(ratio * 100);
  }

  protected startDrag(event: PointerEvent, bar: EditorSplitFrame): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const rect = (this.host.nativeElement as HTMLElement).getBoundingClientRect();
    const across = bar.axis === 'horizontal';
    this.drag = {
      id: bar.id,
      axis: bar.axis,
      start: across ? rect.left + bar.x * rect.width : rect.top + bar.y * rect.height,
      size: across ? bar.width * rect.width : bar.height * rect.height,
    };
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    this.liveRatio.set({ id: bar.id, ratio: bar.ratio });
  }

  /** Preview only: the tree, and so the preferences, change on release. */
  protected moveDrag(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || drag.size <= 0) return;
    const position = drag.axis === 'horizontal' ? event.clientX : event.clientY;
    const ratio = clampGroupRatio(
      (position - drag.start) / drag.size,
      drag.size,
      MIN_EDITOR_GROUP_PX[drag.axis],
    );
    this.liveRatio.set({ id: drag.id, ratio });
  }

  protected endDrag(event: PointerEvent, commit: boolean): void {
    const drag = this.drag;
    if (!drag) return;
    if (commit) this.moveDrag(event);
    const live = this.liveRatio();
    this.drag = null;
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    if (commit && live) this.groups.commitRatio(live.id, live.ratio);
    this.liveRatio.set(null);
    this.scheduleRelayout();
  }

  protected onSplitterKey(event: KeyboardEvent, bar: EditorSplitFrame): void {
    const across = bar.axis === 'horizontal';
    const step = event.shiftKey ? RATIO_STEP * 2 : RATIO_STEP;
    const rect = (this.host.nativeElement as HTMLElement).getBoundingClientRect();
    const size = across ? bar.width * rect.width : bar.height * rect.height;
    const min = MIN_EDITOR_GROUP_PX[bar.axis];
    const keys: Record<string, number> = across
      ? { ArrowLeft: bar.ratio - step, ArrowRight: bar.ratio + step }
      : { ArrowUp: bar.ratio - step, ArrowDown: bar.ratio + step };
    keys['Home'] = 0;
    keys['End'] = 1;
    const next = keys[event.key];
    if (next === undefined) return;
    event.preventDefault();
    this.groups.commitRatio(bar.id, clampGroupRatio(next, size, min));
    this.scheduleRelayout();
  }

  private scheduleRelayout(): void {
    if (!this.isBrowser) return;
    requestAnimationFrame(() => this.relayout());
  }

  /** Monaco boots asynchronously in a new panel, so try each frame until focus lands. */
  private focusWhenReady(groupId: EditorGroupId, frames: number): void {
    requestAnimationFrame(() => {
      const leaf = (this.host.nativeElement as HTMLElement).querySelector(
        `[data-editor-group="${groupId}"]`,
      );
      if (!leaf || leaf.contains(this.document.activeElement)) return;
      this.panels()
        .find((panel) => panel.groupId() === groupId)
        ?.focusEditor();
      if (frames > 1 && !leaf.contains(this.document.activeElement)) {
        this.focusWhenReady(groupId, frames - 1);
      }
    });
  }
}
