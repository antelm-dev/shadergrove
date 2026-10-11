import { describe, expect, it } from 'vitest';

import {
  createDefaultSurface,
  sanitizeLayoutPreferences,
  sanitizePlacement,
  sanitizeRestorePoint,
  sanitizeSurfaceRecord,
} from './sanitize';
import type { SurfaceKind } from './types';

describe('sanitizeRestorePoint', () => {
  it.each([['maximized'], ['minimized'], ['nonsense'], [7], [null]])(
    'rejects illegal restore mode %s',
    (mode) => {
      expect(sanitizeRestorePoint({ mode }, 'editor')).toEqual({
        mode: 'docked',
        side: 'bottom',
        size: 340,
      });
      expect(sanitizeRestorePoint({ mode }, 'preview')).toEqual({ mode: 'stage' });
    },
  );

  it('keeps a legal floating restore', () => {
    expect(
      sanitizeRestorePoint(
        { mode: 'floating', rect: { x: 1, y: 2, width: 400, height: 300 } },
        'editor',
      ),
    ).toEqual({
      mode: 'floating',
      rect: { x: 1, y: 2, width: 400, height: 300 },
    });
  });
});

describe('sanitizePlacement', () => {
  it('falls back when preview tries to dock', () => {
    expect(
      sanitizePlacement(
        { host: 'contained', mode: 'docked', side: 'bottom', size: 200 },
        'preview',
      ),
    ).toEqual({
      host: 'contained',
      mode: 'stage',
    });
  });

  it('falls back when editor tries to occupy the stage', () => {
    expect(sanitizePlacement({ host: 'contained', mode: 'stage' }, 'editor')).toMatchObject({
      host: 'contained',
      mode: 'docked',
    });
  });

  it('coerces live-preview-output to native', () => {
    const placement = sanitizePlacement(
      { host: 'contained', mode: 'floating', rect: { x: 0, y: 0, width: 640, height: 480 } },
      'live-preview-output',
    );
    expect(placement.host).toBe('native');
  });

  it('recovers floating rect against a smaller viewport', () => {
    const placement = sanitizePlacement(
      {
        host: 'contained',
        mode: 'floating',
        rect: { x: 5000, y: 5000, width: 800, height: 600 },
      },
      'editor',
      { viewport: { width: 1000, height: 700 } },
    );
    expect(placement).toMatchObject({ mode: 'floating' });
    if (placement.host !== 'contained' || placement.mode !== 'floating') return;
    expect(placement.rect.x).toBeLessThanOrEqual(1000);
    expect(placement.rect.y).toBeLessThanOrEqual(700);
  });

  it('recovers native bounds when the display work area is missing or tiny', () => {
    const placement = sanitizePlacement(
      {
        host: 'native',
        bounds: { x: 4000, y: 4000, width: 1200, height: 900 },
        displayId: 'missing-display',
      },
      'editor',
      { workArea: { width: 800, height: 600 } },
    );
    expect(placement.host).toBe('native');
    if (placement.host !== 'native') return;
    expect(placement.bounds.width).toBeLessThanOrEqual(800);
    expect(placement.bounds.height).toBeLessThanOrEqual(600);
    expect(placement.bounds.x).toBeGreaterThanOrEqual(0);
    expect(placement.bounds.y).toBeGreaterThanOrEqual(0);
  });

  it('passes native bounds through when work area is unmeasured', () => {
    const placement = sanitizePlacement(
      {
        host: 'native',
        bounds: { x: 100, y: 200, width: 640, height: 480 },
      },
      'editor',
      { workArea: { width: 0, height: 0 } },
    );
    expect(placement).toEqual({
      host: 'native',
      bounds: { x: 100, y: 200, width: 640, height: 480 },
    });
  });
});

describe('sanitizeSurfaceRecord / layout', () => {
  it.each([[null], [42], ['nope'], [[]], [{ kind: 'unknown' }]])(
    'drops unusable surface payload %s',
    (value) => {
      expect(sanitizeSurfaceRecord(value)).toBeNull();
    },
  );

  it('discards duplicate singleton kinds', () => {
    const layout = sanitizeLayoutPreferences({
      version: 1,
      surfaces: [
        createDefaultSurface('preview'),
        { ...createDefaultSurface('preview'), id: 'surface:preview-dup' },
        createDefaultSurface('inspector'),
      ],
      zOrder: [],
    });
    expect(layout.surfaces.filter((s) => s.kind === 'preview')).toHaveLength(1);
  });

  it('ensures required workspace surfaces exist', () => {
    const layout = sanitizeLayoutPreferences({ version: 1, surfaces: [], zOrder: [] });
    const kinds = new Set(layout.surfaces.map((s) => s.kind));
    for (const kind of [
      'preview',
      'editor',
      'inspector',
      'shader-browser',
      'bottom-panel',
    ] as SurfaceKind[]) {
      expect(kinds.has(kind)).toBe(true);
    }
    expect(kinds.has('live-preview-output')).toBe(false);
  });

  it('keeps the split of a default editor that lives in a native window', () => {
    const second = 'surface:editor:editor-group:1';
    const tree = {
      kind: 'split',
      id: 'split:right',
      axis: 'horizontal',
      ratio: 0.5,
      first: { kind: 'leaf', surfaceId: 'surface:editor:editor-group:default' },
      second: { kind: 'leaf', surfaceId: second },
    };
    const layout = sanitizeLayoutPreferences({
      version: 2,
      surfaces: [
        {
          ...createDefaultSurface('editor'),
          placement: { host: 'native', bounds: { x: 0, y: 0, width: 900, height: 600 } },
        },
        {
          ...createDefaultSurface('editor', {
            chrome: { kind: 'editor', editorGroupId: 'editor-group:1' as never },
          }),
          id: second,
        },
      ],
      zOrder: [],
      editorLayout: tree,
    });

    expect(layout.editorLayout).toEqual(tree);
  });

  it('rejects corrupt maximized restoreMode nested as maximized', () => {
    const placement = sanitizePlacement(
      {
        host: 'contained',
        mode: 'maximized',
        restore: { mode: 'maximized' },
      },
      'editor',
    );
    expect(placement).toMatchObject({
      mode: 'maximized',
      restore: { mode: 'docked' },
    });
  });
});
