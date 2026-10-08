import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_EDITOR_WINDOW } from '@shadergrove/shared/editor-prefs';
import {
  COMPACT_VIEWPORT_WIDTH,
  DEFAULT_EDITOR_GROUP_ID,
  LAYOUT_VERSION,
  WELL_KNOWN_SURFACE_IDS,
  editorSurfaceId,
  isContainedPlacement,
  migrateLayoutFromPreferences,
} from '@shadergrove/shared/surfaces';
import { DEFAULT_PREVIEW_WINDOW } from '@shadergrove/shared/preview-prefs';
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
  });
});
