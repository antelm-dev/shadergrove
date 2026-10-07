import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  LAYOUT_VERSION,
  WELL_KNOWN_SURFACE_IDS,
  createDefaultSurface,
  editorSurfaceId,
  asEditorGroupId,
} from '@shadergrove/shared/surfaces';

import { SURFACE_STACK_Z_BASE, SurfaceRegistry } from './surface-registry';

describe('SurfaceRegistry', () => {
  let registry: SurfaceRegistry;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    registry = TestBed.inject(SurfaceRegistry);
  });

  it('hydrates surfaces and preserves z-order for known ids', () => {
    const preview = createDefaultSurface('preview', {
      placement: {
        host: 'contained',
        mode: 'floating',
        rect: { x: 10, y: 10, width: 400, height: 300 },
      },
    });
    const editor = createDefaultSurface('editor', {
      placement: {
        host: 'contained',
        mode: 'floating',
        rect: { x: 40, y: 40, width: 500, height: 400 },
      },
    });

    registry.hydrate({
      version: 1,
      surfaces: [preview, editor],
      zOrder: [preview.id, editor.id],
    });

    expect(registry.get(WELL_KNOWN_SURFACE_IDS.preview)?.kind).toBe('preview');
    expect(registry.zOrder().slice(0, 2)).toEqual([preview.id, editor.id]);
    expect(registry.foreground()).toBe(editor.id);
  });

  it('brings the most recently activated stacked surface to the foreground', () => {
    const preview = createDefaultSurface('preview', {
      placement: {
        host: 'contained',
        mode: 'floating',
        rect: { x: 0, y: 0, width: 400, height: 300 },
      },
    });
    const editor = createDefaultSurface('editor', {
      placement: {
        host: 'contained',
        mode: 'floating',
        rect: { x: 20, y: 20, width: 500, height: 400 },
      },
    });
    registry.upsert(preview);
    registry.upsert(editor);

    registry.activate(editor.id);
    expect(registry.foreground()).toBe(editor.id);
    expect(registry.zIndex(editor.id)!).toBeGreaterThan(registry.zIndex(preview.id)!);

    registry.activate(preview.id);
    expect(registry.foreground()).toBe(preview.id);
    expect(registry.zIndex(preview.id)!).toBeGreaterThan(registry.zIndex(editor.id)!);
    expect(registry.zIndex(preview.id)).toBeGreaterThanOrEqual(SURFACE_STACK_Z_BASE);
  });

  it('ignores activation for docked and stage surfaces', () => {
    const stage = createDefaultSurface('preview', {
      placement: { host: 'contained', mode: 'stage' },
    });
    const docked = createDefaultSurface('editor', {
      placement: { host: 'contained', mode: 'docked', side: 'bottom', size: 320 },
    });
    registry.upsert(stage);
    registry.upsert(docked);

    registry.activate(stage.id);
    registry.activate(docked.id);

    expect(registry.foreground()).toBeNull();
    expect(registry.zIndex(stage.id)).toBeNull();
    expect(registry.zIndex(docked.id)).toBeNull();
  });

  it('counts open editor groups for close guards', () => {
    const a = createDefaultSurface('editor', {
      id: editorSurfaceId(asEditorGroupId('editor-group:a')),
      chrome: { kind: 'editor', editorGroupId: asEditorGroupId('editor-group:a') },
    });
    const b = createDefaultSurface('editor', {
      id: editorSurfaceId(asEditorGroupId('editor-group:b')),
      chrome: { kind: 'editor', editorGroupId: asEditorGroupId('editor-group:b') },
      open: false,
    });
    registry.upsert(a);
    registry.upsert(b);
    expect(registry.openEditorGroupCount()).toBe(1);
  });

  it('snapshots layout preferences without browser globals', () => {
    registry.ensure('preview');
    const snap = registry.snapshot();
    expect(snap.version).toBe(LAYOUT_VERSION);
    expect(snap.surfaces.some((s) => s.kind === 'preview')).toBe(true);
  });
});
