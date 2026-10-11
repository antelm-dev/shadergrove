/**
 * Electron main-process authority for native surface BrowserWindow lifecycle.
 *
 * Closing a surface destroys/hides the native window only — it never discards
 * drafts or project content (session ownership is Agent 05+).
 */

import { screen, type BrowserWindow } from 'electron';

import type { Rect } from '@shadergrove/shared/geometry';
import {
  NATIVE_SURFACE_PATHS,
  WELL_KNOWN_SURFACE_IDS,
  asSurfaceId,
  isSurfaceKind,
  type SurfaceId,
  type SurfaceKind,
} from '@shadergrove/shared/surfaces';

import {
  applyNavigationPolicy,
  assertSafeSurfacePath,
  createSecureBrowserWindow,
  type NavigationPolicyOptions,
  type SecureWindowOptions,
} from './browser-window-factory';
import { authorizeSurfaceAction } from './surface-ipc-auth';
import { SurfaceWindowRegistry, type SurfaceWindowEntry } from './surface-window-registry';
import {
  SurfaceWindowStateStore,
  centerInWorkArea,
  minSizeForKind,
  resolveSurfaceBounds,
  type DisplayWorkArea,
  type PersistedSurfaceWindowState,
} from './surface-window-state';

export interface NativeSurfaceSnapshot {
  surfaceId: string;
  kind: SurfaceKind;
  path: string;
  bounds: Rect;
  displayId?: string;
  maximized: boolean;
  fullscreen: boolean;
}

export interface OpenSurfaceRequest {
  surfaceId: string;
  kind: SurfaceKind;
  /** App pathname only (e.g. `/output`). */
  path: string;
  bounds?: Rect;
  maximized?: boolean;
  fullscreen?: boolean;
}

export type SurfaceManagerResult =
  | { status: 'ok'; surface: NativeSurfaceSnapshot }
  | { status: 'focused'; surface: NativeSurfaceSnapshot }
  | { status: 'closed'; surfaceId: string }
  | { status: 'returned'; surfaceId: string }
  | { status: 'rejected'; reason: string };

export type SurfaceContext =
  | { role: 'main' }
  | { role: 'satellite'; surfaceId: string; kind: SurfaceKind; path: string }
  | { role: 'unknown' };

/** Controllable seams for unit tests — production leaves these undefined. */
export interface SurfaceWindowManagerOptions {
  registry: SurfaceWindowRegistry;
  stateStore: SurfaceWindowStateStore;
  preload: string;
  resolveUrl: (path: string) => string;
  navigationFor: (role: 'main' | 'satellite') => NavigationPolicyOptions;
  getMainWindow: () => BrowserWindow | null;
  onSatelliteChanged: (
    snapshot: NativeSurfaceSnapshot | { surfaceId: string; open: false },
  ) => void;
  onReturnedToWorkspace: (surfaceId: SurfaceId, kind: SurfaceKind) => void;
  /** Override BrowserWindow construction (tests). */
  createWindow?: (options: SecureWindowOptions) => BrowserWindow;
  /** Override navigation load (tests). Defaults to `window.loadURL(url)`. */
  loadURL?: (window: BrowserWindow, url: string) => Promise<void>;
  /** Override display enumeration (tests). */
  listDisplays?: () => DisplayWorkArea[];
}

function defaultDisplays(): DisplayWorkArea[] {
  return screen.getAllDisplays().map((d) => ({
    id: String(d.id),
    workArea: {
      x: d.workArea.x,
      y: d.workArea.y,
      width: d.workArea.width,
      height: d.workArea.height,
    },
  }));
}

/** A panel window's size the first time it opens, in the shape the panel is used in. */
const FIRST_SIZES: Partial<Record<SurfaceKind, { width: number; height: number }>> = {
  'bottom-panel': { width: 1000, height: 360 },
  inspector: { width: 380, height: 760 },
  editor: { width: 960, height: 760 },
};

function fallbackBoundsFor(kind: SurfaceKind): Rect {
  const min = minSizeForKind(kind);
  const size = FIRST_SIZES[kind] ?? { width: 1280, height: 720 };
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  return centerInWorkArea(
    {
      x: display.workArea.x,
      y: display.workArea.y,
      width: display.workArea.width,
      height: display.workArea.height,
    },
    Math.min(size.width, display.workArea.width),
    Math.min(size.height, display.workArea.height),
    min,
  );
}

function snapshotOf(entry: SurfaceWindowEntry, displayId?: string): NativeSurfaceSnapshot {
  const win = entry.window;
  const bounds = win.getNormalBounds();
  return {
    surfaceId: entry.surfaceId,
    kind: entry.kind,
    path: entry.path,
    bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    displayId,
    maximized: win.isMaximized(),
    fullscreen: win.isFullScreen(),
  };
}

export class SurfaceWindowManager {
  private quitting = false;
  private readonly persistTimers = new Map<SurfaceId, NodeJS.Timeout>();
  /**
   * Surfaces whose open snapshot has been published. Failed opens that never
   * published suppress the closed `open: false` event so callers see a single
   * rejected/closed outcome.
   */
  private readonly publishedOpen = new Set<SurfaceId>();
  /** In-flight open settlement — prevents double reject from loadURL + did-fail-load. */
  private readonly opening = new Map<
    SurfaceId,
    { settle: (result: SurfaceManagerResult) => void }
  >();

  constructor(private readonly options: SurfaceWindowManagerOptions) {}

  get registry(): SurfaceWindowRegistry {
    return this.options.registry;
  }

  isOpen(surfaceId: SurfaceId | string): boolean {
    return this.options.registry.isOpen(asSurfaceId(String(surfaceId)));
  }

  /** True while a transactional open awaits loadURL / did-fail-load. */
  isOpening(surfaceId: SurfaceId | string): boolean {
    return this.opening.has(asSurfaceId(String(surfaceId)));
  }

  list(): NativeSurfaceSnapshot[] {
    return this.options.registry
      .list()
      .filter((e) => e.role === 'satellite' && !e.window.isDestroyed())
      .map((e) => snapshotOf(e, this.options.stateStore.get(e.surfaceId)?.displayId));
  }

  getState(surfaceId: SurfaceId | string): NativeSurfaceSnapshot | null {
    const entry = this.options.registry.get(asSurfaceId(String(surfaceId)));
    if (!entry || entry.window.isDestroyed()) return null;
    return snapshotOf(entry, this.options.stateStore.get(entry.surfaceId)?.displayId);
  }

  getContextForSender(sender: BrowserWindow): SurfaceContext {
    const main = this.options.getMainWindow();
    if (main && sender === main) return { role: 'main' };
    const entry = this.options.registry.getByWindow(sender);
    if (entry) {
      return {
        role: 'satellite',
        surfaceId: entry.surfaceId,
        kind: entry.kind,
        path: entry.path,
      };
    }
    return { role: 'unknown' };
  }

  /**
   * Authorization for surface IPC. Main may manage any surface; a satellite may
   * only inspect/act on its own SurfaceId.
   */
  authorize(
    sender: BrowserWindow,
    action: 'open' | 'focus' | 'close' | 'return' | 'list' | 'state' | 'context',
    targetId?: string,
  ): { allowed: true } | { allowed: false; reason: string } {
    return authorizeSurfaceAction(this, sender, action, targetId);
  }

  open(request: OpenSurfaceRequest): Promise<SurfaceManagerResult> {
    let path: string;
    try {
      path = assertSafeSurfacePath(request.path);
    } catch (error) {
      return Promise.resolve({
        status: 'rejected',
        reason: error instanceof Error ? error.message : 'invalid-path',
      });
    }

    // Each kind loads its own page and nothing else, so a satellite never boots another's shell.
    if (!isSurfaceKind(request.kind) || NATIVE_SURFACE_PATHS[request.kind] !== path.split('?')[0]) {
      return Promise.resolve({ status: 'rejected', reason: 'path-not-allowed' });
    }

    const surfaceId = asSurfaceId(request.surfaceId);
    const decision = this.options.registry.canOpen(request.kind, surfaceId);
    if (!decision.ok && decision.existing) {
      const existing = decision.existing;
      existing.window.show();
      existing.window.focus();
      return Promise.resolve({ status: 'focused', surface: snapshotOf(existing) });
    }

    const displays = this.options.listDisplays?.() ?? defaultDisplays();
    const remembered = this.mergeRemembered(surfaceId, request);
    const resolved = resolveSurfaceBounds({
      remembered,
      kind: request.kind,
      displays,
      fallback: request.bounds ?? fallbackBoundsFor(request.kind),
    });
    const min = minSizeForKind(request.kind);

    const createWindow = this.options.createWindow ?? createSecureBrowserWindow;
    const window = createWindow({
      width: resolved.bounds.width,
      height: resolved.bounds.height,
      x: resolved.bounds.x,
      y: resolved.bounds.y,
      minWidth: min.width,
      minHeight: min.height,
      show: false,
      // Panel windows draw the main window's title bar, frameless like it: still resizable and
      // snappable (Windows keeps the thick frame), moved by the bar's drag region. The live
      // preview output keeps the OS frame it has always had.
      frame: request.kind === 'live-preview-output',
      autoHideMenuBar: true,
      webPreferences: { preload: this.options.preload },
    });

    const entry: SurfaceWindowEntry = {
      surfaceId,
      kind: request.kind,
      window,
      path,
      role: 'satellite',
    };
    this.options.registry.register(entry);
    this.wireSatellite(entry, resolved.displayId);

    applyNavigationPolicy(window, this.options.navigationFor('satellite'));
    window.once('ready-to-show', () => {
      if (resolved.maximized) window.maximize();
      if (resolved.fullscreen) window.setFullScreen(true);
      window.show();
      window.focus();
    });

    return this.awaitSuccessfulLoad(entry, this.options.resolveUrl(path), resolved.displayId);
  }

  focus(surfaceId: string): SurfaceManagerResult {
    const entry = this.options.registry.get(asSurfaceId(surfaceId));
    if (!entry || entry.window.isDestroyed()) {
      return { status: 'rejected', reason: 'not-open' };
    }
    entry.window.show();
    entry.window.focus();
    return { status: 'focused', surface: snapshotOf(entry) };
  }

  close(surfaceId: string): SurfaceManagerResult {
    const id = asSurfaceId(surfaceId);
    const entry = this.options.registry.get(id);
    if (!entry || entry.window.isDestroyed()) {
      return { status: 'closed', surfaceId };
    }
    // Persist before destroy; closed handler clears the registry.
    this.persistEntry(entry);
    entry.window.close();
    return { status: 'closed', surfaceId };
  }

  /** Destroy the native window and notify the workspace to restore contained placement. */
  returnToWorkspace(surfaceId: string): SurfaceManagerResult {
    const id = asSurfaceId(surfaceId);
    const entry = this.options.registry.get(id);
    if (!entry || entry.window.isDestroyed()) {
      return { status: 'rejected', reason: 'not-open' };
    }
    const kind = entry.kind;
    this.persistEntry(entry);
    entry.window.close();
    this.options.onReturnedToWorkspace(id, kind);
    return { status: 'returned', surfaceId };
  }

  /** Main window `closed` / quit: tear down every satellite. */
  closeAllSatellites(): void {
    for (const entry of this.options.registry.list()) {
      if (entry.role !== 'satellite' || entry.window.isDestroyed()) continue;
      this.persistEntry(entry);
      entry.window.destroy();
    }
    this.options.registry.clear();
  }

  beginQuit(): void {
    this.quitting = true;
    this.flushAllPersisted();
    this.closeAllSatellites();
  }

  /** Live-preview-output adapter for Agent 07 / existing open-output IPC. */
  openLivePreviewOutput(): Promise<SurfaceManagerResult> {
    return this.open({
      surfaceId: WELL_KNOWN_SURFACE_IDS.livePreviewOutput,
      kind: 'live-preview-output',
      path: '/output',
    });
  }

  closeLivePreviewOutput(): SurfaceManagerResult {
    return this.close(WELL_KNOWN_SURFACE_IDS.livePreviewOutput);
  }

  isLivePreviewOutputOpen(): boolean {
    return this.isOpen(WELL_KNOWN_SURFACE_IDS.livePreviewOutput);
  }

  private awaitSuccessfulLoad(
    entry: SurfaceWindowEntry,
    url: string,
    displayId?: string,
  ): Promise<SurfaceManagerResult> {
    const { surfaceId, window } = entry;

    return new Promise<SurfaceManagerResult>((resolve) => {
      let settled = false;

      const settle = (result: SurfaceManagerResult) => {
        if (settled) return;
        settled = true;
        this.opening.delete(surfaceId);
        window.webContents.removeListener('did-fail-load', onFailLoad);
        resolve(result);
      };

      this.opening.set(surfaceId, { settle });

      const onFailLoad = (
        _event: Electron.Event,
        _errorCode: number,
        errorDescription: string,
        _validatedURL: string,
        isMainFrame: boolean,
      ) => {
        if (!isMainFrame || settled) return;
        const reason = `load-failed:${errorDescription || 'unknown'}`;
        // Settle before destroy so the closed handler does not overwrite the reason.
        settle({ status: 'rejected', reason });
        this.abortFailedOpen(entry);
      };

      window.webContents.on('did-fail-load', onFailLoad);

      const load = this.options.loadURL ?? ((win, target) => win.loadURL(target));
      void load(window, url).then(
        () => {
          if (settled) return;
          if (window.isDestroyed() || this.options.registry.get(surfaceId) !== entry) {
            settle({ status: 'rejected', reason: 'open-aborted' });
            return;
          }
          const snap = snapshotOf(entry, displayId);
          this.publishedOpen.add(surfaceId);
          this.options.onSatelliteChanged(snap);
          settle({ status: 'ok', surface: snap });
        },
        (error: unknown) => {
          if (settled) return;
          const detail = error instanceof Error ? error.message : 'load-rejected';
          const reason = `load-rejected:${detail}`;
          settle({ status: 'rejected', reason });
          this.abortFailedOpen(entry);
        },
      );
    });
  }

  /**
   * Destroy a satellite that never successfully loaded. Unregisters the id,
   * clears timers, and suppresses a duplicate closed event when open was never
   * published.
   */
  private abortFailedOpen(entry: SurfaceWindowEntry): void {
    const { surfaceId, window } = entry;
    this.clearPersistTimer(surfaceId);
    // Ensure closed-handler skip of open:false — never published.
    this.publishedOpen.delete(surfaceId);

    if (!window.isDestroyed()) {
      try {
        window.destroy();
      } catch {
        // Fall through to explicit unregister.
      }
    }

    const still = this.options.registry.get(surfaceId);
    if (still === entry) {
      this.options.registry.unregister(surfaceId);
    }
  }

  private mergeRemembered(
    surfaceId: SurfaceId,
    request: OpenSurfaceRequest,
  ): PersistedSurfaceWindowState | undefined {
    const saved = this.options.stateStore.get(surfaceId);
    if (!request.bounds && saved) {
      return {
        ...saved,
        maximized: request.maximized ?? saved.maximized,
        fullscreen: request.fullscreen ?? saved.fullscreen,
      };
    }
    if (request.bounds) {
      return {
        bounds: request.bounds,
        maximized: request.maximized,
        fullscreen: request.fullscreen,
        displayId: saved?.displayId,
      };
    }
    return saved;
  }

  private wireSatellite(entry: SurfaceWindowEntry, displayId?: string): void {
    const { window, surfaceId } = entry;

    const persist = () => this.schedulePersist(entry);
    // The window's own title bar shows maximize or restore: it is told, as the main window is.
    const pushState = () => {
      if (window.isDestroyed()) return;
      window.webContents.send('state-changed', {
        maximized: window.isMaximized(),
        fullscreen: window.isFullScreen(),
      });
    };
    window.on('resize', persist);
    window.on('move', persist);
    const stateChanged = () => {
      persist();
      pushState();
    };
    window.on('maximize', stateChanged);
    window.on('unmaximize', stateChanged);
    window.on('enter-full-screen', stateChanged);
    window.on('leave-full-screen', stateChanged);

    window.webContents.on('render-process-gone', () => {
      this.handleChildFailure(entry, 'crash');
    });
    window.on('unresponsive', () => {
      this.handleChildFailure(entry, 'unresponsive');
    });

    window.on('closed', () => {
      const still = this.options.registry.get(surfaceId);
      if (still === entry) this.options.registry.unregister(surfaceId);
      this.clearPersistTimer(surfaceId);

      // If an open is still awaiting load, settle it as rejected/closed once.
      const pending = this.opening.get(surfaceId);
      if (pending) {
        pending.settle({ status: 'rejected', reason: 'closed-before-load' });
      }

      const wasPublished = this.publishedOpen.delete(surfaceId);
      if (!this.quitting && wasPublished) {
        this.options.onSatelliteChanged({ surfaceId, open: false });
      }
    });

    if (displayId) {
      this.options.stateStore.set(surfaceId, {
        bounds: {
          x: window.getBounds().x,
          y: window.getBounds().y,
          width: window.getBounds().width,
          height: window.getBounds().height,
        },
        displayId,
        maximized: false,
        fullscreen: false,
      });
    }
  }

  private handleChildFailure(entry: SurfaceWindowEntry, reason: 'crash' | 'unresponsive'): void {
    if (entry.window.isDestroyed()) {
      this.options.registry.unregister(entry.surfaceId);
      if (this.publishedOpen.delete(entry.surfaceId)) {
        this.options.onSatelliteChanged({ surfaceId: entry.surfaceId, open: false });
      }
      return;
    }
    console.warn(
      `[surfaces] satellite ${entry.surfaceId} ${reason}; clearing registry (drafts untouched)`,
    );
    this.persistEntry(entry);
    try {
      entry.window.destroy();
    } catch {
      this.options.registry.unregister(entry.surfaceId);
      if (this.publishedOpen.delete(entry.surfaceId)) {
        this.options.onSatelliteChanged({ surfaceId: entry.surfaceId, open: false });
      }
    }
  }

  private schedulePersist(entry: SurfaceWindowEntry): void {
    this.clearPersistTimer(entry.surfaceId);
    this.persistTimers.set(
      entry.surfaceId,
      setTimeout(() => {
        this.persistTimers.delete(entry.surfaceId);
        this.persistEntry(entry);
        void this.options.stateStore.save();
      }, 200),
    );
  }

  private clearPersistTimer(surfaceId: SurfaceId): void {
    const timer = this.persistTimers.get(surfaceId);
    if (timer) {
      clearTimeout(timer);
      this.persistTimers.delete(surfaceId);
    }
  }

  private persistEntry(entry: SurfaceWindowEntry): void {
    if (entry.window.isDestroyed()) return;
    const bounds = entry.window.getNormalBounds();
    const nearest = screen.getDisplayMatching(bounds);
    this.options.stateStore.set(entry.surfaceId, {
      bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      displayId: String(nearest.id),
      maximized: entry.window.isMaximized(),
      fullscreen: entry.window.isFullScreen(),
    });
  }

  private flushAllPersisted(): void {
    for (const entry of this.options.registry.list()) {
      this.clearPersistTimer(entry.surfaceId);
      this.persistEntry(entry);
    }
    void this.options.stateStore.save();
  }
}
