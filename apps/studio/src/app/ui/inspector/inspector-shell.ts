import { isPlatformBrowser } from '@angular/common';
import {
  Component,
  DestroyRef,
  ElementRef,
  PLATFORM_ID,
  afterNextRender,
  computed,
  inject,
} from '@angular/core';

import { PANEL_LIMITS } from '@shadergrove/shared/panel-prefs';
import { isContainedPlacement } from '@shadergrove/shared/surfaces';
import type { ResizeEdge } from '@shadergrove/shared/geometry';
import { InspectorPanel } from './inspector-panel';
import { InspectorWindowControls } from './inspector-window-controls';
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

/**
 * The inspector's frame: docked to the right by default, contained-floating
 * once the user detaches it — the same "never tear it down" contract the
 * editor shell keeps with `EditorPanel`. `InspectorPanel` is instantiated once
 * here and stays mounted across every placement change, so lil-gui's build,
 * scroll position and open folders all survive a float/dock/minimize/restore.
 */
@Component({
  selector: 'app-inspector-shell',
  imports: [InspectorPanel, InspectorWindowControls, SurfaceResizeHandles],
  template: `
    @if (projected().resizableDocked && projected().dockSide; as side) {
      <surface-resize-handles
        mode="docked"
        [dockSide]="side"
        [dockValue]="projected().dockSize ?? 0"
        [dockMin]="dockLimits.min"
        [dockMax]="dockLimits.max"
        [dockLabel]="dockResizeLabel()"
        [label]="resizeLabel"
        (pointerDown)="onDockResizePointer($event)"
        (keyDown)="onDockResizeKey($event)"
      />
    }

    <app-inspector-panel
      [collapsed]="mode() === 'minimized'"
      [dragEnabled]="mode() === 'floating'"
      (dragStart)="onDrag($event)"
    >
      <app-inspector-window-controls inspectorWindowControls />
    </app-inspector-panel>

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
      overflow: hidden;
      pointer-events: auto;
      background: var(--mat-sys-surface-container-low);
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

    // Docked: one of the workspace's walls, flush with the window edge and
    // parted from the stage by a hairline rather than lifted off it.
    :host(.docked),
    :host(.minimized) {
      grid-area: inspector;
      align-self: stretch;
      min-width: 0;
      border-left: 1px solid var(--mat-sys-outline-variant);
    }

    :host(.minimized) {
      align-self: start;
      height: auto;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }

    :host(.maximized) {
      position: absolute;
      inset: 0;
    }

    // Floating: a window over the shader, so glass, with a lift.
    :host(.floating) {
      position: absolute;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: var(--mat-sys-corner-large);
      background: var(--studio-glass);
      backdrop-filter: var(--studio-glass-filter);
      box-shadow: var(--mat-sys-level4);
    }
  `,
  host: {
    '[class.docked]': 'mode() === "docked"',
    '[class.floating]': 'mode() === "floating"',
    '[class.maximized]': 'mode() === "maximized"',
    '[class.minimized]': 'mode() === "minimized"',
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
    'aria-label': 'Inspector',
  },
})
export class InspectorShell {
  protected readonly layout = inject(SurfaceLayoutService);
  protected readonly registry = inject(SurfaceRegistry);
  protected readonly dockLimits = PANEL_LIMITS.inspectorWidth;

  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly destroyRef = inject(DestroyRef);
  private readonly reducedMotion = inject(ReducedMotion);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  protected readonly inspectorId = this.layout.inspectorId;
  protected readonly gesture = new SurfaceGeometryGesture();

  private readonly surface = computed(() => this.layout.inspector());

  protected readonly projected = computed(() =>
    projectSurfaceFrame(this.surface(), this.registry.viewport(), {
      liveRect: this.gesture.liveRect(),
      liveDockSize: this.gesture.liveDockSize(),
    }),
  );

  protected readonly mode = computed(() => {
    const projected = this.projected();
    if (projected.mode === 'closed' || projected.mode === 'native' || projected.mode === 'stage') {
      return 'docked' as const;
    }
    return projected.mode;
  });

  protected readonly windowZIndex = computed(() =>
    this.projected().stacked ? this.layout.zIndex(this.inspectorId) : null,
  );

  protected readonly hostRect = computed(() =>
    this.mode() === 'floating' ? this.projected().frame : null,
  );

  protected readonly hostHeight = computed<number | null>(() =>
    this.mode() === 'floating' ? (this.projected().frame?.height ?? null) : null,
  );

  protected readonly hostWidth = computed<number | null>(() => {
    const mode = this.mode();
    if (mode === 'floating') return this.projected().frame?.width ?? null;
    if (mode === 'docked' || mode === 'minimized') return this.projected().dockSize;
    return null;
  });

  protected readonly frameAnimating = computed(
    () => !this.gesture.dragging() && !this.reducedMotion.enabled(),
  );

  constructor() {
    afterNextRender(() => {
      this.observeWorkspace();
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

  protected onDrag(event: PointerEvent): void {
    const placement = this.surface().placement;
    if (!isContainedPlacement(placement) || placement.mode !== 'floating') return;

    this.gesture.begin(
      event,
      event.currentTarget as HTMLElement,
      {
        gesture: 'move-floating',
        surfaceKind: 'inspector',
        viewport: this.registry.viewport(),
        rect: placement.rect,
      },
      (commit) => {
        if (commit.rect) this.layout.commitFloatingRect(this.inspectorId, commit.rect);
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
        surfaceKind: 'inspector',
        viewport: this.registry.viewport(),
        rect: placement.rect,
        edge: payload.edge,
      },
      (commit) => {
        if (commit.rect) this.layout.commitFloatingRect(this.inspectorId, commit.rect);
      },
    );
  }

  protected onDockResizePointer(payload: { event: PointerEvent; edge: ResizeEdge }): void {
    const size = this.projected().dockSize ?? 0;
    this.gesture.begin(
      payload.event,
      payload.event.currentTarget as HTMLElement,
      {
        gesture: 'resize-docked',
        surfaceKind: 'inspector',
        viewport: this.registry.viewport(),
        dockSize: size,
        dockSide: 'right',
        edge: payload.edge,
      },
      (commit) => {
        if (commit.dockSize !== undefined) {
          this.layout.commitDockSize(this.inspectorId, commit.dockSize);
        }
      },
    );
  }

  protected onFloatingResizeKey(payload: { event: KeyboardEvent; edge: ResizeEdge }): void {
    const placement = this.surface().placement;
    if (!isContainedPlacement(placement) || placement.mode !== 'floating') return;

    const next = keyboardResizeFloating(
      'inspector',
      placement.rect,
      payload.edge,
      payload.event,
      this.registry.viewport(),
    );
    if (!next) return;
    payload.event.preventDefault();
    this.layout.commitFloatingRect(this.inspectorId, next);
  }

  protected onDockResizeKey(payload: { event: KeyboardEvent; edge: ResizeEdge }): void {
    const size = this.projected().dockSize ?? 0;
    const next = keyboardResizeDocked(
      'inspector',
      'right',
      size,
      payload.event,
      this.registry.viewport(),
    );
    if (next === null) return;
    payload.event.preventDefault();
    this.layout.commitDockSize(this.inspectorId, next);
  }

  protected activate(): void {
    if (this.projected().stacked) this.layout.activate(this.inspectorId);
  }

  protected dockResizeLabel(): string {
    return 'Resize the inspector panel. Use the left and right arrow keys.';
  }

  protected readonly resizeLabel = (edge: ResizeEdge): string => {
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
    return `Resize the inspector window from its ${names[edge]}. Use the arrow keys.`;
  };
}
