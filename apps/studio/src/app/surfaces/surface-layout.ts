/**
 * Bridges Preferences, SurfaceRegistry, and SurfaceController for Agent 06.
 *
 * Hydrates the registry from legacy or versioned layout prefs; persists
 * `surfacesLayout` after successful commands and gesture commits — never on
 * pointermove.
 *
 * SSR-safe: hydration runs in the browser only.
 */

import {
  DestroyRef,
  Injectable,
  PLATFORM_ID,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

import type { InspectorTab } from '@shadergrove/shared/panel-prefs';
import type { Point, Rect } from '@shadergrove/shared/geometry';
import {
  DEFAULT_EDITOR_GROUP_ID,
  NATIVE_SURFACE_PATHS,
  WELL_KNOWN_SURFACE_IDS,
  asSurfaceId,
  createDefaultSurface,
  editorSurfaceId,
  isContainedPlacement,
  isNativePlacement,
  migrateLayoutFromPreferences,
  type DockSide,
  type SurfaceId,
  type SurfaceKind,
  type SurfaceRecord,
} from '@shadergrove/shared/surfaces';

import { DesktopPlatform } from '../desktop/desktop-platform';
import { isOutputWindow, isSatelliteWindow, type SatelliteKind } from '../output-mode';
import { Preferences } from '../prefs/preferences';
import {
  SurfaceController,
  type SurfaceCommandResult,
  type SurfaceControllerOptions,
} from './surface-controller';
import { SurfaceRegistry } from './surface-registry';
import type { SurfaceCommandContext } from './surface-commands';

export const PREVIEW_SURFACE_ID = WELL_KNOWN_SURFACE_IDS.preview;
export const DEFAULT_EDITOR_SURFACE_ID = editorSurfaceId(DEFAULT_EDITOR_GROUP_ID);
export const INSPECTOR_SURFACE_ID = WELL_KNOWN_SURFACE_IDS.inspector;
export const BOTTOM_PANEL_SURFACE_ID = WELL_KNOWN_SURFACE_IDS.bottomPanel;

/** The panels the desktop can move into a native window of their own, and that window's kind. */
const NATIVE_PANELS: ReadonlyMap<SurfaceId, SatelliteKind> = new Map([
  [BOTTOM_PANEL_SURFACE_ID, 'bottom-panel'],
  [INSPECTOR_SURFACE_ID, 'inspector'],
  [DEFAULT_EDITOR_SURFACE_ID, 'editor'],
]);

@Injectable({ providedIn: 'root' })
export class SurfaceLayoutService {
  private readonly preferences = inject(Preferences);
  private readonly registry = inject(SurfaceRegistry);
  private readonly controller = inject(SurfaceController);
  private readonly desktop = inject(DesktopPlatform);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly destroyRef = inject(DestroyRef);

  /**
   * Only the desktop's main window owns native panel windows: never the web, the
   * live output window (which shares this service and its saved layout) or a
   * panel window itself.
   */
  private readonly managesWindows =
    this.isBrowser && this.desktop.available && !isOutputWindow() && !isSatelliteWindow();
  /** Native panel windows known to be open. */
  private readonly windows = signal<ReadonlySet<SurfaceId>>(new Set());
  private readonly opening = new Map<SurfaceId, Promise<boolean>>();
  private readonly closing = new Set<SurfaceId>();

  /** Preview stage rect in client coordinates (origin + size). */
  private readonly previewWorkspaceRect = signal<Rect>({ x: 0, y: 0, width: 0, height: 0 });

  readonly previewId = PREVIEW_SURFACE_ID;
  readonly editorId = DEFAULT_EDITOR_SURFACE_ID;
  readonly inspectorId = INSPECTOR_SURFACE_ID;
  readonly bottomPanelId = BOTTOM_PANEL_SURFACE_ID;

  readonly previewWorkspace = this.previewWorkspaceRect.asReadonly();

  readonly preview = computed(() => this.surfaceRecord(this.previewId, 'preview'));
  readonly editor = computed(() => this.surfaceRecord(this.editorId, 'editor'));
  readonly inspector = computed(() => this.surfaceRecord(this.inspectorId, 'inspector'));
  readonly bottomPanel = computed(() => this.surfaceRecord(this.bottomPanelId, 'bottom-panel'));

  /** A native window shows the bottom panel (or will, once shown): the workspace renders no copy. */
  readonly bottomPanelNative = computed(() => isNativePlacement(this.bottomPanel().placement));
  readonly inspectorNative = computed(() => isNativePlacement(this.inspector().placement));
  readonly editorNative = computed(() => isNativePlacement(this.editor().placement));
  /** Whether any panel lives in a native window of its own. */
  readonly anyNative = computed(() => [...NATIVE_PANELS.keys()].some((id) => this.isNative(id)));

  readonly editorOpen = computed(() => this.editor().open);
  readonly inspectorOpen = computed(() => this.inspector().open);

  /** Durable tab source — `chrome.tab`, never a second competing preference. */
  readonly inspectorTab = computed<InspectorTab>(() => {
    const chrome = this.inspector().chrome;
    return chrome.kind === 'inspector' ? chrome.tab : 'controls';
  });

  readonly editorDockSide = computed<DockSide>(() => {
    const placement = this.editor().placement;
    if (!isContainedPlacement(placement)) return 'bottom';
    if (placement.mode === 'docked') return placement.side;
    if (placement.mode === 'maximized' || placement.mode === 'minimized') {
      const restore = placement.restore;
      if (restore.mode === 'docked') return restore.side;
    }
    return this.readLegacyEditorDockSide();
  });

  constructor() {
    if (this.isBrowser) {
      this.hydrateFromPreferences();
      // The split tree changes only on committed edits (split, close, resize
      // release), never on pointermove, so each new tree is persisted as is.
      let persisted = this.registry.editorLayout();
      effect(() => {
        const tree = this.registry.editorLayout();
        if (tree === persisted) return;
        persisted = tree;
        untracked(() => this.persistLayout());
      });
      if (this.managesWindows) this.followNativeWindows();
    }
  }

  /** Register stable preview and primary-editor instances if missing. */
  hydrateFromPreferences(): void {
    const prefs = this.preferences.value();
    const layout =
      prefs.surfacesLayout ??
      migrateLayoutFromPreferences(prefs, {
        viewport: {
          width: this.previewWorkspaceRect().width,
          height: this.previewWorkspaceRect().height,
        },
      });
    this.registry.hydrate(layout);
    this.registry.ensure('preview');
    this.registry.ensure('editor', {
      id: this.editorId,
      chrome: { kind: 'editor', editorGroupId: DEFAULT_EDITOR_GROUP_ID },
    });
    this.registry.ensure('inspector');
    this.registry.ensure('bottom-panel');
    // Without Electron there is no window to put a detached panel in: show it contained.
    if (!this.desktop.available) {
      for (const id of NATIVE_PANELS.keys()) {
        if (this.isNative(id)) this.controller.returnToWorkspace(id);
      }
    }
    this.registry.repairEditorLayout();
  }

  setPreviewWorkspace(rect: Rect): void {
    const current = this.previewWorkspaceRect();
    if (
      current.x === rect.x &&
      current.y === rect.y &&
      current.width === rect.width &&
      current.height === rect.height
    ) {
      return;
    }
    this.previewWorkspaceRect.set(rect);
  }

  commandContext(extra: Partial<SurfaceCommandContext> = {}): SurfaceCommandContext {
    return {
      allowNative: this.desktop.available,
      remainingEditorGroups: Math.max(0, this.registry.openEditorGroupCount() - 1),
      ...extra,
    };
  }

  persistLayout(): void {
    const layout = this.registry.snapshot();
    const editor = layout.surfaces.find((surface) => surface.id === this.editorId);
    const inspector = layout.surfaces.find((surface) => surface.id === this.inspectorId);
    const inspectorTab = inspector?.chrome.kind === 'inspector' ? inspector.chrome.tab : undefined;
    const inspectorDockSize =
      inspector &&
      isContainedPlacement(inspector.placement) &&
      inspector.placement.mode === 'docked'
        ? inspector.placement.size
        : undefined;

    this.preferences.patch({
      surfacesLayout: layout,
      editorOpen: editor?.open ?? false,
      // Legacy mirrors — kept in sync for the code (e.g. the profiler tab)
      // that still reads `guiVisible` / `inspectorTab` / `inspectorWidth`
      // directly rather than through this service.
      ...(inspector ? { guiVisible: inspector.open } : {}),
      ...(inspectorTab ? { inspectorTab } : {}),
      ...(inspectorDockSize !== undefined ? { inspectorWidth: inspectorDockSize } : {}),
    });
  }

  apply(result: SurfaceCommandResult): boolean {
    if (!result.ok) return false;
    this.persistLayout();
    return true;
  }

  activate(id: SurfaceId): void {
    this.controller.activate(id);
  }

  zIndex(id: SurfaceId): number | null {
    return this.registry.zIndex(id);
  }

  showOnStage(id: SurfaceId = this.previewId): boolean {
    return this.apply(this.controller.showOnStage(id));
  }

  float(id: SurfaceId, rect?: Rect): boolean {
    return this.apply(this.controller.float(id, rect, this.containmentOptions(id)));
  }

  dock(id: SurfaceId, side?: DockSide, size?: number): boolean {
    return this.apply(this.controller.dock(id, side, size));
  }

  maximize(id: SurfaceId): boolean {
    return this.apply(this.controller.maximize(id, this.containmentOptions(id)));
  }

  minimize(id: SurfaceId, point?: Point): boolean {
    return this.apply(this.controller.minimize(id, point, this.containmentOptions(id)));
  }

  restore(id: SurfaceId): boolean {
    return this.apply(this.controller.restore(id, this.containmentOptions(id)));
  }

  toggleMaximized(id: SurfaceId): boolean {
    const surface = this.registry.get(id);
    if (!surface || !isContainedPlacement(surface.placement)) return false;
    if (surface.placement.mode === 'maximized') return this.restore(id);
    return this.maximize(id);
  }

  toggleMinimized(id: SurfaceId): boolean {
    const surface = this.registry.get(id);
    if (!surface || !isContainedPlacement(surface.placement)) return false;
    if (surface.placement.mode === 'minimized') return this.restore(id);
    return this.minimize(id);
  }

  resetGeometry(id: SurfaceId): boolean {
    return this.apply(this.controller.resetGeometry(id, this.containmentOptions(id)));
  }

  close(id: SurfaceId): boolean {
    const surface = this.registry.get(id);
    if (!surface) return false;

    if (surface.kind === 'editor') {
      const remaining = Math.max(0, this.registry.openEditorGroupCount() - 1);
      // The default editor frames every contained split group, so closing it
      // hides the whole editor and keeps the split for the next open.
      if (remaining < 1 || id === this.editorId) {
        // Sole editor group: hide the surface UI without rejecting (legacy editorOpen).
        this.registry.upsert({ ...surface, open: false });
        this.persistLayout();
        return true;
      }
    }

    return this.apply(this.controller.close(id, this.commandContext()));
  }

  open(id: SurfaceId): boolean {
    // Detached: show it, and bring its window forward (or reopen it).
    if (this.isNative(id)) {
      this.setShown(id, true);
      void this.detach(id);
      return true;
    }
    const surface = this.registry.get(id);
    if (
      surface &&
      isContainedPlacement(surface.placement) &&
      surface.placement.mode === 'minimized'
    ) {
      return this.restore(id) && this.apply(this.controller.open(id));
    }
    return this.apply(this.controller.open(id));
  }

  toggleEditorOpen(): boolean {
    if (this.editorOpen()) return this.close(this.editorId);
    return this.open(this.editorId);
  }

  openEditor(): boolean {
    return this.open(this.editorId);
  }

  /**
   * The "show controls" affordance: reopen a closed inspector, restore a
   * minimized one, or otherwise close it. Never leaves a minimized inspector
   * stranded — pressing it again always makes the inspector visible.
   */
  toggleInspectorOpen(): boolean {
    const surface = this.inspector();
    if (!surface.open) return this.open(this.inspectorId);
    if (isContainedPlacement(surface.placement) && surface.placement.mode === 'minimized') {
      return this.restore(this.inspectorId);
    }
    return this.close(this.inspectorId);
  }

  openInspector(): boolean {
    return this.open(this.inspectorId);
  }

  /** Chrome.tab is the durable tab source — this is the only place it is written. */
  setInspectorTab(tab: InspectorTab): void {
    const surface = this.inspector();
    if (surface.chrome.kind !== 'inspector' || surface.chrome.tab === tab) return;
    this.registry.upsert({ ...surface, chrome: { kind: 'inspector', tab } });
    this.persistLayout();
  }

  externalize(id: SurfaceId, bounds: Rect): boolean {
    if (!this.desktop.available) return false;
    return this.apply(
      this.controller.externalize(id, bounds, { allowNative: true, ...this.commandContext() }),
    );
  }

  returnToWorkspace(id: SurfaceId): boolean {
    if (!this.desktop.available) return false;
    return this.apply(
      this.controller.returnToWorkspace(id, { allowNative: true, ...this.commandContext() }),
    );
  }

  commitFloatingRect(id: SurfaceId, rect: Rect): boolean {
    return this.apply(this.controller.commitFloatingRect(id, rect, this.containmentOptions(id)));
  }

  commitDockSize(id: SurfaceId, size: number): boolean {
    return this.apply(this.controller.commitDockSize(id, size));
  }

  commitMinimizedPoint(id: SurfaceId, point: Point): boolean {
    return this.apply(this.controller.commitMinimizedPoint(id, point, this.containmentOptions(id)));
  }

  /** Electron-only; no-op on web. */
  runExternalize(id: SurfaceId, bounds: Rect): boolean {
    return this.externalize(id, bounds);
  }

  /** Electron-only; no-op on web. */
  runReturn(id: SurfaceId): boolean {
    return this.returnToWorkspace(id);
  }

  // --- Native panel windows (desktop main window only) ---------------------

  /** Whether a panel's native window is open now (it may be shown and still opening). */
  isWindowOpen(id: SurfaceId): boolean {
    return this.windows().has(id);
  }

  /** Whether a surface is placed in a native window of its own — shown or hidden. */
  isNative(id: SurfaceId): boolean {
    const surface = this.registry.get(id);
    return surface !== undefined && isNativePlacement(surface.placement);
  }

  /**
   * Moves a panel into its native window, or focuses the window already showing
   * it. The layout changes only once the main process reports the window open,
   * so a refused or failed open leaves the contained panel exactly as it was.
   * Electron main window only; resolves `false` anywhere else.
   */
  detach(id: SurfaceId): Promise<boolean> {
    return this.ensureWindow(id, true);
  }

  /** Whether the panel is meant to be on screen, wherever it is placed. */
  private shown(id: SurfaceId): boolean {
    return id === this.bottomPanelId
      ? this.preferences.value().bottomPanelOpen
      : (this.registry.get(id)?.open ?? false);
  }

  private setShown(id: SurfaceId, open: boolean): void {
    if (this.shown(id) === open) return;
    if (id === this.bottomPanelId) {
      this.preferences.patch({ bottomPanelOpen: open });
      return;
    }
    const surface = this.registry.get(id);
    if (!surface) return;
    this.registry.upsert({ ...surface, open });
    this.persistLayout();
  }

  /**
   * Opens (or, with `focus`, focuses) the panel's window. Without `focus` an
   * already open window — one a reload of this window left behind — is only
   * adopted, not brought forward. Concurrent calls share one open.
   */
  private ensureWindow(id: SurfaceId, focus: boolean): Promise<boolean> {
    const kind = NATIVE_PANELS.get(id);
    if (!this.managesWindows || !kind) return Promise.resolve(false);
    let pending = this.opening.get(id);
    if (!pending) {
      pending = this.openWindow(id, kind, focus).finally(() => this.opening.delete(id));
      this.opening.set(id, pending);
    }
    return pending;
  }

  private async openWindow(id: SurfaceId, kind: SatelliteKind, focus: boolean): Promise<boolean> {
    if (!focus && (await this.desktop.surfaceState(id).catch(() => null))) {
      this.markWindow(id, true);
      return true;
    }
    const result = await this.desktop
      .openSurface({ surfaceId: id, kind, path: NATIVE_SURFACE_PATHS[kind]! })
      .catch(() => null);
    if (result?.status !== 'ok' && result?.status !== 'focused') {
      // A window that cannot open must not take the panel with it: show it contained instead.
      if (this.isNative(id)) this.returnToWorkspace(id);
      return false;
    }
    if (!this.isNative(id) && !this.externalize(id, result.surface.bounds)) {
      this.closeWindow(id);
      return false;
    }
    this.markWindow(id, true);
    this.setShown(id, true);
    return true;
  }

  /** Closes a window this window no longer wants; its `open: false` is then not a user close. */
  private closeWindow(id: SurfaceId): void {
    this.closing.add(id);
    void this.desktop.closeSurface(id).then(
      () => this.markWindow(id, false),
      () => this.closing.delete(id),
    );
  }

  private markWindow(id: SurfaceId, open: boolean): void {
    // A close that never reported back is stale once a window is open again.
    if (open) this.closing.delete(id);
    if (this.windows().has(id) === open) return;
    const next = new Set(this.windows());
    if (open) next.add(id);
    else next.delete(id);
    this.windows.set(next);
  }

  /**
   * Keeps every native panel's window in step with the layout. "Detached" is a
   * placement the user chose, and it outlives its window: closing the window
   * only hides the panel, showing the panel again reopens its window, and a
   * relaunch reopens the window of every detached panel that was shown. Dock is
   * the one way back into the workspace.
   */
  private followNativeWindows(): void {
    // Dock: `surface-returned` comes before the closing window's `open: false`, which then
    // finds the panel contained and leaves it shown.
    const offReturned = this.desktop.onSurfaceReturned(({ surfaceId }) => {
      const id = asSurfaceId(surfaceId);
      if (!NATIVE_PANELS.has(id)) return;
      this.markWindow(id, false);
      if (this.isNative(id) && this.returnToWorkspace(id)) this.setShown(id, true);
    });
    const offChanged = this.desktop.onSurfaceChanged((event) => {
      const id = asSurfaceId(event.surfaceId);
      if (!NATIVE_PANELS.has(id) || event.open) return;
      this.markWindow(id, false);
      // A close this window asked for (hiding the panel) is not the user closing it.
      if (this.closing.delete(id)) return;
      if (this.isNative(id)) this.setShown(id, false);
    });
    this.destroyRef.onDestroy(() => {
      offReturned();
      offChanged();
    });

    effect(() => {
      const windows = this.windows();
      for (const id of NATIVE_PANELS.keys()) {
        const native = this.isNative(id);
        const shown = this.shown(id);
        const open = windows.has(id);
        untracked(() => {
          if (native && shown && !open) void this.ensureWindow(id, false);
          else if (open && (!native || !shown) && !this.closing.has(id)) this.closeWindow(id);
        });
      }
    });
  }

  private surfaceRecord(id: SurfaceId, kind: SurfaceKind): SurfaceRecord {
    return this.registry.get(id) ?? createDefaultSurface(kind, { id });
  }

  private readLegacyEditorDockSide(): DockSide {
    return this.preferences.value().editorWindow.dockSide;
  }

  /** Preview geometry is contained by the stage; every other surface uses the editor workspace. */
  private containmentOptions(id: SurfaceId): SurfaceControllerOptions {
    if (id !== this.previewId) return {};
    const { width, height } = this.previewWorkspaceRect();
    return { viewport: { width, height } };
  }
}
