import { computed, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  hasUniqueDocumentOwnership,
  openIdsForGroup,
  type ShaderEditorGroups,
} from '@shadergrove/shared/editor-groups';
import {
  DEFAULT_EDITOR_GROUP_ID,
  asEditorGroupId,
  editorLeafIds,
  editorSurfaceId,
  type EditorGroupId,
  type EditorSplitNode,
} from '@shadergrove/shared/surfaces';
import { SurfaceRegistry } from '../../surfaces/surface-registry';
import { ShaderStore, type EditorDocument } from '../../workspace/shader-store';
import { EditorGroupSession } from './editor-group-session';
import { EditorGroups, mergeEditorGroupInto, reconcileShaderGroups } from './editor-groups';

const DEFAULT = DEFAULT_EDITOR_GROUP_ID;
const DEFAULT_SURFACE = editorSurfaceId(DEFAULT);

function doc(id: string): EditorDocument {
  return {
    id,
    kind: 'pass',
    name: id,
    language: 'glsl',
    source: `// ${id}`,
    passKind: 'buffer',
    enabled: true,
  } as EditorDocument;
}

/** Two shaders with three documents each; the store's pick is per shader. */
class TabStore {
  readonly selectedId = signal<string | null>('waves');
  readonly byShader: Record<string, EditorDocument[]> = {
    waves: [doc('image'), doc('buffer'), doc('common')],
    tunnel: [doc('t-image'), doc('t-buffer'), doc('t-common')],
  };
  readonly picks = signal<Record<string, string>>({ waves: 'image', tunnel: 't-image' });

  readonly documents = computed(() => this.byShader[this.selectedId() ?? ''] ?? []);
  readonly activeDoc = computed(
    () =>
      this.documents().find((d) => d.id === this.picks()[this.selectedId() ?? '']) ??
      this.documents()[0] ??
      null,
  );

  asShaderStore(): ShaderStore {
    return {
      selectedId: this.selectedId.asReadonly(),
      documents: this.documents,
      activeDoc: this.activeDoc,
      selectDoc: (id: string) =>
        this.picks.update((picks) => ({ ...picks, [this.selectedId()!]: id })),
    } as unknown as ShaderStore;
  }
}

describe('EditorGroups service', () => {
  let tabs: TabStore;
  let groups: EditorGroups;
  let registry: SurfaceRegistry;
  let session: EditorGroupSession;

  beforeEach(() => {
    tabs = new TabStore();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: ShaderStore, useValue: tabs.asShaderStore() },
        EditorGroupSession,
        EditorGroups,
      ],
    });
    groups = TestBed.inject(EditorGroups);
    registry = TestBed.inject(SurfaceRegistry);
    session = TestBed.inject(EditorGroupSession);
    TestBed.tick();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  const shaderGroups = (shader = 'waves') => groups.peekState().get(shader)!;

  it('creates a visible secondary group and moves a tab into it', () => {
    groups.activate('buffer');
    TestBed.tick();

    const groupB = groups.createGroup({ activate: true })!;
    expect(groupB).toBe(asEditorGroupId('editor-group:1'));
    expect(groups.visibleGroupIds()).toEqual([DEFAULT, groupB]);
    expect(groups.moveDocument('buffer', groupB, { sourceGroupId: DEFAULT })).toBe(true);
    TestBed.tick();

    expect(groups.openIds(DEFAULT)).toEqual(['image']);
    expect(groups.openIds(groupB)).toEqual(['buffer']);
    expect(groups.ownerGroupId('buffer')).toBe(groupB);
  });

  describe('split', () => {
    it('moves the active tab into a new sibling group that takes focus (split right)', () => {
      groups.activate('buffer');
      TestBed.tick();

      const created = groups.split('horizontal')!;
      TestBed.tick();

      const tree = registry.editorLayout() as EditorSplitNode;
      expect(tree.kind).toBe('split');
      expect(tree.axis).toBe('horizontal');
      expect(editorLeafIds(tree)).toEqual([DEFAULT_SURFACE, editorSurfaceId(created)]);
      expect(registry.get(editorSurfaceId(created))?.chrome).toEqual({
        kind: 'editor',
        editorGroupId: created,
      });
      expect(groups.openIds(DEFAULT)).toEqual(['image']);
      expect(groups.openIds(created)).toEqual(['buffer']);
      expect(groups.activeGroupId()).toBe(created);
      expect(groups.pendingFocus()).toBe(created);
      expect(tabs.activeDoc()?.id).toBe('buffer');
    });

    it('keeps a free document in a group whose only tab moves out (split down)', () => {
      const created = groups.split('vertical')!;
      TestBed.tick();

      expect((registry.editorLayout() as EditorSplitNode).axis).toBe('vertical');
      expect(groups.openIds(created)).toEqual(['image']);
      expect(groups.openIds(DEFAULT)).toEqual(['buffer']);
      expect(hasUniqueDocumentOwnership(shaderGroups())).toBe(true);
    });

    it('records where the moved document was for the group it moves to', () => {
      session.registerViewSource(DEFAULT, (id) => ({ scrollTop: id.length }));
      groups.split('horizontal');

      expect(session.viewTransfer('image')?.viewState).toEqual({ scrollTop: 5 });
    });

    it('rolls back to nothing when a step fails', () => {
      const snapshot = () => ({
        state: groups.peekState(),
        tree: registry.editorLayout(),
        surfaces: registry.surfaces(),
      });
      let before = snapshot();
      // The document is not the source group's.
      expect(groups.split('horizontal', DEFAULT, 'common')).toBeNull();
      expect(snapshot()).toEqual(before);
      expect(groups.peekState()).toBe(before.state);

      // Moving the source's only tab out needs a free document to keep, and none is left.
      groups.activate('buffer');
      TestBed.tick();
      const right = groups.split('horizontal')!;
      groups.activate('common', DEFAULT);
      TestBed.tick();
      before = snapshot();
      expect(groups.split('vertical', right, 'buffer')).toBeNull();
      expect(groups.peekState()).toBe(before.state);
      expect(registry.editorLayout()).toBe(before.tree);
      expect(registry.surfaces()).toEqual(before.surfaces);
      expect(groups.pendingFocus()).toBe(right);
    });

    it('refuses a split beyond two nested levels, changing nothing', () => {
      const second = groups.split('horizontal')!;
      const third = groups.split('vertical', second)!;
      TestBed.tick();
      expect(third).not.toBeNull();
      const state = groups.peekState();
      const tree = registry.editorLayout();

      expect(groups.canSplit(third)).toBe(false);
      expect(groups.split('horizontal', third)).toBeNull();
      expect(groups.peekState()).toBe(state);
      expect(registry.editorLayout()).toBe(tree);
    });

    it('turns "Move to new group" into a visible split', () => {
      groups.activate('buffer');
      TestBed.tick();

      expect(groups.moveToNewGroup('buffer')).toBe(true);
      expect(groups.visibleGroupIds()).toHaveLength(2);
      expect(groups.ownerGroupId('buffer')).toBe(groups.visibleGroupIds()[1]);
    });
  });

  describe('closing a group', () => {
    it('merges its tabs after the adjacent group and keeps that group active tab', () => {
      groups.activate('buffer');
      TestBed.tick();
      const right = groups.split('horizontal')!;
      groups.activate('common', right);
      TestBed.tick();
      // Left: image; right: buffer, common (common active).
      groups.activate('image', DEFAULT);

      expect(groups.closeGroup(right)).toBe(true);
      TestBed.tick();

      expect(groups.visibleGroupIds()).toEqual([DEFAULT]);
      expect(groups.openIds(DEFAULT)).toEqual(['image', 'buffer', 'common']);
      expect(groups.activeDocumentId(DEFAULT)).toBe('image');
      expect(registry.get(editorSurfaceId(right))).toBeUndefined();
      expect(registry.editorLayout()).toEqual({ kind: 'leaf', surfaceId: DEFAULT_SURFACE });
    });

    it('keeps the primary identity in the neighbour position when the primary closes', () => {
      groups.activate('buffer');
      TestBed.tick();
      const right = groups.split('horizontal')!;
      const below = groups.split('vertical', right)!;
      TestBed.tick();
      const before = editorLeafIds(registry.editorLayout());
      expect(before).toEqual([DEFAULT_SURFACE, editorSurfaceId(right), editorSurfaceId(below)]);
      const rightTabs = groups.openIds(right);
      const primaryTabs = groups.openIds(DEFAULT);

      expect(groups.closeGroup(DEFAULT)).toBe(true);
      TestBed.tick();

      // The primary now stands where "right" was, holding right's tabs then its own.
      expect(editorLeafIds(registry.editorLayout())).toEqual([
        DEFAULT_SURFACE,
        editorSurfaceId(below),
      ]);
      expect(groups.openIds(DEFAULT)).toEqual([...rightTabs, ...primaryTabs]);
      expect(registry.get(editorSurfaceId(right))).toBeUndefined();
      expect(hasUniqueDocumentOwnership(shaderGroups())).toBe(true);
    });

    it('rejects closing the last group', () => {
      expect(groups.closeGroup(DEFAULT)).toBe(false);
      expect(groups.canCloseGroup()).toBe(false);
    });

    it('closes a group its last tab is moved out of', () => {
      groups.activate('buffer');
      TestBed.tick();
      const right = groups.split('horizontal')!;
      TestBed.tick();

      expect(groups.moveDocument('buffer', DEFAULT)).toBe(true);
      expect(groups.visibleGroupIds()).toEqual([DEFAULT]);
      expect(groups.groupIds()).not.toContain(right);
    });
  });

  it('reconciles every shown group on a shader switch without duplicate ownership', () => {
    groups.activate('buffer');
    TestBed.tick();
    const right = groups.split('vertical')!;
    TestBed.tick();

    tabs.selectedId.set('tunnel');
    TestBed.tick();
    const tunnel = shaderGroups('tunnel');
    expect(tunnel.groups.map((group) => group.id)).toEqual([DEFAULT, right]);
    expect(tunnel.groups.every((group) => group.documentIds.length === 1)).toBe(true);
    expect(hasUniqueDocumentOwnership(tunnel)).toBe(true);

    tabs.selectedId.set('waves');
    TestBed.tick();
    expect(groups.openIds(DEFAULT)).toEqual(['image']);
    expect(groups.openIds(right)).toEqual(['buffer']);
  });

  it('commits a split ratio, clamped by the layout contract', () => {
    groups.split('horizontal');
    const tree = registry.editorLayout() as EditorSplitNode;

    expect(groups.commitRatio(tree.id, 0.95)).toBe(true);
    expect((registry.editorLayout() as EditorSplitNode).ratio).toBe(0.8);
  });

  it('activating a group brings the store to its document', () => {
    groups.activate('buffer');
    TestBed.tick();
    const right = groups.split('horizontal')!;
    TestBed.tick();

    groups.activateGroup(DEFAULT);
    expect(tabs.activeDoc()?.id).toBe('image');
    groups.activateGroup(right);
    expect(tabs.activeDoc()?.id).toBe('buffer');
  });

  it('opens a document another group holds in that group', () => {
    groups.activate('buffer');
    TestBed.tick();
    const right = groups.split('horizontal')!;
    TestBed.tick();

    groups.activate('buffer', DEFAULT);
    expect(groups.openIds(DEFAULT)).toEqual(['image']);
    expect(groups.activeGroupId()).toBe(right);
  });
});

describe('reconcileShaderGroups', () => {
  const G1 = asEditorGroupId('editor-group:1');
  const G2 = asEditorGroupId('editor-group:2');
  const shader = (groups: ShaderEditorGroups['groups'], active: EditorGroupId = DEFAULT) =>
    new Map([['s', { groups, primaryGroupId: DEFAULT, activeGroupId: active }]]);
  const group = (id: EditorGroupId, documentIds: string[], active = documentIds[0] ?? null) => ({
    id,
    documentIds,
    activeDocumentId: active,
    presentation: 'full' as const,
  });

  it('creates missing slots, seeds them, folds hidden groups and prunes stale tabs', () => {
    const state = shader([group(DEFAULT, ['a', 'gone']), group(G2, ['c'])]);
    const next = reconcileShaderGroups(state, 's', {
      visible: [DEFAULT, G1],
      documentIds: ['a', 'b', 'c'],
      activeId: 'a',
    });
    const result = next.get('s')!;

    expect(result.groups).toEqual([group(DEFAULT, ['a', 'c'], 'a'), group(G1, ['b'])]);
    expect(hasUniqueDocumentOwnership(result)).toBe(true);
  });

  it('returns the same state when nothing changes', () => {
    const state = shader([group(DEFAULT, ['a']), group(G1, ['b'])]);
    expect(
      reconcileShaderGroups(state, 's', {
        visible: [DEFAULT, G1],
        documentIds: ['a', 'b'],
        activeId: 'a',
      }),
    ).toBe(state);
  });

  it('opens the store document in the active group when no group holds it', () => {
    const state = shader([group(DEFAULT, ['a']), group(G1, ['b'])], G1);
    const result = reconcileShaderGroups(state, 's', {
      visible: [DEFAULT, G1],
      documentIds: ['a', 'b', 'new'],
      activeId: 'new',
    }).get('s')!;

    expect(openIdsForGroup(new Map([['s', result]]), 's', G1)).toEqual(['b', 'new']);
    expect(result.activeGroupId).toBe(G1);
  });
});

describe('mergeEditorGroupInto', () => {
  const G1 = asEditorGroupId('editor-group:1');
  it('puts the target tabs first and names the merged group after the survivor', () => {
    const merged = mergeEditorGroupInto(
      {
        groups: [
          { id: DEFAULT, documentIds: ['a', 'b'], activeDocumentId: 'b', presentation: 'full' },
          { id: G1, documentIds: ['c'], activeDocumentId: 'c', presentation: 'full' },
        ],
        primaryGroupId: DEFAULT,
        activeGroupId: DEFAULT,
      },
      DEFAULT,
      G1,
      DEFAULT,
    );

    expect(merged.groups).toEqual([
      { id: DEFAULT, documentIds: ['c', 'a', 'b'], activeDocumentId: 'c', presentation: 'full' },
    ]);
    expect(merged.activeGroupId).toBe(DEFAULT);
  });
});
