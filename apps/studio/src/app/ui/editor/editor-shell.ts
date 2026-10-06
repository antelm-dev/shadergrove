import { isPlatformBrowser } from '@angular/common';
import {
  Component,
  DestroyRef,
  ElementRef,
  PLATFORM_ID,
  afterNextRender,
  computed,
  effect,
  inject,
  untracked,
  viewChild,
} from '@angular/core';

import { EDITOR_LIMITS } from '@shadergrove/shared/editor-prefs';
import { isContainedPlacement, placementFromRestorePoint } from '@shadergrove/shared/surfaces';
import type { ResizeEdge } from '@shadergrove/shared/geometry';
import { EditorPanel } from './editor-panel';
import { ReducedMotion } from '../../prefs/reduced-motion';
import {
  SurfaceGeometryGesture,
  SurfaceLayoutService,
  SurfaceRegistry,
  SurfaceResizeHandles,
  keyboardResizeDocked,
  keyboardResizeFloating,
  projectSurfaceFrame,
} from '../../surfaces';

@Component({
  selector: 'app-editor-shell',
  imports: [EditorPanel, SurfaceResizeHandles],
  template: `
    @if (projected().resizableDocked && projected().dockSide; as side) {
      <surface-resize-handles
        mode="docked"
        [dockSide]="side"
        [dockValue]="projected().dockSize ?? 0"
        [dockMin]="dockLimits().min"
        [dockMax]="dockLimits().max"
        [dockLabel]="dockResizeLabel()"
        [label]="resizeLabel"
        (pointerDown)="onDockResizePointer($event)"
        (keyDown)="onDockResizeKey($event)"
      />
    }

    <app-editor-panel
      #panel
      [collapsed]="mode() === 'minimized'"
      [dragEnabled]="mode() === 'floating'"
      (dragStart)="onDrag($event)"
    />

    @if (projected().resizableFloating) {
      <surface-resize-handles
        mode="floating"
        [label]="resizeLabel"
        (pointerDown)="onFloatingResizePointer($event)"
        (keyDown)="onFloatingResizeKey($event)"
      />
    }
  `,
  styles: `
    :host {
      position: relative;
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow: visible;
      pointer-events: auto;
      border: 1px solid var(--mat-sys-outline-variant);
      background: var(--mat-sys-surface-container-lowest);
    }

    :host(.surface-frame--animating) {
      transition:
        height 180ms ease,
        width 180ms ease,
        inset 180ms ease;
    }

    @media (prefers-reduced-motion: reduce) {
      :host(.surface-frame--animating) {
        transition: none;
      }
    }

    :host(.docked),
    :host(.minimized) {
      grid-area: editor;
    }

    :host(.docked.dock-bottom),
    :host(.minimized.dock-bottom) {
      border-width: 1px 0 0;
    }

    :host(.docked.dock-left),
    :host(.minimized.dock-left) {
      border-width: 0 1px 0 0;
      align-self: stretch;
      min-width: 0;
    }

    :host(.docked.dock-right),
    :host(.minimized.dock-right) {
      border-width: 0 0 0 1px;
      align-self: stretch;
      min-width: 0;
    }

    :host(.minimized.dock-left),
    :host(.minimized.dock-right) {
      align-self: start;
    }

    :host(.maximized) {
      position: absolute;
      inset: 0;
      border-width: 1px 0 0;
    }

    // Floating over the shader: nearly opaque still, because code has to stay
    // legible over any frame, with the blur softening what shows through.
    :host(.floating) {
      position: absolute;
      overflow: hidden;
      border-radius: var(--mat-sys-corner-large);
      background: color-mix(in srgb, var(--mat-sys-surface-container-lowest) 94%, transparent);
      backdrop-filter: var(--studio-glass-filter);
      box-shadow: var(--mat-sys-level4);
    }

    :host(.minimized) {
      height: auto;
    }

    app-resize-handles,
    surface-resize-handles {
      --resize-handle-top-offset: -3px;
    }
  `,
  host: {
    '[class.docked]': 'mode() === "docked"',
    '[class.floating]': 'mode() === "floating"',
    '[class.maximized]': 'mode() === "maximized"',
    '[class.minimized]': 'mode() === "minimized"',
    '[class.dock-bottom]': 'dockSide() === "bottom"',
    '[class.dock-left]': 'dockSide() === "left"',
    '[class.dock-right]': 'dockSide() === "right"',
    '[class.surface-frame--dragging]': 'gesture.dragging()',
    '[class.surface-frame--animating]': 'frameAnimating()',
    '[style.height.px]': 'hostHeight()',
    '[style.width.px]': 'hostWidth()',
    '[style.left.px]': 'hostRect()?.x',
    '[style.top.px]': 'hostRect()?.y',
    '[style.z-index]': 'windowZIndex()',
    '(pointerdown)': 'activate()',
    '(focusin)': 'activate()',
    role: 'region',
    'aria-label': 'Source editor',
  },
})
export class EditorShell {
  protected readonly layout = inject(SurfaceLayoutService);
  protected readonly registry = inject(SurfaceRegistry);
  protected readonly limits = EDITOR_LIMITS;

  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly destroyRef = inject(DestroyRef);
  private readonly reducedMotion = inject(ReducedMotion);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  private readonly panel = viewChild.required(EditorPanel);

  protected readonly editorId = this.layout.editorId;
  protected readonly gesture = new SurfaceGeometryGesture();

  private readonly surface = computed(() => this.layout.editor());

  protected readonly projected = computed(() =>
    projectSurfaceFrame(this.surface(), this.registry.viewport(), {
      liveRect: this.gesture.liveRect(),
      liveDockSize: this.gesture.liveDockSize(),
    }),
  );

  protected readonly mode = computed(() => {
    const projected = this.projected();
    if (projected.mode === 'closed' || projected.mode === 'native') return 'docked' as const;
    if (projected.mode === 'stage') return 'docked' as const;
    return projected.mode;
  });

  // Minimized chrome remains in the dock it occupied before collapsing.
  private readonly minimizedDock = computed(() => {
    const surface = this.surface();
    const placement = surface.placement;
    if (!isContainedPlacement(placement) || placement.mode !== 'minimized') return null;
    if (placement.restore.mode !== 'docked') return null;
    return projectSurfaceFrame(
      { ...surface, placement: placementFromRestorePoint(placement.restore) },
      this.registry.viewport(),
    );
  });

  protected readonly dockSide = computed(
    () => this.projected().dockSide ?? this.minimizedDock()?.dockSide ?? 'bottom',
  );

  protected readonly windowZIndex = computed(() =>
    this.projected().stacked ? this.layout.zIndex(this.editorId) : null,
  );

  protected readonly hostRect = computed(() =>
    this.mode() === 'floating' ? this.projected().frame : null,
  );

  protected readonly hostHeight = computed<number | null>(() => {
    const mode = this.mode();
    if (mode === 'floating') return this.projected().frame?.height ?? null;
    if (mode === 'docked' && this.dockSide() === 'bottom') return this.projected().dockSize;
    return null;
  });

  protected readonly hostWidth = computed<number | null>(() => {
    const mode = this.mode();
    if (mode === 'floating') return this.projected().frame?.width ?? null;
    if ((mode === 'docked' || mode === 'minimized') && this.dockSide() !== 'bottom') {
      return this.projected().dockSize ?? this.minimizedDock()?.dockSize ?? null;
    }
    return null;
  });

  protected readonly dockLimits = computed(() =>
    this.dockSide() === 'bottom' ? this.limits.dockedHeight : this.limits.dockedWidth,
  );

  protected readonly frameAnimating = computed(
    () => !this.gesture.dragging() && !this.reducedMotion.enabled(),
  );

  constructor() {
    afterNextRender(() => {
      this.observeWorkspace();
    });

    effect(() => {
      this.mode();
      this.dockSide();
      this.hostHeight();
      this.hostWidth();
      this.hostRect();
      untracked(() => this.scheduleRelayout());
    });
  }

  private observeWorkspace(): void {
    const workspace = this.host.nativeElement.parentElement;
    if (!this.isBrowser || !workspace) return;

    const observer = new ResizeObserver(() => this.measure());
    observer.observe(workspace);
    this.destroyRef.onDestroy(() => observer.disconnect());
    this.measure();
  }

  private measure(): void {
    const workspace = this.host.nativeElement.parentElement;
    if (!workspace) return;
    const { width, height } = workspace.getBoundingClientRect();
    this.registry.setViewport({ width, height });
  }

  private scheduleRelayout(): void {
    if (!this.isBrowser) return;
    requestAnimationFrame(() => this.panel().relayout());
  }

  protected onDrag(event: PointerEvent): void {
    const placement = this.surface().placement;
    if (!isContainedPlacement(placement) || placement.mode !== 'floating') return;

    this.gesture.begin(
      event,
      event.currentTarget as HTMLElement,
      {
        gesture: 'move-floating',
        surfaceKind: 'editor',
        viewport: this.registry.viewport(),
        rect: placement.rect,
      },
      (commit) => {
        if (commit.rect) {
          this.layout.commitFloatingRect(this.editorId, commit.rect);
          this.scheduleRelayout();
        }
      },
    );
  }

  protected onFloatingResizePointer(payload: { event: PointerEvent; edge: ResizeEdge }): void {
    const placement = this.surface().placement;
    if (!isContainedPlacement(placement) || placement.mode !== 'floating') return;

    this.gesture.begin(
      payload.event,
      payload.event.currentTarget as HTMLElement,
      {
        gesture: 'resize-floating',
        surfaceKind: 'editor',
        viewport: this.registry.viewport(),
        rect: placement.rect,
        edge: payload.edge,
      },
      (commit) => {
        if (commit.rect) {
          this.layout.commitFloatingRect(this.editorId, commit.rect);
          this.scheduleRelayout();
        }
      },
    );
  }

  protected onDockResizePointer(payload: { event: PointerEvent; edge: ResizeEdge }): void {
    const side = this.dockSide();
    const size = this.projected().dockSize ?? 0;
    this.gesture.begin(
      payload.event,
      payload.event.currentTarget as HTMLElement,
      {
        gesture: 'resize-docked',
        surfaceKind: 'editor',
        viewport: this.registry.viewport(),
        dockSize: size,
        dockSide: side,
        edge: payload.edge,
      },
      (commit) => {
        if (commit.dockSize !== undefined) {
          this.layout.commitDockSize(this.editorId, commit.dockSize);
          this.scheduleRelayout();
        }
      },
    );
  }

  protected onFloatingResizeKey(payload: { event: KeyboardEvent; edge: ResizeEdge }): void {
    const placement = this.surface().placement;
    if (!isContainedPlacement(placement) || placement.mode !== 'floating') return;

    const next = keyboardResizeFloating(
      'editor',
      placement.rect,
      payload.edge,
      payload.event,
      this.registry.viewport(),
    );
    if (!next) return;
    payload.event.preventDefault();
    this.layout.commitFloatingRect(this.editorId, next);
    this.scheduleRelayout();
  }

  protected onDockResizeKey(payload: { event: KeyboardEvent; edge: ResizeEdge }): void {
    const side = this.dockSide();
    const size = this.projected().dockSize ?? 0;
    const next = keyboardResizeDocked(
      'editor',
      side,
      size,
      payload.event,
      this.registry.viewport(),
    );
    if (next === null) return;
    payload.event.preventDefault();
    this.layout.commitDockSize(this.editorId, next);
    this.scheduleRelayout();
  }

  protected activate(): void {
    if (this.projected().stacked) this.layout.activate(this.editorId);
  }

  protected dockResizeLabel(): string {
    const side = this.dockSide();
    const keys = side === 'bottom' ? 'up and down arrow keys' : 'left and right arrow keys';
    return `Resize the editor panel. Use the ${keys}.`;
  }

  protected resizeLabel(edge: ResizeEdge): string {
    const names: Record<ResizeEdge, string> = {
      n: 'top edge',
      s: 'bottom edge',
      e: 'right edge',
      w: 'left edge',
      ne: 'top-right corner',
      nw: 'top-left corner',
      se: 'bottom-right corner',
      sw: 'bottom-left corner',
    };
    return `Resize the editor window from its ${names[edge]}. Use the arrow keys.`;
  }

  focusEditor(): void {
    this.panel().focusEditor();
  }
}
