import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';

import {
  activateEditorGroup,
  activeDocumentForGroup,
  closeDocumentInGroup,
  closeOtherDocumentsInGroup,
  editorGroupIdsFor,
  emptyEditorGroupsState,
  ensureShaderGroups,
  groupOwningDocumentFor,
  moveDocumentBetweenGroups,
  openDocumentInGroup,
  openIdsForGroup,
  reorderDocumentInGroup,
  selectDocumentInGroup,
  shaderEditorGroupsFor,
  type EditorDocumentViewTransfer,
  type EditorGroupPresentation,
  type EditorGroupRecord,
  type EditorGroupsState,
  type ShaderEditorGroups,
} from '@shadergrove/shared/editor-groups';
import {
  DEFAULT_EDITOR_GROUP_ID,
  asEditorGroupId,
  commitSplitRatio,
  createDefaultSurface,
  editorLeafIds,
  editorSurfaceId,
  findAdjacentEditorLeaf,
  hasEditorLeaf,
  removeEditorLeaf,
  replaceEditorLeaf,
  splitEditorLeaf,
  type EditorGroupId,
  type EditorLayoutNode,
  type SplitAxis,
  type SplitNodeId,
  type SurfaceId,
} from '@shadergrove/shared/surfaces';

import { SurfaceRegistry } from '../../surfaces/surface-registry';
import { ShaderStore, type EditorDocument } from '../../workspace/shader-store';
import { EditorGroupSession } from './editor-group-session';

/**
 * How deep a leaf may sit and still be split: the milestone shows at most two
 * nested splits; deeper nesting is deferred with split management.
 */
export const MAX_EDITOR_SPLIT_DEPTH = 2;

interface GroupSlot {
  id: EditorGroupId;
  documentIds: string[];
  activeDocumentId: string | null;
  presentation: EditorGroupPresentation;
}

interface OpenedSlot {
  groupId: EditorGroupId;
  surfaceId: SurfaceId;
  layout: EditorLayoutNode;
}

/** Distance of a leaf from the root, or -1 when the tree does not hold it. */
export function editorLeafDepth(node: EditorLayoutNode, surfaceId: SurfaceId, depth = 0): number {
  if (node.kind === 'leaf') return node.surfaceId === surfaceId ? depth : -1;
  const first = editorLeafDepth(node.first, surfaceId, depth + 1);
  return first >= 0 ? first : editorLeafDepth(node.second, surfaceId, depth + 1);
}

/**
 * Bring one shader's groups in line with the editor slots the workspace shows.
 * Groups no slot shows fold their tabs into the primary group; every shown slot
 * gets a group; the store's document is shown where a group holds it, or opens
 * in the active group; an empty slot takes a document no group holds yet. A
 * document stays in at most one group. Returns `state` itself when nothing changes.
 */
export function reconcileShaderGroups(
  state: EditorGroupsState,
  shaderId: string,
  input: {
    readonly visible: readonly EditorGroupId[];
    readonly documentIds: readonly string[];
    readonly activeId: string;
  },
): EditorGroupsState {
  const seeded = ensureShaderGroups(state, shaderId, input.activeId);
  const current = seeded.get(shaderId)!;
  const primary = current.primaryGroupId;
  const live = new Set(input.documentIds);
  const shown = new Set([primary, ...input.visible]);

  const slots: GroupSlot[] = current.groups.map((group) => ({
    ...group,
    documentIds: group.documentIds.filter((id) => live.has(id)),
  }));
  const primarySlot = slots.find((slot) => slot.id === primary);
  for (const hidden of slots.filter((slot) => !shown.has(slot.id))) {
    for (const id of hidden.documentIds) {
      if (primarySlot && !primarySlot.documentIds.includes(id)) primarySlot.documentIds.push(id);
    }
  }
  const kept = slots.filter((slot) => shown.has(slot.id));
  for (const id of input.visible) {
    if (!kept.some((slot) => slot.id === id)) {
      kept.push({ id, documentIds: [], activeDocumentId: null, presentation: 'full' });
    }
  }
  const owner = (docId: string) => kept.find((slot) => slot.documentIds.includes(docId));

  let activeGroupId = shown.has(current.activeGroupId) ? current.activeGroupId : primary;
  if (live.has(input.activeId)) {
    const holder = owner(input.activeId) ?? kept.find((slot) => slot.id === activeGroupId);
    if (holder) {
      if (!holder.documentIds.includes(input.activeId)) holder.documentIds.push(input.activeId);
      holder.activeDocumentId = input.activeId;
      activeGroupId = holder.id;
    }
  }
  for (const slot of kept) {
    if (slot.documentIds.length === 0) {
      const free = input.documentIds.find((id) => !owner(id));
      if (free) slot.documentIds.push(free);
    }
    if (!slot.activeDocumentId || !slot.documentIds.includes(slot.activeDocumentId)) {
      slot.activeDocumentId = slot.documentIds[0] ?? null;
    }
  }

  const next: ShaderEditorGroups = { ...current, groups: kept, activeGroupId };
  if (JSON.stringify(next) === JSON.stringify(current)) return seeded;
  return new Map(seeded).set(shaderId, next);
}

/**
 * Close `source` into `target`: the target's tabs first, then the source's,
 * with the target's active tab kept. The merged group is called `survivor` —
 * the source itself when it is the primary group, which frames the split.
 */
export function mergeEditorGroupInto(
  shaderGroups: ShaderEditorGroups,
  source: EditorGroupId,
  target: EditorGroupId,
  survivor: EditorGroupId,
): ShaderEditorGroups {
  const from = shaderGroups.groups.find((group) => group.id === source);
  if (!from) return shaderGroups;
  const into = shaderGroups.groups.find((group) => group.id === target);
  const head = into?.documentIds ?? [];
  const documentIds = [...head, ...from.documentIds.filter((id) => !head.includes(id))];
  const merged: EditorGroupRecord = {
    id: survivor,
    documentIds,
    activeDocumentId: into?.activeDocumentId ?? from.activeDocumentId ?? documentIds[0] ?? null,
    presentation: (into ?? from).presentation,
  };
  const groups = shaderGroups.groups.flatMap((group) => {
    if (group.id === survivor) return [merged];
    return group.id === source || group.id === target ? [] : [group];
  });
  if (!groups.includes(merged)) groups.push(merged);
  const activeGroupId =
    shaderGroups.activeGroupId === source || shaderGroups.activeGroupId === target
      ? survivor
      : shaderGroups.activeGroupId;
  return { ...shaderGroups, groups, activeGroupId };
}

/**
 * Shader-scoped editor groups: ordered tabs, active document, and ownership
 * per group, reconciled to the contained split's leaves. The primary group is
 * the default editor surface, which frames the whole split.
 */
@Injectable({ providedIn: 'root' })
export class EditorGroups {
  readonly primaryGroupId = DEFAULT_EDITOR_GROUP_ID;

  private readonly store = inject(ShaderStore);
  private readonly session = inject(EditorGroupSession);
  private readonly registry = inject(SurfaceRegistry);
  private readonly state = signal<EditorGroupsState>(emptyEditorGroupsState());
  private readonly focusRequest = signal<EditorGroupId | null>(null);

  readonly groupIds = computed(() => editorGroupIdsFor(this.state(), this.store.selectedId()));

  /**
   * The groups the contained split shows, in reading order: one per leaf of the
   * workspace's split tree. Workspace-wide; every shader is reconciled to it.
   */
  readonly visibleGroupIds = computed<readonly EditorGroupId[]>(() => {
    const ids = editorLeafIds(this.registry.editorLayout())
      .map((surfaceId) => this.groupForSurface(surfaceId))
      .filter((id): id is EditorGroupId => id !== null);
    return ids.length > 0 ? ids : [this.primaryGroupId];
  });

  readonly activeGroupId = computed(
    () => shaderEditorGroupsFor(this.state(), this.store.selectedId())?.activeGroupId ?? null,
  );

  readonly canCloseGroup = computed(() => this.visibleGroupIds().length > 1);

  /** A group whose editor should take focus once it is on screen (after a split). */
  readonly pendingFocus = this.focusRequest.asReadonly();

  constructor() {
    effect(() => {
      const shaderId = this.store.selectedId();
      const documents = this.store.documents();
      const activeId = this.store.activeDoc()?.id ?? null;
      const visible = this.visibleGroupIds();

      if (!shaderId || !activeId || documents.length === 0) return;

      untracked(() => {
        this.state.update((current) =>
          reconcileShaderGroups(current, shaderId, {
            visible,
            documentIds: documents.map((doc) => doc.id),
            activeId,
          }),
        );
      });
    });
  }

  openIds(groupId: EditorGroupId = this.primaryGroupId): readonly string[] {
    return openIdsForGroup(this.state(), this.store.selectedId(), groupId);
  }

  activeDocumentId(groupId: EditorGroupId = this.primaryGroupId): string | null {
    return activeDocumentForGroup(this.state(), this.store.selectedId(), groupId);
  }

  openDocs(groupId: EditorGroupId = this.primaryGroupId): readonly EditorDocument[] {
    const byId = new Map(this.store.documents().map((doc) => [doc.id, doc]));
    return this.openIds(groupId)
      .map((id) => byId.get(id))
      .filter((doc): doc is EditorDocument => doc !== undefined);
  }

  canClose(groupId: EditorGroupId = this.primaryGroupId): boolean {
    return this.openIds(groupId).length > 1;
  }

  presentation(groupId: EditorGroupId = this.primaryGroupId): EditorGroupPresentation {
    const shaderGroups = shaderEditorGroupsFor(this.state(), this.store.selectedId());
    return shaderGroups?.groups.find((group) => group.id === groupId)?.presentation ?? 'full';
  }

  ownerGroupId(documentId: string): EditorGroupId | null {
    const shaderId = this.store.selectedId();
    if (!shaderId) return null;
    return groupOwningDocumentFor(this.state(), shaderId, documentId);
  }

  /** 1-based position of a shown group, for "Source editor N"; 0 when not shown. */
  groupNumber(groupId: EditorGroupId): number {
    return this.visibleGroupIds().indexOf(groupId) + 1;
  }

  /** Whether a group's slot can take another split, with a shader open to fill it. */
  canSplit(groupId: EditorGroupId = this.anchorGroupId()): boolean {
    if (!this.store.selectedId()) return false;
    const depth = editorLeafDepth(this.registry.editorLayout(), editorSurfaceId(groupId));
    return depth >= 0 && depth < MAX_EDITOR_SPLIT_DEPTH;
  }

  clearFocusRequest(): void {
    this.focusRequest.set(null);
  }

  /** Focus moves to a group: it becomes active, and the store follows its document. */
  activateGroup(groupId: EditorGroupId): void {
    const shaderId = this.store.selectedId();
    if (!shaderId) return;
    this.state.update((current) => {
      const result = activateEditorGroup(current, shaderId, groupId);
      return result.ok ? result.state : current;
    });
    const active = this.activeDocumentId(groupId);
    if (active && this.store.activeDoc()?.id !== active) this.store.selectDoc(active);
  }

  /** Show a document: in the group that already holds it, else opened in `groupId`. */
  activate(docId: string, groupId: EditorGroupId = this.primaryGroupId): void {
    const shaderId = this.store.selectedId();
    if (!shaderId) return;
    const target = this.ownerGroupId(docId) ?? groupId;

    this.state.update((current) => {
      let next = openDocumentInGroup(current, shaderId, target, docId);
      next = selectDocumentInGroup(next, shaderId, target, docId);
      return next;
    });
    this.session.claimForGroup(target, docId);
    this.store.selectDoc(docId);
  }

  close(docId: string, groupId: EditorGroupId = this.primaryGroupId): boolean {
    const shaderId = this.store.selectedId();
    if (!shaderId) return false;

    const activeId = this.store.activeDoc()?.id ?? null;
    const { state: next, result } = closeDocumentInGroup(this.state(), shaderId, groupId, docId);
    if (!result.closed) return false;

    this.state.set(next);
    if (activeId === docId && result.nextActiveHint) {
      this.store.selectDoc(result.nextActiveHint);
    }
    return true;
  }

  closeOthers(docId: string, groupId: EditorGroupId = this.primaryGroupId): void {
    const shaderId = this.store.selectedId();
    if (!shaderId) return;

    this.state.update((current) => closeOtherDocumentsInGroup(current, shaderId, groupId, docId));
    this.store.selectDoc(docId);
  }

  reorder(sourceId: string, targetId: string, groupId: EditorGroupId = this.primaryGroupId): void {
    const shaderId = this.store.selectedId();
    if (!shaderId) return;
    this.state.update((current) =>
      reorderDocumentInGroup(current, shaderId, groupId, sourceId, targetId),
    );
  }

  cycle(step: 1 | -1, groupId: EditorGroupId = this.primaryGroupId): void {
    const ids = this.openIds(groupId);
    if (ids.length === 0) return;

    const activeId = this.store.activeDoc()?.id ?? null;
    const current = ids.findIndex((id) => id === activeId);
    const index = current < 0 ? 0 : (current + step + ids.length) % ids.length;
    this.activate(ids[index]!, groupId);
  }

  /**
   * A new, empty group shown beside `besideGroupId` (split right). The next
   * reconciliation gives it a document when nothing is moved into it.
   */
  createGroup(
    options: {
      presentation?: EditorGroupPresentation;
      activate?: boolean;
      besideGroupId?: EditorGroupId;
    } = {},
  ): EditorGroupId | null {
    const shaderId = this.store.selectedId();
    if (!shaderId) return null;
    const slot = this.openSlot('horizontal', options.besideGroupId ?? this.anchorGroupId());
    if (!slot) return null;

    const next = this.withGroup(this.state(), shaderId, slot.groupId, options.presentation);
    this.commitSlot(slot);
    this.state.set(next);
    if (options.activate) this.activateGroup(slot.groupId);
    return slot.groupId;
  }

  /**
   * Split a group's slot (right for `horizontal`, down for `vertical`) and move
   * one of its documents, the active one by default, into the new group, which
   * takes focus. All or nothing: each step is computed before anything is
   * committed, so a refusal leaves groups, surfaces and the tree untouched.
   */
  split(
    axis: SplitAxis,
    sourceGroupId: EditorGroupId = this.anchorGroupId(),
    documentId: string | null = this.activeDocumentId(sourceGroupId),
  ): EditorGroupId | null {
    const shaderId = this.store.selectedId();
    if (!shaderId || !documentId || this.ownerGroupId(documentId) !== sourceGroupId) return null;
    const slot = this.openSlot(axis, sourceGroupId);
    if (!slot) return null;

    let next = this.withGroup(this.state(), shaderId, slot.groupId);
    // Moving the last tab out would leave a blank slot, so the group keeps a free document.
    if (this.openIds(sourceGroupId).length === 1) {
      const free = this.store.documents().find((doc) => !this.ownerGroupId(doc.id));
      if (!free) return null;
      next = openDocumentInGroup(next, shaderId, sourceGroupId, free.id);
    }
    const moved = moveDocumentBetweenGroups(next, shaderId, documentId, slot.groupId, {
      sourceGroupId,
    });
    if (!moved.ok) return null;

    this.session.captureViewTransfer(sourceGroupId, documentId);
    this.commitSlot(slot);
    this.state.set(moved.state);
    this.store.selectDoc(documentId);
    this.focusRequest.set(slot.groupId);
    return slot.groupId;
  }

  /**
   * Close a shown group: its tabs merge into the adjacent group (the target's
   * tabs first, its active tab kept), then the group, its surface and its leaf
   * go. The last group cannot close. The primary group frames the split, so
   * closing it keeps its identity in the neighbour's place and retires the
   * neighbour's instead.
   */
  closeGroup(groupId: EditorGroupId): boolean {
    const layout = this.registry.editorLayout();
    const surfaceId = editorSurfaceId(groupId);
    const adjacent = findAdjacentEditorLeaf(layout, surfaceId);
    if (!adjacent.ok) return false;
    const target = this.groupForSurface(adjacent.surfaceId);
    if (!target) return false;

    const survivor = groupId === this.primaryGroupId ? groupId : target;
    const retired = survivor === groupId ? target : groupId;
    const removed = removeEditorLeaf(layout, surfaceId);
    if (!removed.ok) return false;
    let tree = removed.layout;
    if (survivor === groupId) {
      const replaced = replaceEditorLeaf(tree, adjacent.surfaceId, surfaceId);
      if (!replaced.ok) return false;
      tree = replaced.layout;
    }

    // The retired group's editor goes away; where its documents were moves with them.
    for (const docId of this.openIds(retired)) this.session.captureViewTransfer(retired, docId);
    const next = new Map<string, ShaderEditorGroups>();
    for (const [shaderId, shaderGroups] of this.state()) {
      next.set(shaderId, mergeEditorGroupInto(shaderGroups, groupId, target, survivor));
    }
    this.state.set(next);
    this.registry.remove(editorSurfaceId(retired));
    this.registry.setEditorLayout(tree);

    const active = this.activeDocumentId(survivor);
    if (active) this.store.selectDoc(active);
    return true;
  }

  /** Store a committed split ratio, clamped by the layout contract. */
  commitRatio(splitId: SplitNodeId, ratio: number): boolean {
    const result = commitSplitRatio(this.registry.editorLayout(), splitId, ratio);
    if (!result.ok) return false;
    this.registry.setEditorLayout(result.layout);
    return true;
  }

  moveDocument(
    documentId: string,
    targetGroupId: EditorGroupId,
    options: {
      sourceGroupId?: EditorGroupId;
      index?: number;
      transfer?: EditorDocumentViewTransfer | null;
    } = {},
  ): boolean {
    const shaderId = this.store.selectedId();
    if (!shaderId) return false;
    const sourceGroupId = options.sourceGroupId ?? this.ownerGroupId(documentId);

    const result = moveDocumentBetweenGroups(
      this.state(),
      shaderId,
      documentId,
      targetGroupId,
      options,
    );
    if (!result.ok) return false;

    if (options.transfer?.viewState) {
      this.session.recordViewTransfer(options.transfer);
    } else if (sourceGroupId) {
      this.session.captureViewTransfer(sourceGroupId, documentId);
    }
    this.state.set(result.state);
    this.session.moveToGroup(documentId, targetGroupId, options.transfer?.viewState ?? null);
    this.activate(documentId, targetGroupId);

    // A group its last tab left closes, as editor groups do.
    if (
      sourceGroupId &&
      sourceGroupId !== this.primaryGroupId &&
      this.openIds(sourceGroupId).length === 0
    ) {
      this.closeGroup(sourceGroupId);
    }
    return true;
  }

  /** "Move to new group": a split to the right of the document's group, holding it. */
  moveToNewGroup(documentId: string, groupId?: EditorGroupId): boolean {
    if (groupId) return this.moveDocument(documentId, groupId);
    const source = this.ownerGroupId(documentId) ?? this.anchorGroupId();
    return this.split('horizontal', source, documentId) !== null;
  }

  otherGroupIds(groupId: EditorGroupId = this.primaryGroupId): readonly EditorGroupId[] {
    return this.visibleGroupIds().filter((id) => id !== groupId);
  }

  peekState(): EditorGroupsState {
    return this.state();
  }

  /** The active group when it is shown, else the primary group. */
  private anchorGroupId(): EditorGroupId {
    const active = this.activeGroupId();
    return active && this.visibleGroupIds().includes(active) ? active : this.primaryGroupId;
  }

  /** The group a split leaf shows: its surface chrome, or the primary group for the default surface. */
  groupForSurface(surfaceId: SurfaceId): EditorGroupId | null {
    const chrome = this.registry.get(surfaceId)?.chrome;
    if (chrome?.kind === 'editor') return chrome.editorGroupId;
    return surfaceId === editorSurfaceId(this.primaryGroupId) ? this.primaryGroupId : null;
  }

  /** A fresh group id, its surface id and the split tree for splitting `source`; commits nothing. */
  private openSlot(axis: SplitAxis, source: EditorGroupId): OpenedSlot | null {
    if (!this.canSplit(source)) return null;
    const layout = this.registry.editorLayout();
    const taken = (id: EditorGroupId) =>
      this.groupIds().includes(id) ||
      this.registry.get(editorSurfaceId(id)) !== undefined ||
      hasEditorLeaf(layout, editorSurfaceId(id));
    let n = 1;
    while (taken(asEditorGroupId(`editor-group:${n}`))) n += 1;
    const groupId = asEditorGroupId(`editor-group:${n}`);
    const surfaceId = editorSurfaceId(groupId);
    const result = splitEditorLeaf(layout, editorSurfaceId(source), surfaceId, axis);
    return result.ok ? { groupId, surfaceId, layout: result.layout } : null;
  }

  private commitSlot(slot: OpenedSlot): void {
    this.registry.upsert(
      createDefaultSurface('editor', {
        id: slot.surfaceId,
        chrome: { kind: 'editor', editorGroupId: slot.groupId },
      }),
    );
    this.registry.setEditorLayout(slot.layout);
  }

  private withGroup(
    state: EditorGroupsState,
    shaderId: string,
    groupId: EditorGroupId,
    presentation: EditorGroupPresentation = 'full',
  ): EditorGroupsState {
    const shaderGroups = state.get(shaderId);
    if (!shaderGroups || shaderGroups.groups.some((group) => group.id === groupId)) return state;
    const group: EditorGroupRecord = {
      id: groupId,
      documentIds: [],
      activeDocumentId: null,
      presentation,
    };
    return new Map(state).set(shaderId, {
      ...shaderGroups,
      groups: [...shaderGroups.groups, group],
    });
  }
}
