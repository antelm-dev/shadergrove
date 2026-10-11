import { afterEach, describe, expect, it, vi } from 'vitest';

import { isOutputWindow, isSatelliteWindow, satelliteKind } from './output-mode';

/**
 * The secondary Electron output window is detected by pathname, not by a
 * dedicated Angular route. Native surface bootstraps must keep an equivalent
 * lightweight entry check.
 */

describe('isOutputWindow', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is false when window is undefined (SSR / module evaluation)', () => {
    vi.stubGlobal('window', undefined);
    expect(isOutputWindow()).toBe(false);
  });

  it('is true for /output and /output/ pathnames', () => {
    vi.stubGlobal('window', { location: { pathname: '/output' } });
    expect(isOutputWindow()).toBe(true);

    vi.stubGlobal('window', { location: { pathname: '/output/' } });
    expect(isOutputWindow()).toBe(true);
  });

  it('is false for the main workspace routes', () => {
    vi.stubGlobal('window', { location: { pathname: '/' } });
    expect(isOutputWindow()).toBe(false);

    vi.stubGlobal('window', { location: { pathname: '/shaders/abc' } });
    expect(isOutputWindow()).toBe(false);

    vi.stubGlobal('window', { location: { pathname: '/output-extra' } });
    expect(isOutputWindow()).toBe(false);
  });
});

describe('satelliteKind', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('names each panel window in the desktop app only', () => {
    const cases = [
      ['/bottom-panel', 'bottom-panel'],
      ['/bottom-panel/', 'bottom-panel'],
      ['/inspector', 'inspector'],
      ['/editor/', 'editor'],
    ] as const;
    for (const [pathname, kind] of cases) {
      vi.stubGlobal('window', { electron: {}, location: { pathname } });
      expect(satelliteKind()).toBe(kind);
      expect(isSatelliteWindow()).toBe(true);
    }

    // On the web the path is an unknown route that boots the workspace, as before.
    vi.stubGlobal('window', { location: { pathname: '/bottom-panel' } });
    expect(satelliteKind()).toBeNull();
  });

  it('is null for SSR and every other desktop route', () => {
    vi.stubGlobal('window', undefined);
    expect(isSatelliteWindow()).toBe(false);

    for (const pathname of ['/', '/output', '/bottom-panel-extra', '/shaders/editor']) {
      vi.stubGlobal('window', { electron: {}, location: { pathname } });
      expect(satelliteKind()).toBeNull();
    }
  });
});
