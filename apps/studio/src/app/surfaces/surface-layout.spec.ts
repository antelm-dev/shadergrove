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
  NativeSurfaceOpenRequest,
  NativeSurfaceResult,
} from '../../desktop/contracts/contracts';
import { DesktopPlatform } from '../desktop/desktop-platform';
import { Preferences, type WorkspacePreferences } from '../prefs/preferences';
import { SurfaceController } from './surface-controller';
import { BOTTOM_PANEL_SURFACE_PATH, SurfaceLayoutService } from './surface-layout';
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
  next: NativeSurfaceResult = {
    status: 'ok',
    surface: {
      surfaceId: WELL_KNOWN_SURFACE_IDS.bottomPanel,
      kind: 'bottom-panel',
      path: '/bottom-panel',
      bounds: { x: 40, y: 60, width: 900, height: 320 },
      maximized: false,
      fullscreen: false,
    },
  };
  changed: (event: NativeSurfaceChangedEvent) => void = () => undefined;
  returned: (payload: { surfaceId: string }) => void = () => undefined;

  openSurface(request: NativeSurfaceOpenRequest): Promise<NativeSurfaceResult> {
    this.opens.push(request);
    return Promise.resolve(this.next);
  }
  closeSurface(surfaceId: string): Promise<NativeSurfaceResult> {
    this.closes.push(surfaceId);
    return Promise.resolve({ status: 'closed', surfaceId });
  }
  onSurfaceChanged(listener: (event: NativeSurfaceChangedEvent) => void): () => void {
    this.changed = listener;
    return () => undefined;
  }
  onSurfaceReturned(listener: (payload: { surfaceId: string }) => void): () => void {
    this.returned = listener;
    return () => undefined;
  }
}

describe('SurfaceLayoutService native bottom panel', () => {
  const id = WELL_KNOWN_SURFACE_IDS.bottomPanel;
  let layout: SurfaceLayoutService;
  let preferences: FakePreferences;
  let desktop: FakeDesktop;

  beforeEach(() => {
    preferences = new FakePreferences();
    preferences.patch({ bottomPanelOpen: true });
    desktop = new FakeDesktop();
    TestBed.configureTestingModule({
      providers: [
        { provide: Preferences, useValue: preferences },
        { provide: DesktopPlatform, useValue: desktop },
      ],
    });
    layout = TestBed.inject(SurfaceLayoutService);
  });

  const docked = () => {
    const placement = layout.bottomPanel().placement;
    return isContainedPlacement(placement) && placement.mode === 'docked' && placement.side;
  };
  const savedPlacementHost = () =>
    preferences.value().surfacesLayout?.surfaces.find((surface) => surface.id === id)?.placement
      .host;

  it('opens the safe /bottom-panel path and commits native placement only after it opened', async () => {
    const detached = layout.detachBottomPanel();
    expect(layout.bottomPanelNative()).toBe(false);

    expect(await detached).toBe(true);
    expect(desktop.opens).toEqual([
      { surfaceId: id, kind: 'bottom-panel', path: BOTTOM_PANEL_SURFACE_PATH },
    ]);
    expect(layout.bottomPanelNative()).toBe(true);
    expect(savedPlacementHost()).toBe('native');
    expect(preferences.value().bottomPanelOpen).toBe(true);
  });

  it('leaves the docked panel untouched when the open is refused', async () => {
    desktop.next = { status: 'rejected', reason: 'load-failed:ERR_FAILED' };
    const saved = preferences.value().surfacesLayout;

    expect(await layout.detachBottomPanel()).toBe(false);
    expect(layout.bottomPanelNative()).toBe(false);
    expect(docked()).toBe('bottom');
    expect(preferences.value().surfacesLayout).toBe(saved);
  });

  it('shares one open between overlapping clicks and focuses the window afterwards', async () => {
    await Promise.all([layout.detachBottomPanel(), layout.detachBottomPanel()]);
    expect(desktop.opens).toHaveLength(1);

    desktop.next = { ...desktop.next, status: 'focused' } as NativeSurfaceResult;
    expect(await layout.detachBottomPanel()).toBe(true);
    expect(desktop.opens).toHaveLength(2);
    expect(layout.bottomPanelNative()).toBe(true);
  });

  it('docks back shown on return, ignoring the closing window that follows', async () => {
    await layout.detachBottomPanel();

    desktop.returned({ surfaceId: id });
    desktop.changed({ surfaceId: id, open: false });

    expect(layout.bottomPanelNative()).toBe(false);
    expect(docked()).toBe('bottom');
    expect(preferences.value().bottomPanelOpen).toBe(true);
    expect(savedPlacementHost()).toBe('contained');
  });

  it('docks back hidden when the window is closed', async () => {
    await layout.detachBottomPanel();

    desktop.changed({ surfaceId: id, open: false });

    expect(layout.bottomPanelNative()).toBe(false);
    expect(docked()).toBe('bottom');
    expect(preferences.value().bottomPanelOpen).toBe(false);
  });

  it('ignores other satellites', async () => {
    await layout.detachBottomPanel();

    desktop.changed({ surfaceId: WELL_KNOWN_SURFACE_IDS.livePreviewOutput, open: false });
    desktop.returned({ surfaceId: WELL_KNOWN_SURFACE_IDS.livePreviewOutput });

    expect(layout.bottomPanelNative()).toBe(true);
  });

  it('closes the native window when the panel is hidden from the workspace', async () => {
    await layout.detachBottomPanel();
    TestBed.tick();
    expect(desktop.closes).toEqual([]);

    preferences.patch({ bottomPanelOpen: false });
    TestBed.tick();

    expect(desktop.closes).toEqual([id]);
  });

  it('docks a panel saved as detached back on launch, closing a window a reload left open', async () => {
    await layout.detachBottomPanel();
    expect(savedPlacementHost()).toBe('native');
    expect(desktop.closes).toEqual([]);

    layout.hydrateFromPreferences();

    expect(layout.bottomPanelNative()).toBe(false);
    expect(docked()).toBe('bottom');
    expect(desktop.closes).toEqual([id]);
  });
});

describe('SurfaceLayoutService bottom panel on the web', () => {
  it('never detaches without Electron', async () => {
    TestBed.configureTestingModule({
      providers: [{ provide: Preferences, useValue: new FakePreferences() }],
    });
    const layout = TestBed.inject(SurfaceLayoutService);

    expect(await layout.detachBottomPanel()).toBe(false);
    expect(layout.bottomPanelNative()).toBe(false);
  });
});
