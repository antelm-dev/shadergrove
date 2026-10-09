import { computed, inject, Injectable } from '@angular/core';

import { EditorGroups } from './editor-groups';
import type { OpenDocumentsState } from './open-documents-state';

/**
 * Active-group facade over `EditorGroups`.
 *
 * Workspace-level actions (the close, cycle and Ctrl+digit shortcuts, explorer
 * commands) act on the group the user last focused; with one group that is the
 * primary group, as before splits existed.
 */
@Injectable({ providedIn: 'root' })
export class OpenDocuments {
  private readonly groups = inject(EditorGroups);
  private readonly groupId = computed(
    () => this.groups.activeGroupId() ?? this.groups.primaryGroupId,
  );

  readonly openIds = computed(() => this.groups.openIds(this.groupId()));
  readonly openDocs = computed(() => this.groups.openDocs(this.groupId()));
  readonly canClose = computed(() => this.groups.canClose(this.groupId()));

  activate(docId: string): void {
    this.groups.activate(docId, this.groupId());
  }

  close(docId: string): boolean {
    return this.groups.close(docId, this.groupId());
  }

  closeOthers(docId: string): void {
    this.groups.closeOthers(docId, this.groupId());
  }

  reorder(sourceId: string, targetId: string): void {
    this.groups.reorder(sourceId, targetId, this.groupId());
  }

  cycle(step: 1 | -1): void {
    this.groups.cycle(step, this.groupId());
  }

  peekState(): OpenDocumentsState {
    return this.groups.peekState();
  }
}
