import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_EDITOR_WINDOW } from '@shadergrove/shared/editor-prefs';
import {
  COMPACT_VIEWPORT_WIDTH,
  DEFAULT_EDITOR_GROUP_ID,
  LAYOUT_VERSION,
  WELL_KNOWN_SURFACE_IDS,
  asEditorGroupId,
  asSplitNodeId,
  createDefaultSurface,
  editorSurfaceId,
  splitEditorLeaf,
  type EditorLayoutNode,
  isContainedPlacement,
  migrateLayoutFromPreferences,
} from '@shadergrove/shared/surfaces';
import { DEFAULT_PREVIEW_WINDOW } from '@shadergrove/shared/preview-prefs';
import type {
  NativeSurfaceChangedEvent,
  NativeSurfaceKind,
  NativeSurfaceOpenRequest,
  NativeSurfaceResult,
  NativeSurfaceSnapshot,
} from '../../desktop/contracts/contracts';
import { DesktopPlatform } from '../desktop/desktop-platform';
import { Preferences, type WorkspacePreferences } from '../prefs/preferences';
import { SurfaceController } from './surface-controller';
import { SurfaceLayoutService } from './surface-layout';
import { SurfaceRegistry } from './surface-registry';
import { projectSurfaceFrame } from './surface-frame';

class FakePreferences implements Partial<Preferences> {
  private readonly state = signal<Partial<WorkspacePreferences>>({
    editorOpen: true,
    editorWindow: DEFAULT_EDITOR_WINDOW,
    previewWindow: DEFAULT_PREVIEW_WINDOW,
    surfacesLayout: migrateLayoutFromPreferences({
      editorOpen: true,
      editorWindow: DEFAULT_EDITOR_WINDOW,
      previewWindow: DEFAULT_PREVIEW_WINDOW,
    }),
  });

  readonly value = this.state.asReadonly() as Preferences['value'];

  patch(patch: Partial<WorkspacePreferences>): void {
    this.state.update((current) => ({ ...current, ...patch }));
  }
}

describe('SurfaceLayoutService characterization', () => {
  let layout: SurfaceLayoutService;
  let registry: SurfaceRegistry;
  let preferences: FakePreferences;

  const viewport = { width: 1200, height: 800 };
  const editorId = editorSurfaceId(DEFAULT_EDITOR_GROUP_ID);
  const previewId = WELL_KNOWN_SURFACE_IDS.preview;

  beforeEach(() => {
    preferences = new FakePreferences();
    TestBed.configureTestingModule({
      providers: [
        SurfaceRegistry,
        SurfaceController,
        SurfaceLayoutService,
        { provide: Preferences, useValue: preferences },
      ],
    });
    registry = TestBed.inject(SurfaceRegistry);
    layout = TestBed.inject(SurfaceLayoutService);
    registry.setViewport(viewport);
    layout.hydrateFromPreferences();
  });

  const editorPlacement = () => layout.editor().placement;
  const previewPlacement = () => layout.preview().placement;

  describe('editor', () => {
    it('detaches into a floating window (contained float, not native)', () => {
      layout.float(editorId);
      const placement = editorPlacement();
      expect(isContainedPlacement(placement) && placement.mode).toBe('floating');
    });

    it('restores a maximized floating editor back to floating', () => {
      layout.float(editorId);
      layout.maximize(editorId);
      layout.restore(editorId);
      const placement = editorPlacement();
      expect(isContainedPlacement(placement) && placement.mode).toBe('floating');
    });

    it('closes by setting open=false without discarding placement', () => {
      layout.float(editorId);
      const before = structuredClone(layout.editor().placement);
      layout.close(editorId);
      expect(layout.editorOpen()).toBe(false);
      expect(layout.editor().placement).toEqual(before);
    });

    it('openEditor restores from minimized so the editor is visible', () => {
      layout.float(editorId);
      layout.minimize(editorId);
      layout.close(editorId);
      layout.openEditor();
      const placement = editorPlacement();
      expect(layout.editorOpen()).toBe(true);
      expect(isContainedPlacement(placement) && placement.mode).toBe('floating');
    });

    it('renders floating as docked on compact viewport without rewriting stored mode', () => {
      layout.float(editorId);
      registry.setViewport({ width: COMPACT_VIEWPORT_WIDTH - 1, height: 800 });
      const projected = projectSurfaceFrame(layout.editor(), registry.viewport());
      expect(projected.mode).toBe('docked');
      const stored = editorPlacement();
      expect(isContainedPlacement(stored) && stored.mode).toBe('floating');
    });

    it('does not let a smaller preview stage change the editor viewport', () => {
      layout.float(editorId);
      layout.setPreviewWorkspace({ x: 0, y: 0, width: COMPACT_VIEWPORT_WIDTH - 1, height: 400 });

      expect(registry.viewport()).toEqual(viewport);
      expect(projectSurfaceFrame(layout.editor(), registry.viewport()).mode).toBe('floating');
    });
  });

  describe('inspector', () => {
    const inspectorId = WELL_KNOWN_SURFACE_IDS.inspector;
    const inspectorPlacement = () => layout.inspector().placement;

    it('starts docked to the right by default', () => {
      const placement = inspectorPlacement();
      expect(isContainedPlacement(placement) && placement.mode === 'docked' && placement.side).toBe(
        'right',
      );
    });

    it('floats into a contained window and can dock back to the right', () => {
      layout.float(inspectorId);
      const floated = inspectorPlacement();
      expect(isContainedPlacement(floated) && floated.mode).toBe('floating');

      layout.dock(inspectorId, 'right');
      const docked = inspectorPlacement();
      expect(isContainedPlacement(docked) && docked.mode).toBe('docked');
    });

    it('restores a maximized floating inspector back to floating', () => {
      layout.float(inspectorId);
      layout.maximize(inspectorId);
      layout.restore(inspectorId);
      const placement = inspectorPlacement();
      expect(isContainedPlacement(placement) && placement.mode).toBe('floating');
    });

    it('toggleInspectorOpen closes an open inspector and reopens a closed one', () => {
      expect(layout.inspectorOpen()).toBe(true);
      layout.toggleInspectorOpen();
      expect(layout.inspectorOpen()).toBe(false);
      layout.toggleInspectorOpen();
      expect(layout.inspectorOpen()).toBe(true);
    });

    it('toggleInspectorOpen restores (never strands) a minimized inspector', () => {
      layout.float(inspectorId);
      layout.minimize(inspectorId);
      expect(layout.inspectorOpen()).toBe(true);

      layout.toggleInspectorOpen();
      const placement = inspectorPlacement();
      expect(isContainedPlacement(placement) && placement.mode).toBe('floating');
    });

    it('closing then toggling reopens without losing placement', () => {
      layout.float(inspectorId);
      layout.close(inspectorId);
      expect(layout.inspectorOpen()).toBe(false);

      layout.toggleInspectorOpen();
      expect(layout.inspectorOpen()).toBe(true);
      const placement = inspectorPlacement();
      expect(isContainedPlacement(placement) && placement.mode).toBe('floating');
    });

    it('setInspectorTab writes chrome.tab and mirrors the legacy inspectorTab pref', () => {
      layout.setInspectorTab('presets');
      expect(layout.inspectorTab()).toBe('presets');
      expect(preferences.value().inspectorTab).toBe('presets');
    });

    it('persistLayout mirrors open state and docked width into legacy prefs', () => {
      layout.dock(inspectorId, 'right', 340);
      expect(preferences.value().inspectorWidth).toBe(340);
      expect(preferences.value().guiVisible).toBe(true);

      layout.close(inspectorId);
      expect(preferences.value().guiVisible).toBe(false);
    });

    it('renders a floating inspector docked (right) for display on a narrow workspace', () => {
      layout.float(inspectorId);
      registry.setViewport({ width: COMPACT_VIEWPORT_WIDTH - 1, height: 800 });
      const projected = projectSurfaceFrame(layout.inspector(), registry.viewport());
      expect(projected.mode).toBe('docked');
      expect(projected.dockSide).toBe('right');
      const stored = inspectorPlacement();
      expect(isContainedPlacement(stored) && stored.mode).toBe('floating');
    });
  });

  describe('preview', () => {
    it('starts on the stage by default', () => {
      const placement = previewPlacement();
      expect(isContainedPlacement(placement) && placement.mode).toBe('stage');
    });

    it('detaches into a floating window', () => {
      layout.float(previewId);
      const placement = previewPlacement();
      expect(isContainedPlacement(placement) && placement.mode).toBe('floating');
    });

    it('uses the preview stage to clamp preview geometry without changing the editor viewport', () => {
      layout.setPreviewWorkspace({ x: 40, y: 80, width: 500, height: 400 });
      layout.float(previewId, { x: 480, y: 380, width: 400, height: 300 });

      const placement = previewPlacement();
      expect(
        isContainedPlacement(placement) && placement.mode === 'floating' && placement.rect,
      ).toEqual({
        x: 100,
        y: 100,
        width: 400,
        height: 300,
      });
      expect(registry.viewport()).toEqual(viewport);
    });

    it('returns to the stage', () => {
      layout.float(previewId);
      layout.showOnStage(previewId);
      const placement = previewPlacement();
      expect(isContainedPlacement(placement) && placement.mode).toBe('stage');
    });

    it('restores a maximized floating preview back to floating', () => {
      layout.float(previewId);
      layout.maximize(previewId);
      layout.restore(previewId);
      const placement = previewPlacement();
      expect(isContainedPlacement(placement) && placement.mode).toBe('floating');
    });
  });

  describe('z-order', () => {
    it('brings the most recently activated stacked surface to the foreground', () => {
      layout.float(editorId);
      layout.float(previewId);
      layout.activate(editorId);
      expect(registry.foreground()).toBe(editorId);
      layout.activate(previewId);
      expect(registry.foreground()).toBe(previewId);
      expect(registry.zIndex(previewId)!).toBeGreaterThan(registry.zIndex(editorId)!);
    });
  });

  describe('persistence', () => {
    it('reloads a persisted layout with the same surfaces and one default editor leaf', () => {
      layout.float(editorId);
      layout.float(previewId);
      layout.activate(editorId);
      const saved = preferences.value().surfacesLayout!;

      const reloaded = migrateLayoutFromPreferences({ surfacesLayout: saved });

      expect(reloaded.version).toBe(LAYOUT_VERSION);
      expect(reloaded.surfaces).toEqual(saved.surfaces);
      expect(reloaded.zOrder).toEqual(saved.zOrder);
      expect(reloaded.editorLayout).toEqual({ kind: 'leaf', surfaceId: editorId });
    });

    const second = asEditorGroupId('editor-group:1');
    const secondId = editorSurfaceId(second);

    function splitRight(ratio = 0.5): EditorLayoutNode {
      registry.upsert(
        createDefaultSurface('editor', {
          id: secondId,
          chrome: { kind: 'editor', editorGroupId: second },
        }),
      );
      const split = splitEditorLeaf(
        registry.editorLayout(),
        editorId,
        secondId,
        'horizontal',
        asSplitNodeId('split:right'),
      );
      if (!split.ok) throw new Error(split.reason);
      const tree = { ...(split.layout as Extract<EditorLayoutNode, { kind: 'split' }>), ratio };
      registry.setEditorLayout(tree);
      return tree;
    }

    it('persists a committed split tree and restores its geometry on reload', () => {
      const tree = splitRight(0.65);
      TestBed.tick();

      const saved = preferences.value().surfacesLayout!;
      expect(saved.editorLayout).toEqual(tree);

      // A fresh workspace reading the same preferences gets the same split back.
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [{ provide: Preferences, useValue: preferences }],
      });
      const reloaded = TestBed.inject(SurfaceRegistry);
      TestBed.inject(SurfaceLayoutService).hydrateFromPreferences();
      expect(reloaded.editorLayout()).toEqual(tree);
      expect(reloaded.get(secondId)?.chrome).toEqual({ kind: 'editor', editorGroupId: second });
    });

    it('closing the default editor hides the whole split and keeps it', () => {
      const tree = splitRight();
      expect(layout.close(editorId)).toBe(true);

      expect(layout.editorOpen()).toBe(false);
      expect(registry.get(secondId)?.open).toBe(true);
      expect(registry.editorLayout()).toEqual(tree);
      expect(preferences.value().editorOpen).toBe(false);
    });

    it('puts the default editor back into a stored tree that lost it', () => {
      preferences.patch({
        surfacesLayout: {
          ...preferences.value().surfacesLayout!,
          editorLayout: { kind: 'leaf', surfaceId: secondId },
        },
      });
      layout.hydrateFromPreferences();

      expect(registry.editorLayout()).toEqual({ kind: 'leaf', surfaceId: editorId });
    });
  });
});

class FakeDesktop {
  readonly available = true;
  readonly opens: NativeSurfaceOpenRequest[] = [];
  readonly closes: string[] = [];
  /** What the next open answers; `null` answers `ok` (or `focused`) with the requested surface. */
  next: NativeSurfaceResult | null = null;
  /** Windows the main process reports open to `surfaceState`. */
  readonly live = new Map<string, NativeSurfaceKind>();
  changed: (event: NativeSurfaceChangedEvent) => void = () => undefined;
  returned: (payload: { surfaceId: string }) => void = () => undefined;

  openSurface(request: NativeSurfaceOpenRequest): Promise<NativeSurfaceResult> {
    this.opens.push(request);
    if (this.next) return Promise.resolve(this.next);
    const status = this.live.has(request.surfaceId) ? 'focused' : 'ok';
    this.live.set(request.surfaceId, request.kind);
    return Promise.resolve({ status, surface: this.snapshot(request.surfaceId, request.kind) });
  }
  closeSurface(surfaceId: string): Promise<NativeSurfaceResult> {
    this.closes.push(surfaceId);
    return Promise.resolve({ status: 'closed', surfaceId });
  }
  surfaceState(surfaceId: string): Promise<NativeSurfaceSnapshot | null> {
    const kind = this.live.get(surfaceId);
    return Promise.resolve(kind ? this.snapshot(surfaceId, kind) : null);
  }
  onSurfaceChanged(listener: (event: NativeSurfaceChangedEvent) => void): () => void {
    this.changed = listener;
    return () => undefined;
  }
  onSurfaceReturned(listener: (payload: { surfaceId: string }) => void): () => void {
    this.returned = listener;
    return () => undefined;
  }

  /** The main process reports the window gone, as after an OS close. */
  windowClosed(surfaceId: string): void {
    this.live.delete(surfaceId);
    this.changed({ surfaceId, open: false });
  }

  private snapshot(surfaceId: string, kind: NativeSurfaceKind): NativeSurfaceSnapshot {
    return {
      surfaceId,
      kind,
      path: `/${kind}`,
      bounds: { x: 40, y: 60, width: 900, height: 420 },
      maximized: false,
      fullscreen: false,
    };
  }
}

/** Lets the open/close promises and the effects that follow them settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    TestBed.tick();
  }
}

describe('SurfaceLayoutService native bottom panel', () => {
  const id = WELL_KNOWN_SURFACE_IDS.bottomPanel;
  let layout: SurfaceLayoutService;
  let preferences: FakePreferences;
  let desktop: FakeDesktop;

  const boot = () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: Preferences, useValue: preferences },
        { provide: DesktopPlatform, useValue: desktop },
      ],
    });
    layout = TestBed.inject(SurfaceLayoutService);
    TestBed.tick();
  };

  beforeEach(() => {
    preferences = new FakePreferences();
    preferences.patch({ bottomPanelOpen: true });
    desktop = new FakeDesktop();
    boot();
  });

  const docked = () => {
    const placement = layout.bottomPanel().placement;
    return isContainedPlacement(placement) && placement.mode === 'docked' && placement.side;
  };
  const savedPlacementHost = () =>
    preferences.value().surfacesLayout?.surfaces.find((surface) => surface.id === id)?.placement
      .host;
  const shown = () => preferences.value().bottomPanelOpen;

  it('opens its own page and commits native placement only after the window opened', async () => {
    const detached = layout.detach(id);
    expect(layout.bottomPanelNative()).toBe(false);

    expect(await detached).toBe(true);
    expect(desktop.opens).toEqual([{ surfaceId: id, kind: 'bottom-panel', path: '/bottom-panel' }]);
    expect(layout.bottomPanelNative()).toBe(true);
    expect(savedPlacementHost()).toBe('native');
    expect(shown()).toBe(true);
  });

  it('leaves the docked panel untouched when the open is refused', async () => {
    desktop.next = { status: 'rejected', reason: 'load-failed:ERR_FAILED' };
    const saved = preferences.value().surfacesLayout;

    expect(await layout.detach(id)).toBe(false);
    expect(layout.bottomPanelNative()).toBe(false);
    expect(docked()).toBe('bottom');
    expect(preferences.value().surfacesLayout).toBe(saved);
  });

  it('shares one open between overlapping clicks and focuses the window afterwards', async () => {
    await Promise.all([layout.detach(id), layout.detach(id)]);
    expect(desktop.opens).toHaveLength(1);

    expect(await layout.detach(id)).toBe(true);
    expect(desktop.opens).toHaveLength(2);
    expect(layout.bottomPanelNative()).toBe(true);
  });

  it('docks back shown on Dock, ignoring the closing window that follows', async () => {
    await layout.detach(id);

    desktop.returned({ surfaceId: id });
    desktop.windowClosed(id);
    await settle();

    expect(layout.bottomPanelNative()).toBe(false);
    expect(docked()).toBe('bottom');
    expect(shown()).toBe(true);
    expect(savedPlacementHost()).toBe('contained');
    expect(desktop.opens).toHaveLength(1);
  });

  it('stays detached but hidden when the user closes its window, and reopens it on show', async () => {
    await layout.detach(id);

    desktop.windowClosed(id);
    await settle();

    expect(layout.bottomPanelNative()).toBe(true);
    expect(savedPlacementHost()).toBe('native');
    expect(shown()).toBe(false);
    expect(desktop.opens).toHaveLength(1);

    preferences.patch({ bottomPanelOpen: true });
    await settle();

    expect(desktop.opens).toHaveLength(2);
    expect(desktop.live.has(id)).toBe(true);
    expect(layout.bottomPanelNative()).toBe(true);
  });

  it('closes the window when the panel is hidden, without mistaking that for a user close', async () => {
    await layout.detach(id);
    await settle();
    expect(desktop.closes).toEqual([]);

    preferences.patch({ bottomPanelOpen: false });
    await settle();
    expect(desktop.closes).toEqual([id]);

    // The main process reports the close; showing the panel again brings the window back.
    desktop.windowClosed(id);
    preferences.patch({ bottomPanelOpen: true });
    await settle();

    expect(shown()).toBe(true);
    expect(desktop.opens).toHaveLength(2);
  });

  it('ignores other satellites', async () => {
    await layout.detach(id);

    desktop.windowClosed(WELL_KNOWN_SURFACE_IDS.livePreviewOutput);
    desktop.returned({ surfaceId: WELL_KNOWN_SURFACE_IDS.livePreviewOutput });
    await settle();

    expect(layout.bottomPanelNative()).toBe(true);
    expect(shown()).toBe(true);
  });

  it('reopens a shown detached panel in its window on relaunch', async () => {
    await layout.detach(id);
    desktop.live.clear(); // the app quit: no window survives it

    boot();
    await settle();

    expect(layout.bottomPanelNative()).toBe(true);
    expect(desktop.opens).toEqual([
      { surfaceId: id, kind: 'bottom-panel', path: '/bottom-panel' },
      { surfaceId: id, kind: 'bottom-panel', path: '/bottom-panel' },
    ]);
  });

  it('keeps a hidden detached panel hidden on relaunch, and opens its window when shown', async () => {
    await layout.detach(id);
    desktop.windowClosed(id);
    await settle();

    boot();
    await settle();
    expect(desktop.opens).toHaveLength(1);
    expect(layout.bottomPanelNative()).toBe(true);

    preferences.patch({ bottomPanelOpen: true });
    await settle();
    expect(desktop.opens).toHaveLength(2);
  });

  it('adopts the window a reload of the main window left open, without a second one', async () => {
    await layout.detach(id);

    boot(); // reload: the satellite is still open
    await settle();

    expect(desktop.opens).toHaveLength(1);
    expect(desktop.closes).toEqual([]);
    expect(layout.bottomPanelNative()).toBe(true);
  });

  it('docks the panel when its window cannot be reopened', async () => {
    await layout.detach(id);
    desktop.windowClosed(id);
    await settle();

    desktop.next = { status: 'rejected', reason: 'load-failed:ERR_FAILED' };
    preferences.patch({ bottomPanelOpen: true });
    await settle();

    expect(layout.bottomPanelNative()).toBe(false);
    expect(docked()).toBe('bottom');
    expect(shown()).toBe(true);
  });
});

describe('SurfaceLayoutService bottom panel without a native host', () => {
  it('never detaches on the web, and shows a panel saved as detached contained', async () => {
    const preferences = new FakePreferences();
    TestBed.configureTestingModule({
      providers: [
        { provide: Preferences, useValue: preferences },
        { provide: DesktopPlatform, useValue: new FakeDesktop() },
      ],
    });
    await TestBed.inject(SurfaceLayoutService).detach(WELL_KNOWN_SURFACE_IDS.bottomPanel);
    const saved = preferences.value().surfacesLayout?.surfaces;

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: Preferences, useValue: preferences }],
    });
    const layout = TestBed.inject(SurfaceLayoutService);

    const host = saved?.find((s) => s.id === WELL_KNOWN_SURFACE_IDS.bottomPanel)?.placement.host;
    expect(host).toBe('native');
    expect(layout.bottomPanelNative()).toBe(false);
    expect(await layout.detach(WELL_KNOWN_SURFACE_IDS.bottomPanel)).toBe(false);
  });

  it('leaves window management to the main window when this is the live output window', async () => {
    history.replaceState(null, '', '/output');
    try {
      const desktop = new FakeDesktop();
      TestBed.configureTestingModule({
        providers: [
          { provide: Preferences, useValue: new FakePreferences() },
          { provide: DesktopPlatform, useValue: desktop },
        ],
      });
      const layout = TestBed.inject(SurfaceLayoutService);

      expect(await layout.detach(WELL_KNOWN_SURFACE_IDS.bottomPanel)).toBe(false);
      expect(desktop.opens).toEqual([]);
    } finally {
      history.replaceState(null, '', '/');
    }
  });
});

describe('SurfaceLayoutService native inspector', () => {
  const id = WELL_KNOWN_SURFACE_IDS.inspector;
  let layout: SurfaceLayoutService;
  let desktop: FakeDesktop;

  beforeEach(() => {
    desktop = new FakeDesktop();
    TestBed.configureTestingModule({
      providers: [
        { provide: Preferences, useValue: new FakePreferences() },
        { provide: DesktopPlatform, useValue: desktop },
      ],
    });
    layout = TestBed.inject(SurfaceLayoutService);
    TestBed.tick();
  });

  it('opens its own page, then hides with its window and comes back in it', async () => {
    expect(await layout.detach(id)).toBe(true);
    expect(desktop.opens).toEqual([{ surfaceId: id, kind: 'inspector', path: '/inspector' }]);
    expect(layout.inspectorNative()).toBe(true);
    expect(layout.inspectorOpen()).toBe(true);

    desktop.windowClosed(id);
    await settle();
    expect(layout.inspectorNative()).toBe(true);
    expect(layout.inspectorOpen()).toBe(false);

    layout.openInspector();
    await settle();
    expect(desktop.opens).toHaveLength(2);
    expect(layout.inspectorOpen()).toBe(true);
  });

  it('closes its window when hidden from the workspace, and docks where it was on Dock', async () => {
    const before = layout.inspector().placement;
    await layout.detach(id);
    await settle();

    layout.toggleInspectorOpen();
    await settle();
    expect(desktop.closes).toEqual([id]);
    expect(layout.inspectorOpen()).toBe(false);

    layout.toggleInspectorOpen();
    await settle();
    desktop.returned({ surfaceId: id });
    desktop.windowClosed(id);
    await settle();

    expect(layout.inspectorNative()).toBe(false);
    expect(layout.inspector().placement).toEqual(before);
    expect(layout.inspectorOpen()).toBe(true);
  });
});

describe('SurfaceLayoutService native editor', () => {
  const id = editorSurfaceId(DEFAULT_EDITOR_GROUP_ID);
  const second = asEditorGroupId('editor-group:1');
  const secondId = editorSurfaceId(second);
  let layout: SurfaceLayoutService;
  let registry: SurfaceRegistry;
  let preferences: FakePreferences;
  let desktop: FakeDesktop;

  const boot = () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: Preferences, useValue: preferences },
        { provide: DesktopPlatform, useValue: desktop },
      ],
    });
    registry = TestBed.inject(SurfaceRegistry);
    layout = TestBed.inject(SurfaceLayoutService);
    TestBed.tick();
  };

  beforeEach(() => {
    preferences = new FakePreferences();
    desktop = new FakeDesktop();
    boot();
  });

  it('moves the whole editor to its own page and keeps its split for when it docks', async () => {
    registry.upsert(
      createDefaultSurface('editor', {
        id: secondId,
        chrome: { kind: 'editor', editorGroupId: second },
      }),
    );
    const split = splitEditorLeaf(
      registry.editorLayout(),
      id,
      secondId,
      'horizontal',
      asSplitNodeId('split:right'),
    );
    if (!split.ok) throw new Error(split.reason);
    registry.setEditorLayout(split.layout);
    TestBed.tick();

    expect(await layout.detach(id)).toBe(true);
    expect(desktop.opens).toEqual([{ surfaceId: id, kind: 'editor', path: '/editor' }]);
    expect(layout.editorNative()).toBe(true);
    expect(layout.editorOpen()).toBe(true);

    desktop.live.clear();
    boot(); // relaunch: the split is still there, the editor still detached
    await settle();
    expect(registry.editorLayout()).toEqual(split.layout);
    expect(layout.editorNative()).toBe(true);
    expect(desktop.opens).toHaveLength(2);

    desktop.returned({ surfaceId: id });
    desktop.windowClosed(id);
    await settle();
    expect(layout.editorNative()).toBe(false);
    expect(registry.editorLayout()).toEqual(split.layout);
  });

  it('hides with its window, and comes back in it when shown', async () => {
    await layout.detach(id);

    desktop.windowClosed(id);
    await settle();
    expect(layout.editorNative()).toBe(true);
    expect(layout.editorOpen()).toBe(false);

    layout.openEditor();
    await settle();
    expect(layout.editorOpen()).toBe(true);
    expect(desktop.opens).toHaveLength(2);

    // Showing it again while its window is open only brings that window forward.
    layout.openEditor();
    await settle();
    expect(desktop.opens).toHaveLength(3);
    expect(desktop.live.size).toBe(1);
  });
});
