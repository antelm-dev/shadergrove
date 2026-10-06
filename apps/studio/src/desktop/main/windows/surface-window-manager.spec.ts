import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { WELL_KNOWN_SURFACE_IDS } from '@shadergrove/shared/surfaces';

import type { SecureWindowOptions } from './browser-window-factory';
import { SurfaceWindowManager } from './surface-window-manager';
import { SurfaceWindowRegistry } from './surface-window-registry';
import { SurfaceWindowStateStore } from './surface-window-state';

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  shell: { openExternal: vi.fn() },
  screen: { getAllDisplays: vi.fn() },
}));

type LoadControl =
  | { mode: 'resolve' }
  | { mode: 'reject'; message: string }
  | { mode: 'pending' }
  | { mode: 'fail-load'; description: string };

class MockWebContents extends EventEmitter {
  readonly id: number;

  constructor(id: number) {
    super();
    this.id = id;
  }

  setWindowOpenHandler(_handler: unknown): void {
    // Navigation policy attaches this in production; no-op for tests.
  }
}

class MockBrowserWindow extends EventEmitter {
  readonly webContents: MockWebContents;
  private destroyed = false;
  private readonly bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };

  constructor(id: number, options: SecureWindowOptions) {
    super();
    this.webContents = new MockWebContents(id);
    this.bounds = {
      x: options.x ?? 0,
      y: options.y ?? 0,
      width: options.width,
      height: options.height,
    };
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  getBounds() {
    return { ...this.bounds };
  }

  getNormalBounds() {
    return { ...this.bounds };
  }

  isMaximized(): boolean {
    return false;
  }

  isFullScreen(): boolean {
    return false;
  }

  show(): void {}
  focus(): void {}
  maximize(): void {}
  setFullScreen(_value: boolean): void {}

  close(): void {
    this.destroy();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('closed');
  }
}

function createHarness(initialLoad: LoadControl = { mode: 'pending' }) {
  const registry = new SurfaceWindowRegistry();
  const stateStore = new SurfaceWindowStateStore('/tmp/surface-windows-test.json');
  const changes: Array<Record<string, unknown>> = [];
  const windows: MockBrowserWindow[] = [];
  let nextId = 1;
  let loadControl: LoadControl = initialLoad;
  let loadCalls = 0;

  const pendingLoads: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    window: MockBrowserWindow;
  }> = [];

  const manager = new SurfaceWindowManager({
    registry,
    stateStore,
    preload: '/preload.js',
    resolveUrl: (path) => `app://bundle${path}`,
    navigationFor: () => ({
      isAppUrl: (url) => url.startsWith('app://'),
      openExternalHttp: false,
    }),
    getMainWindow: () => null,
    onSatelliteChanged: (event) => {
      changes.push({ ...event });
    },
    onReturnedToWorkspace: () => undefined,
    listDisplays: () => [
      {
        id: '1',
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      },
    ],
    createWindow: (options) => {
      const win = new MockBrowserWindow(nextId++, options);
      windows.push(win);
      return win as unknown as Electron.BrowserWindow;
    },
    loadURL: (window) => {
      loadCalls += 1;
      const mock = window as unknown as MockBrowserWindow;
      const control = loadControl;
      if (control.mode === 'resolve') {
        return Promise.resolve();
      }
      if (control.mode === 'reject') {
        return Promise.reject(new Error(control.message));
      }
      if (control.mode === 'fail-load') {
        return new Promise<void>((resolve, reject) => {
          pendingLoads.push({ resolve, reject, window: mock });
          queueMicrotask(() => {
            mock.webContents.emit('did-fail-load', {}, -6, control.description, 'app://x', true);
          });
        });
      }
      return new Promise<void>((resolve, reject) => {
        pendingLoads.push({ resolve, reject, window: mock });
      });
    },
  });

  return {
    manager,
    registry,
    changes,
    windows,
    get loadCalls() {
      return loadCalls;
    },
    setLoadControl(next: LoadControl) {
      loadControl = next;
    },
    resolvePendingLoad() {
      const pending = pendingLoads.shift();
      if (!pending) throw new Error('no pending load');
      pending.resolve();
    },
    rejectPendingLoad(message: string) {
      const pending = pendingLoads.shift();
      if (!pending) throw new Error('no pending load');
      pending.reject(new Error(message));
    },
    openRequest() {
      return {
        surfaceId: WELL_KNOWN_SURFACE_IDS.livePreviewOutput,
        kind: 'live-preview-output' as const,
        path: '/output',
        bounds: { x: 10, y: 20, width: 800, height: 600 },
      };
    },
  };
}

describe('SurfaceWindowManager transactional open', () => {
  it('reports ok and publishes a snapshot only after loadURL succeeds', async () => {
    const h = createHarness({ mode: 'pending' });
    const openPromise = h.manager.open(h.openRequest());

    expect(h.manager.isOpening(WELL_KNOWN_SURFACE_IDS.livePreviewOutput)).toBe(true);
    expect(h.registry.isOpen(WELL_KNOWN_SURFACE_IDS.livePreviewOutput)).toBe(true);
    expect(h.changes).toEqual([]);

    h.resolvePendingLoad();
    const result = await openPromise;

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.surface.surfaceId).toBe(WELL_KNOWN_SURFACE_IDS.livePreviewOutput);
      expect(result.surface.path).toBe('/output');
    }
    expect(h.changes).toHaveLength(1);
    expect(h.changes[0]?.['surfaceId']).toBe(WELL_KNOWN_SURFACE_IDS.livePreviewOutput);
    expect(h.changes[0]?.['open']).toBeUndefined();
    expect(h.manager.isOpening(WELL_KNOWN_SURFACE_IDS.livePreviewOutput)).toBe(false);
  });

  it('rejects on loadURL rejection, destroys the child, and clears registry', async () => {
    const h = createHarness({ mode: 'reject', message: 'ERR_FAILED' });
    const result = await h.manager.open(h.openRequest());

    expect(result).toEqual({ status: 'rejected', reason: 'load-rejected:ERR_FAILED' });
    expect(h.registry.isOpen(WELL_KNOWN_SURFACE_IDS.livePreviewOutput)).toBe(false);
    expect(h.windows[0]?.isDestroyed()).toBe(true);
    expect(h.changes).toEqual([]);
    expect(h.manager.isOpening(WELL_KNOWN_SURFACE_IDS.livePreviewOutput)).toBe(false);
  });

  it('rejects on main-frame did-fail-load exactly once and cleans up', async () => {
    const h = createHarness({ mode: 'fail-load', description: 'ERR_NAME_NOT_RESOLVED' });
    const result = await h.manager.open(h.openRequest());

    expect(result).toEqual({
      status: 'rejected',
      reason: 'load-failed:ERR_NAME_NOT_RESOLVED',
    });
    expect(h.registry.isOpen(WELL_KNOWN_SURFACE_IDS.livePreviewOutput)).toBe(false);
    expect(h.windows[0]?.isDestroyed()).toBe(true);
    expect(h.changes).toEqual([]);
  });

  it('ignores subframe did-fail-load and still succeeds', async () => {
    const h = createHarness({ mode: 'pending' });
    const openPromise = h.manager.open(h.openRequest());
    const win = h.windows[0]!;

    win.webContents.emit('did-fail-load', {}, -3, 'subframe', 'app://x', false);
    expect(h.manager.isOpening(WELL_KNOWN_SURFACE_IDS.livePreviewOutput)).toBe(true);

    h.resolvePendingLoad();
    const result = await openPromise;
    expect(result.status).toBe('ok');
    expect(h.registry.isOpen(WELL_KNOWN_SURFACE_IDS.livePreviewOutput)).toBe(true);
  });

  it('preserves one window per surface while an open is in flight', async () => {
    const h = createHarness({ mode: 'pending' });
    const first = h.manager.open(h.openRequest());

    expect(h.windows).toHaveLength(1);
    expect(h.loadCalls).toBe(1);

    const second = await h.manager.open(h.openRequest());
    expect(second.status).toBe('focused');
    expect(h.windows).toHaveLength(1);
    expect(h.loadCalls).toBe(1);

    h.resolvePendingLoad();
    const firstResult = await first;
    expect(firstResult.status).toBe('ok');
  });

  it('allows an immediate retry after a failed open', async () => {
    const h = createHarness({ mode: 'reject', message: 'boom' });
    const failed = await h.manager.open(h.openRequest());
    expect(failed.status).toBe('rejected');
    expect(h.registry.isOpen(WELL_KNOWN_SURFACE_IDS.livePreviewOutput)).toBe(false);

    h.setLoadControl({ mode: 'resolve' });
    const retry = await h.manager.open(h.openRequest());
    expect(retry.status).toBe('ok');
    expect(h.registry.isOpen(WELL_KNOWN_SURFACE_IDS.livePreviewOutput)).toBe(true);
    expect(h.windows).toHaveLength(2);
    expect(h.windows[0]?.isDestroyed()).toBe(true);
    expect(h.windows[1]?.isDestroyed()).toBe(false);
    expect(h.changes).toHaveLength(1);
  });

  it('clears timers and does not emit open:false when a never-published open fails', async () => {
    vi.useFakeTimers();
    try {
      const h = createHarness({ mode: 'pending' });
      const openPromise = h.manager.open(h.openRequest());
      const win = h.windows[0]!;

      // Schedule a persist timer, then fail the open.
      win.emit('resize');
      h.rejectPendingLoad('nav-error');
      const result = await openPromise;
      expect(result.status).toBe('rejected');

      await vi.runAllTimersAsync();
      expect(h.changes).toEqual([]);
      expect(h.registry.list()).toHaveLength(0);
      expect(h.manager.isOpening(WELL_KNOWN_SURFACE_IDS.livePreviewOutput)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits open:false only after a successful open is later closed', async () => {
    const h = createHarness({ mode: 'resolve' });
    const opened = await h.manager.open(h.openRequest());
    expect(opened.status).toBe('ok');
    expect(h.changes).toHaveLength(1);

    // Destroy directly to avoid screen-backed persist in close().
    h.windows[0]!.destroy();
    expect(h.registry.isOpen(WELL_KNOWN_SURFACE_IDS.livePreviewOutput)).toBe(false);
    expect(h.changes).toHaveLength(2);
    expect(h.changes[1]).toEqual({
      surfaceId: WELL_KNOWN_SURFACE_IDS.livePreviewOutput,
      open: false,
    });
  });
});
