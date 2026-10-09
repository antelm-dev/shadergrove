import { Injectable, signal } from '@angular/core';

import {
  buildClaimOwnershipCommand,
  buildMoveDocumentCommand,
  buildReleaseOwnershipCommand,
  editorGroupClientId,
  type EditorDocumentViewTransfer,
} from '@shadergrove/shared/editor-groups';
import type { SessionCommand, SessionEditorViewState } from '@shadergrove/shared/session';
import type { EditorGroupId } from '@shadergrove/shared/surfaces';

/**
 * In-process ownership bridge until the workspace session broker is wired in
 * the web shell. Tracks pending view-state transfers for cross-group moves.
 */
@Injectable({ providedIn: 'root' })
export class EditorGroupSession {
  private readonly pendingTransfers = signal<ReadonlyMap<string, EditorDocumentViewTransfer>>(
    new Map(),
  );

  /** Live view-state readers of the mounted panels, by the group each shows. */
  private readonly viewSources = new Map<
    EditorGroupId,
    (documentId: string) => SessionEditorViewState | null
  >();

  /** A panel offers its editor's view state; the returned function withdraws it. */
  registerViewSource(
    groupId: EditorGroupId,
    read: (documentId: string) => SessionEditorViewState | null,
  ): () => void {
    this.viewSources.set(groupId, read);
    return () => {
      if (this.viewSources.get(groupId) === read) this.viewSources.delete(groupId);
    };
  }

  /** Record where a document was in the group it is leaving, for the group it moves to. */
  captureViewTransfer(groupId: EditorGroupId, documentId: string): void {
    const viewState = this.viewSources.get(groupId)?.(documentId) ?? null;
    if (viewState) this.recordViewTransfer({ documentId, viewState });
  }

  /** Last recorded view transfer for a document (Monaco metadata only). */
  viewTransfer(documentId: string): EditorDocumentViewTransfer | null {
    return this.pendingTransfers().get(documentId) ?? null;
  }

  recordViewTransfer(transfer: EditorDocumentViewTransfer): void {
    const next = new Map(this.pendingTransfers());
    next.set(transfer.documentId, transfer);
    this.pendingTransfers.set(next);
  }

  consumeViewTransfer(documentId: string): EditorDocumentViewTransfer | null {
    const current = this.pendingTransfers().get(documentId) ?? null;
    if (!current) return null;
    const next = new Map(this.pendingTransfers());
    next.delete(documentId);
    this.pendingTransfers.set(next);
    return current;
  }

  claimForGroup(groupId: EditorGroupId, documentId: string): SessionCommand {
    const command = buildClaimOwnershipCommand(documentId);
    void editorGroupClientId(groupId);
    return command;
  }

  releaseFromGroup(groupId: EditorGroupId, documentId: string): SessionCommand {
    const command = buildReleaseOwnershipCommand(documentId);
    void editorGroupClientId(groupId);
    return command;
  }

  moveToGroup(
    documentId: string,
    targetGroupId: EditorGroupId,
    viewState: SessionEditorViewState | null,
  ): SessionCommand {
    return buildMoveDocumentCommand(documentId, targetGroupId, viewState);
  }
}
