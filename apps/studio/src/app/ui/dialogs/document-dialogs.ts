import { Injectable, inject } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';

import type { ShaderProject } from '@shadergrove/shared/project';
import { I18n } from '../../i18n/i18n';
import type { EditorDocument } from '../../workspace/state/document-state';
import type { ConfirmDialogData } from './confirm-dialog';
import type { PromptDialogData, PromptDialogResult } from './prompt-dialog';

type NamedDocument = Pick<EditorDocument, 'kind' | 'name'>;

/** The passes sampling a buffer, by name: what deleting it would unbind. */
export function bufferConsumers(project: ShaderProject, bufferId: string): string[] {
  return project.passes
    .filter(
      (pass) =>
        pass.id !== bufferId &&
        pass.channels.some((binding) => binding.kind === 'buffer' && binding.passId === bufferId),
    )
    .map((pass) => pass.name);
}

/**
 * The questions creating, renaming and deleting a file or a buffer ask, in
 * whichever window the explorer is in — the main window, or the editor's own.
 * Only the answer goes on to the store.
 */
@Injectable({ providedIn: 'root' })
export class DocumentDialogs {
  private readonly dialog = inject(MatDialog);
  private readonly i18n = inject(I18n);

  /** The new file's name; `undefined` if cancelled. */
  askNewFileName(): Promise<string | undefined> {
    return this.prompt({
      title: this.i18n.t('dialog.newFile'),
      label: this.i18n.t('dialog.fileName'),
      value: 'untitled.glsl',
      confirmText: this.i18n.t('action.create'),
      hint: this.i18n.t('dialog.newFileHint'),
    });
  }

  /** The document's new name; `undefined` if cancelled or unchanged. */
  async askRename(doc: NamedDocument): Promise<string | undefined> {
    const name = await this.prompt({
      title: this.i18n.t(doc.kind === 'file' ? 'dialog.renameFile' : 'dialog.renamePass'),
      label: this.i18n.t('dialog.name'),
      value: doc.name,
      confirmText: this.i18n.t('dialog.renameConfirm'),
      hint: this.i18n.t(doc.kind === 'file' ? 'dialog.renameFileHint' : 'dialog.renamePassHint'),
    });
    return name && name !== doc.name ? name : undefined;
  }

  /**
   * Deleting a buffer is not the same size of action as deleting a file, and the
   * confirmation says so: a file is text, but a buffer is something other passes
   * may be *sampling*, and removing it silently unbinds every channel that named
   * it. Naming those consumers is the difference between a confirmation and a
   * formality.
   */
  confirmDelete(doc: NamedDocument, consumers: readonly string[]): Promise<boolean> {
    if (doc.kind === 'file') {
      return this.confirm({
        title: this.i18n.t('dialog.deleteFile'),
        message: this.i18n.t('dialog.deleteFileMessage', { name: doc.name }),
        confirmText: this.i18n.t('action.delete'),
        destructive: true,
      });
    }
    return this.confirm({
      title: this.i18n.t('dialog.deleteBuffer'),
      message:
        this.i18n.t('dialog.deleteBufferMessage', { name: doc.name }) +
        (consumers.length === 0
          ? ''
          : consumers.length === 1
            ? this.i18n.t('dialog.deleteBufferConsumersOne', { name: consumers[0] })
            : this.i18n.t('dialog.deleteBufferConsumersMany', {
                names: this.i18n.formatList([...consumers]),
              })),
      confirmText: this.i18n.t('action.delete'),
      destructive: true,
    });
  }

  private async prompt(data: PromptDialogData): Promise<string | undefined> {
    const { PromptDialog } = await import('./prompt-dialog');
    const result = await firstValueFrom(
      this.dialog
        .open<InstanceType<typeof PromptDialog>, PromptDialogData, PromptDialogResult>(
          PromptDialog,
          { data },
        )
        .afterClosed(),
    );
    return result?.value;
  }

  private async confirm(data: ConfirmDialogData): Promise<boolean> {
    const { ConfirmDialog } = await import('./confirm-dialog');
    const result = await firstValueFrom(
      this.dialog
        .open<InstanceType<typeof ConfirmDialog>, ConfirmDialogData, boolean>(ConfirmDialog, {
          data,
        })
        .afterClosed(),
    );
    return result === true;
  }
}
