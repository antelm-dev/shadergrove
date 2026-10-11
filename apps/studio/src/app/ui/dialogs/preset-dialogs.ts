import { Injectable, inject } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';

import { I18n } from '../../i18n/i18n';
import type { ConfirmDialogData } from './confirm-dialog';
import type { PromptDialogData, PromptDialogResult } from './prompt-dialog';

/**
 * The questions saving and deleting a parameter preset asks, in whichever
 * window the inspector is in — the main window, or the inspector's own.
 */
@Injectable({ providedIn: 'root' })
export class PresetDialogs {
  private readonly dialog = inject(MatDialog);
  private readonly i18n = inject(I18n);

  /** The new preset's name, and whether it also captures post-processing; `null` if cancelled. */
  async askToSave(): Promise<{ name: string; withRender: boolean } | null> {
    const { PromptDialog } = await import('./prompt-dialog');
    const data: PromptDialogData = {
      title: this.i18n.t('dialog.savePreset'),
      label: this.i18n.t('dialog.presetName'),
      confirmText: this.i18n.t('action.save'),
      hint: this.i18n.t('dialog.savePresetHint'),
      option: {
        label: this.i18n.t('dialog.presetCaptureRender'),
        hint: this.i18n.t('dialog.presetCaptureRenderHint'),
      },
    };
    const result = await firstValueFrom(
      this.dialog
        .open<InstanceType<typeof PromptDialog>, PromptDialogData, PromptDialogResult>(
          PromptDialog,
          { data },
        )
        .afterClosed(),
    );
    return result ? { name: result.value, withRender: result.checked } : null;
  }

  async confirmDelete(name: string): Promise<boolean> {
    const { ConfirmDialog } = await import('./confirm-dialog');
    const data: ConfirmDialogData = {
      title: this.i18n.t('dialog.deletePreset'),
      message: this.i18n.t('dialog.deletePresetMessage', { name }),
      confirmText: this.i18n.t('action.delete'),
      destructive: true,
    };
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
