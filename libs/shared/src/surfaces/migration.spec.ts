import { describe, expect, it } from 'vitest';

import {
  SURFACES_LAYOUT_KEY,
  applyLiveOutputReturnToPreview,
  migrateLayoutFromPreferences,
  migratePreferences,
  roundTripLayout,
} from './migration';
import {
  DEFAULT_EDITOR_GROUP_ID,
  editorSurfaceId,
  LAYOUT_VERSION,
  WELL_KNOWN_SURFACE_IDS,
} from './types';

const LEGACY_DEFAULTS = {
  editorOpen: false,
  editorWindow: {
    mode: 'docked',
    restoreMode: 'docked',
    dockSide: 'bottom',
    dockedHeight: 340,
    dockedWidth: 480,
    floating: { x: 48, y: 48, width: 760, height: 460 },
  },
  previewWindow: {
    mode: 'stage',
    restoreMode: 'floating',
    floating: { x: 48, y: 48, width: 720, height: 480 },
    minimized: { x: 24, y: 24 },
  },
  browserOpen: true,
  browserWidth: 300,
  guiVisible: true,
  inspectorWidth: 300,
  inspectorTab: 'controls',
  bottomPanelOpen: false,
  bottomPanelHeight: 220,
  bottomPanelTab: 'problems',
  language: 'en',
  capture: { format: 'png' },
};

describe('migrateLayoutFromPreferences', () => {
  it('migrates legacy defaults into a versioned layout', () => {
    const layout = migrateLayoutFromPreferences(LEGACY_DEFAULTS);
    expect(layout.version).toBe(2);

    const byKind = Object.fromEntries(layout.surfaces.map((s) => [s.kind, s]));
    expect(byKind['preview']?.placement).toEqual({ host: 'contained', mode: 'stage' });
    expect(byKind['preview']?.open).toBe(true);

    expect(byKind['editor']?.open).toBe(false);
    expect(byKind['editor']?.placement).toEqual({
      host: 'contained',
      mode: 'docked',
      side: 'bottom',
      size: 340,
    });

    expect(byKind['shader-browser']?.placement).toEqual({
      host: 'contained',
      mode: 'docked',
      side: 'left',
      size: 300,
    });
    expect(byKind['inspector']?.placement).toEqual({
      host: 'contained',
      mode: 'docked',
      side: 'right',
      size: 300,
    });
    expect(byKind['bottom-panel']?.open).toBe(false);
    expect(byKind['bottom-panel']?.chrome).toEqual({
      kind: 'bottom-panel',
      tab: 'problems',
    });
  });

  it.each([
    [
      'floating editor',
      {
        ...LEGACY_DEFAULTS,
        editorOpen: true,
        editorWindow: {
          ...LEGACY_DEFAULTS.editorWindow,
          mode: 'floating',
          restoreMode: 'floating',
        },
      },
      {
        host: 'contained',
        mode: 'floating',
        rect: { x: 48, y: 48, width: 760, height: 460 },
      },
    ],
    [
      'docked left editor',
      {
        ...LEGACY_DEFAULTS,
        editorOpen: true,
        editorWindow: {
          ...LEGACY_DEFAULTS.editorWindow,
          mode: 'docked',
          dockSide: 'left',
          dockedWidth: 480,
        },
      },
      { host: 'contained', mode: 'docked', side: 'left', size: 480 },
    ],
    [
      'maximized editor',
      {
        ...LEGACY_DEFAULTS,
        editorOpen: true,
        editorWindow: {
          ...LEGACY_DEFAULTS.editorWindow,
          mode: 'maximized',
          restoreMode: 'docked',
        },
      },
      {
        host: 'contained',
        mode: 'maximized',
        restore: { mode: 'docked', side: 'bottom', size: 340 },
      },
    ],
    [
      'minimized editor',
      {
        ...LEGACY_DEFAULTS,
        editorOpen: true,
        editorWindow: {
          ...LEGACY_DEFAULTS.editorWindow,
          mode: 'minimized',
          restoreMode: 'floating',
        },
      },
      {
        host: 'contained',
        mode: 'minimized',
        restore: {
          mode: 'floating',
          rect: { x: 48, y: 48, width: 760, height: 460 },
        },
      },
    ],
  ] as const)('migrates %s', (_label, prefs, expectedPlacement) => {
    const layout = migrateLayoutFromPreferences(prefs);
    const editor = layout.surfaces.find((s) => s.kind === 'editor');
    expect(editor?.placement).toEqual(expectedPlacement);
    expect(editor?.open).toBe(true);
  });

  it.each([
    [
      'floating preview',
      {
        ...LEGACY_DEFAULTS,
        previewWindow: {
          ...LEGACY_DEFAULTS.previewWindow,
          mode: 'floating',
          restoreMode: 'floating',
        },
      },
      {
        host: 'contained',
        mode: 'floating',
        rect: { x: 48, y: 48, width: 720, height: 480 },
      },
    ],
    [
      'maximized preview',
      {
        ...LEGACY_DEFAULTS,
        previewWindow: {
          ...LEGACY_DEFAULTS.previewWindow,
          mode: 'maximized',
          restoreMode: 'stage',
        },
      },
      { host: 'contained', mode: 'maximized', restore: { mode: 'stage' } },
    ],
    [
      'minimized preview',
      {
        ...LEGACY_DEFAULTS,
        previewWindow: {
          ...LEGACY_DEFAULTS.previewWindow,
          mode: 'minimized',
          restoreMode: 'floating',
        },
      },
      {
        host: 'contained',
        mode: 'minimized',
        restore: {
          mode: 'floating',
          rect: { x: 48, y: 48, width: 720, height: 480 },
        },
        point: { x: 24, y: 24 },
      },
    ],
  ] as const)('migrates %s', (_label, prefs, expectedPlacement) => {
    const layout = migrateLayoutFromPreferences(prefs);
    const preview = layout.surfaces.find((s) => s.id === WELL_KNOWN_SURFACE_IDS.preview);
    expect(preview?.placement).toEqual(expectedPlacement);
  });

  it('is idempotent on already-migrated input', () => {
    const first = migratePreferences(LEGACY_DEFAULTS);
    const second = migratePreferences(first.preferences);
    expect(second.layout).toEqual(first.layout);
    expect(second.preferences[SURFACES_LAYOUT_KEY]).toEqual(first.layout);
    expect(second.preferences['language']).toBe('en');
    expect(second.preferences['editorWindow']).toEqual(LEGACY_DEFAULTS.editorWindow);
    expect(second.preferences['capture']).toEqual(LEGACY_DEFAULTS.capture);
  });

  it('preserves unrelated preference fields', () => {
    const { preferences } = migratePreferences({
      ...LEGACY_DEFAULTS,
      futureFlag: true,
      nested: { a: 1 },
    });
    expect(preferences['futureFlag']).toBe(true);
    expect(preferences['nested']).toEqual({ a: 1 });
    expect(preferences['editorOpen']).toBe(false);
    expect(preferences[SURFACES_LAYOUT_KEY]).toBeDefined();
  });

  it('round-trips a migrated layout through JSON', () => {
    const layout = migrateLayoutFromPreferences({
      ...LEGACY_DEFAULTS,
      editorOpen: true,
      editorWindow: {
        ...LEGACY_DEFAULTS.editorWindow,
        mode: 'floating',
        restoreMode: 'floating',
      },
      previewWindow: {
        ...LEGACY_DEFAULTS.previewWindow,
        mode: 'minimized',
        restoreMode: 'stage',
      },
    });
    expect(roundTripLayout(layout)).toEqual(layout);
  });

  it('handles corrupt legacy values without throwing', () => {
    const layout = migrateLayoutFromPreferences({
      editorOpen: 'yes',
      editorWindow: { mode: 'docked', restoreMode: 'maximized', dockSide: 'up', floating: 'no' },
      previewWindow: null,
      browserWidth: 'wide',
      inspectorTab: 'nope',
      bottomPanelHeight: Number.NaN,
    });
    expect(layout.version).toBe(2);
    expect(layout.surfaces.length).toBeGreaterThanOrEqual(5);
  });

  it('applies live-output return onto the preview singleton', () => {
    const layout = migrateLayoutFromPreferences(LEGACY_DEFAULTS);
    const next = applyLiveOutputReturnToPreview(layout, {
      host: 'contained',
      mode: 'floating',
      rect: { x: 10, y: 20, width: 640, height: 480 },
    });
    const preview = next.surfaces.find((s) => s.kind === 'preview');
    expect(preview?.placement).toEqual({
      host: 'contained',
      mode: 'floating',
      rect: { x: 10, y: 20, width: 640, height: 480 },
    });
    expect(preview?.open).toBe(true);
  });

  it('migrates legacy preferences to exactly one default editor leaf', () => {
    const layout = migrateLayoutFromPreferences(LEGACY_DEFAULTS);
    expect(layout.version).toBe(LAYOUT_VERSION);
    expect(layout.editorLayout).toEqual({
      kind: 'leaf',
      surfaceId: editorSurfaceId(DEFAULT_EDITOR_GROUP_ID),
    });
  });

  it('migrates a version-1 layout without altering surfaces or z-order', () => {
    const v2 = migrateLayoutFromPreferences({
      ...LEGACY_DEFAULTS,
      editorOpen: true,
      inspectorWidth: 360,
    });
    const v1 = { version: 1, surfaces: v2.surfaces, zOrder: [...v2.zOrder].reverse() };

    const migrated = migrateLayoutFromPreferences({ [SURFACES_LAYOUT_KEY]: v1 });

    expect(migrated.version).toBe(2);
    expect(migrated.surfaces).toEqual(v2.surfaces);
    expect(migrated.zOrder).toEqual(v1.zOrder);
    expect(migrated.editorLayout).toEqual({
      kind: 'leaf',
      surfaceId: editorSurfaceId(DEFAULT_EDITOR_GROUP_ID),
    });
  });

  it('is idempotent across repeated preference migrations', () => {
    const once = migratePreferences(LEGACY_DEFAULTS);
    const twice = migratePreferences(once.preferences);
    expect(twice.layout).toEqual(once.layout);
    expect(twice.preferences).toEqual(once.preferences);
  });
});
