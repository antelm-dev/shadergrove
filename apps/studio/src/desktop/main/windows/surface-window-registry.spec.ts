import { describe, expect, it, vi } from 'vitest';

import { asSurfaceId, WELL_KNOWN_SURFACE_IDS } from '@shadergrove/shared/surfaces';

import { assertSafeSurfacePath, createAppUrlChecker } from './browser-window-factory';
import { authorizeSurfaceAction } from './surface-ipc-auth';
import { SurfaceWindowRegistry, type SurfaceWindowEntry } from './surface-window-registry';
import {
  boundsIntersectAnyDisplay,
  clampBoundsToWorkArea,
  parseSurfaceWindowsState,
  resolveSurfaceBounds,
  type DisplayWorkArea,
} from './surface-window-state';

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  shell: { openExternal: vi.fn() },
}));

function fakeWindow(webContentsId: number, destroyed = false) {
  return {
    isDestroyed: () => destroyed,
    webContents: { id: webContentsId },
  } as unknown as Electron.BrowserWindow;
}

function entry(
  surfaceId: string,
  kind: SurfaceWindowEntry['kind'],
  webContentsId: number,
  destroyed = false,
): SurfaceWindowEntry {
  return {
    surfaceId: asSurfaceId(surfaceId),
    kind,
    window: fakeWindow(webContentsId, destroyed),
    path: '/output',
    role: 'satellite',
  };
}

describe('assertSafeSurfacePath', () => {
  it('accepts app pathnames', () => {
    expect(assertSafeSurfacePath('/output')).toBe('/output');
    expect(assertSafeSurfacePath('/preview')).toBe('/preview');
  });

  it('rejects traversal and absolute URLs', () => {
    expect(() => assertSafeSurfacePath('../etc')).toThrow();
    expect(() => assertSafeSurfacePath('https://evil.example/')).toThrow();
    expect(() => assertSafeSurfacePath('//cdn.example')).toThrow();
  });

  it('rejects oversized query payloads', () => {
    expect(() => assertSafeSurfacePath(`/output?${'x'.repeat(200)}`)).toThrow();
  });
});

describe('createAppUrlChecker', () => {
  it('allows only the app origin in production', () => {
    const check = createAppUrlChecker({
      production: true,
      scheme: 'shader-studio',
      devServerUrl: 'http://localhost:4201',
    });
    expect(check('shader-studio://bundle/output')).toBe(true);
    expect(check('http://localhost:4201/output')).toBe(false);
    expect(check('https://evil.example')).toBe(false);
  });

  it('allows the dev server in development', () => {
    const check = createAppUrlChecker({
      production: false,
      scheme: 'shader-studio',
      devServerUrl: 'http://localhost:4201',
    });
    expect(check('http://localhost:4201/output')).toBe(true);
    expect(check('shader-studio://bundle/')).toBe(false);
  });
});

describe('SurfaceWindowRegistry', () => {
  it('maps by SurfaceId and webContents id, not BrowserWindow.id', () => {
    const registry = new SurfaceWindowRegistry();
    const live = entry(WELL_KNOWN_SURFACE_IDS.livePreviewOutput, 'live-preview-output', 42);
    registry.register(live);

    expect(registry.get(WELL_KNOWN_SURFACE_IDS.livePreviewOutput)).toBe(live);
    expect(registry.getByWebContentsId(42)).toBe(live);
    expect(registry.isOpen(WELL_KNOWN_SURFACE_IDS.livePreviewOutput)).toBe(true);
  });

  it('enforces singleton for live-preview-output', () => {
    const registry = new SurfaceWindowRegistry();
    registry.register(entry(WELL_KNOWN_SURFACE_IDS.livePreviewOutput, 'live-preview-output', 1));

    const decision = registry.canOpen('live-preview-output', asSurfaceId('surface:other-output'));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe('singleton-occupied');
      expect(decision.existing?.surfaceId).toBe(WELL_KNOWN_SURFACE_IDS.livePreviewOutput);
    }
  });

  it('allows multiple editor surfaces', () => {
    const registry = new SurfaceWindowRegistry();
    registry.register(entry('surface:editor:a', 'editor', 1));
    expect(registry.canOpen('editor', asSurfaceId('surface:editor:b'))).toEqual({ ok: true });
    registry.register(entry('surface:editor:b', 'editor', 2));
    expect(registry.listByKind('editor')).toHaveLength(2);
  });

  it('unregisters and clears webContents mapping', () => {
    const registry = new SurfaceWindowRegistry();
    registry.register(entry('surface:editor:a', 'editor', 9));
    registry.unregister(asSurfaceId('surface:editor:a'));
    expect(registry.getByWebContentsId(9)).toBeUndefined();
    expect(registry.isOpen(asSurfaceId('surface:editor:a'))).toBe(false);
  });
});

describe('surface window bounds recovery', () => {
  const displays: DisplayWorkArea[] = [
    { id: '1', workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
    { id: '2', workArea: { x: 1920, y: 0, width: 1280, height: 800 } },
  ];

  it('keeps on-screen bounds on the remembered display', () => {
    const resolved = resolveSurfaceBounds({
      kind: 'live-preview-output',
      displays,
      fallback: { x: 100, y: 100, width: 800, height: 600 },
      remembered: {
        bounds: { x: 2000, y: 40, width: 640, height: 360 },
        displayId: '2',
        maximized: true,
      },
    });
    expect(resolved.displayId).toBe('2');
    expect(resolved.maximized).toBe(true);
    expect(boundsIntersectAnyDisplay(resolved.bounds, displays)).toBe(true);
    expect(resolved.bounds.x).toBeGreaterThanOrEqual(1920);
  });

  it('recenters when the remembered display disappeared', () => {
    const resolved = resolveSurfaceBounds({
      kind: 'editor',
      displays: [displays[0]!],
      fallback: { x: 0, y: 0, width: 800, height: 600 },
      remembered: {
        bounds: { x: 4000, y: 40, width: 640, height: 360 },
        displayId: '99',
      },
    });
    expect(resolved.displayId).toBe('1');
    expect(resolved.bounds.x).toBeGreaterThanOrEqual(0);
    expect(resolved.bounds.x + resolved.bounds.width).toBeLessThanOrEqual(1920);
  });

  it('clamps into absolute work-area coordinates', () => {
    const clamped = clampBoundsToWorkArea(
      { x: 1800, y: -20, width: 900, height: 900 },
      displays[1]!.workArea,
      { width: 480, height: 270 },
    );
    expect(clamped.x).toBeGreaterThanOrEqual(1920);
    expect(clamped.y).toBeGreaterThanOrEqual(0);
    expect(clamped.width).toBeLessThanOrEqual(1280);
    expect(clamped.height).toBeLessThanOrEqual(800);
  });
});

describe('parseSurfaceWindowsState', () => {
  it('ignores corrupt entries and never stores Electron window ids as keys', () => {
    const parsed = parseSurfaceWindowsState({
      version: 1,
      surfaces: {
        'surface:live-preview-output': {
          bounds: { x: 10, y: 10, width: 640, height: 360 },
          displayId: '1',
        },
        '12': { bounds: { x: 0, y: 0, width: 100, height: 100 } }, // numeric id noise — kept if well-formed but unused
        bad: { maximized: true },
      },
    });
    expect(parsed.surfaces['surface:live-preview-output']?.bounds.width).toBe(640);
    expect(parsed.surfaces['bad']).toBeUndefined();
  });
});

/**
 * IPC authorization rules from surface-ipc-auth — exercised with a stub context
 * provider so desktop tests do not need a running Electron session.
 */
describe('surface IPC authorization policy', () => {
  type Ctx =
    | { role: 'main' }
    | { role: 'satellite'; surfaceId: string; kind: 'live-preview-output'; path: string };

  function authorize(
    ctx: Ctx,
    action: 'open' | 'focus' | 'close' | 'return' | 'list' | 'state' | 'context',
    targetId?: string,
  ) {
    return authorizeSurfaceAction(
      { getContextForSender: () => ctx },
      {} as Electron.BrowserWindow,
      action,
      targetId,
    );
  }

  it('lets the main workspace open and list surfaces', () => {
    expect(authorize({ role: 'main' }, 'open')).toEqual({ allowed: true });
    expect(authorize({ role: 'main' }, 'list')).toEqual({ allowed: true });
  });

  it('blocks satellites from opening or listing other surfaces', () => {
    const sat: Ctx = {
      role: 'satellite',
      surfaceId: 'surface:live-preview-output',
      kind: 'live-preview-output',
      path: '/output',
    };
    expect(authorize(sat, 'open')).toEqual({ allowed: false, reason: 'satellite-forbidden' });
    expect(authorize(sat, 'list')).toEqual({ allowed: false, reason: 'satellite-forbidden' });
  });

  it('lets a satellite close or return only itself', () => {
    const sat: Ctx = {
      role: 'satellite',
      surfaceId: 'surface:live-preview-output',
      kind: 'live-preview-output',
      path: '/output',
    };
    expect(authorize(sat, 'close', 'surface:live-preview-output')).toEqual({ allowed: true });
    expect(authorize(sat, 'return')).toEqual({ allowed: true });
    expect(authorize(sat, 'close', 'surface:editor:other')).toEqual({
      allowed: false,
      reason: 'not-owner',
    });
  });
});
