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
  WELL_KNOWN_SURFACE_IDS,
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
import { BOTTOM_PANEL_PATH } from '../output-mode';
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
export const BOTTOM_PANEL_SURFACE_PATH = BOTTOM_PANEL_PATH;

@Injectable({ providedIn: 'root' })
export class SurfaceLayoutService {
  private readonly preferences = inject(Preferences);
  private readonly registry = inject(SurfaceRegistry);
  private readonly controller = inject(SurfaceController);
  private readonly desktop = inject(DesktopPlatform);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly destroyRef = inject(DestroyRef);
  private detaching: Promise<boolean> | null = null;

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

  /** A native window shows the bottom panel, so the workspace must not render its docked copy. */
  readonly bottomPanelNative = computed(() => isNativePlacement(this.bottomPanel().placement));

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
      if (this.desktop.available) this.followBottomPanelWindow();
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
    // A native window never outlives the app, so a panel saved as detached docks back on launch.
    // After a reload of this window the old one may still be open: close it rather than show two.
    if (isNativePlacement(this.registry.ensure('bottom-panel').placement)) {
      this.controller.returnToWorkspace(this.bottomPanelId);
      void this.desktop.closeSurface(this.bottomPanelId).catch(() => undefined);
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

  /**
   * Moves the bottom panel into its native window, or focuses the window already
   * showing it. The layout changes only once the main process reports the window
   * open, so a refused or failed open leaves the docked panel exactly as it was.
   * Electron-only; resolves `false` on web.
   */
  detachBottomPanel(): Promise<boolean> {
    if (!this.desktop.available) return Promise.resolve(false);
    // A second click while the first open is still loading shares its outcome.
    this.detaching ??= this.openBottomPanelWindow().finally(() => (this.detaching = null));
    return this.detaching;
  }

  /** Electron-only; no-op on web. */
  runExternalize(id: SurfaceId, bounds: Rect): boolean {
    return this.externalize(id, bounds);
  }

  /** Electron-only; no-op on web. */
  runReturn(id: SurfaceId): boolean {
    return this.returnToWorkspace(id);
  }

  private async openBottomPanelWindow(): Promise<boolean> {
    const result = await this.desktop
      .openSurface({
        surfaceId: this.bottomPanelId,
        kind: 'bottom-panel',
        path: BOTTOM_PANEL_SURFACE_PATH,
      })
      .catch(() => null);
    if (result?.status !== 'ok' && result?.status !== 'focused') return false;
    if (!this.bottomPanelNative() && !this.externalize(this.bottomPanelId, result.surface.bounds)) {
      return false;
    }
    if (!this.preferences.value().bottomPanelOpen)
      this.preferences.patch({ bottomPanelOpen: true });
    return true;
  }

  private followBottomPanelWindow(): void {
    // Dock sends `surface-returned` before the closing window's `open: false`,
    // which then finds the panel already contained and leaves it shown.
    const offReturned = this.desktop.onSurfaceReturned(({ surfaceId }) => {
      if (surfaceId === this.bottomPanelId) this.settleBottomPanel(true);
    });
    const offChanged = this.desktop.onSurfaceChanged((event) => {
      if (event.surfaceId === this.bottomPanelId && !event.open) this.settleBottomPanel(false);
    });
    this.destroyRef.onDestroy(() => {
      offReturned();
      offChanged();
    });

    // Hiding the panel from the menu or a shortcut closes its window as well.
    effect(() => {
      if (this.preferences.value().bottomPanelOpen || !this.bottomPanelNative()) return;
      untracked(() => void this.desktop.closeSurface(this.bottomPanelId).catch(() => undefined));
    });
  }

  /** The panel's native window is gone: dock it back, shown after Dock and hidden after a close. */
  private settleBottomPanel(open: boolean): void {
    if (!this.bottomPanelNative()) return;
    this.controller.returnToWorkspace(this.bottomPanelId);
    if (!open) this.controller.close(this.bottomPanelId);
    this.persistLayout();
    this.preferences.patch({ bottomPanelOpen: open });
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
