import { Injectable, inject } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';

import type { ImportMode } from '@shadergrove/shared/model';
import { composePass } from '@shadergrove/shared/pass-source';
import { imagePass } from '@shadergrove/shared/project';
import type { SyncRemoveMode, SyncRemoveResult } from '../../desktop/contracts/contracts';
import { AuthService, type AuthResult } from '../auth/auth.service';
import { DesktopAccount } from '../desktop/desktop-account';
import { DesktopPlatform } from '../desktop/desktop-platform';
import { DesktopSync } from '../desktop/desktop-sync';
import { DesktopUpdater } from '../desktop/desktop-updater';
import { ShaderStore, type EditorDocument } from '../workspace/shader-store';
import { I18n } from '../i18n/i18n';
import { buildFullGlsl } from '@shadergrove/shared/glsl-export';
import type { ConfirmDialogData } from './dialogs/confirm-dialog';
import type { DeleteLinkedDialogData } from './dialogs/delete-linked-dialog';
import type { NewShaderDialogResult } from './dialogs/new-shader-dialog';
import type { PromptDialogData, PromptDialogResult } from './dialogs/prompt-dialog';
import type { UnsavedChoice } from './dialogs/unsaved-changes-dialog';
import type { ExplorerContextCommand, ExplorerReorderIntent } from './file-explorer/contract';
import { OpenDocuments } from './editor/open-documents';

const ABOUT_DIALOG_ID = 'about-shader-studio';
const SHORTCUTS_DIALOG_ID = 'keyboard-shortcuts';

/**
 * The user-facing verbs of the app: the flows that need a dialog or a file
 * before they can call the store.
 *
 * Keeping them here means the toolbar, the browser list and the preset panel
 * can all trigger the same "delete this shader" flow — confirmation included —
 * without duplicating it or reaching into each other.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceActions {
  private readonly dialog = inject(MatDialog);
  private readonly store = inject(ShaderStore);
  private readonly desktop = inject(DesktopPlatform);
  private readonly updater = inject(DesktopUpdater);
  private readonly i18n = inject(I18n);
  private readonly openDocs = inject(OpenDocuments);
  private readonly auth = inject(AuthService);
  private readonly sync = inject(DesktopSync);
  private readonly account = inject(DesktopAccount);
  private transitionInFlight: Promise<boolean> | null = null;

  guardedTransition(action: () => void | Promise<void>): Promise<boolean> {
    if (this.transitionInFlight) return this.transitionInFlight;
    this.transitionInFlight = this.runGuarded(action).finally(
      () => (this.transitionInFlight = null),
    );
    return this.transitionInFlight;
  }

  private async runGuarded(action: () => void | Promise<void>): Promise<boolean> {
    if (this.store.dirty()) {
      const { UnsavedChangesDialog } = await import('./dialogs/unsaved-changes-dialog');
      const choice = await firstValueFrom(
        this.dialog
          .open<InstanceType<typeof UnsavedChangesDialog>, never, UnsavedChoice>(
            UnsavedChangesDialog,
            {
              disableClose: true,
            },
          )
          .afterClosed(),
      );
      if (choice === 'cancel' || !choice) return false;
      if (choice === 'save' && !(await this.store.save())) return false;
      if (choice === 'discard') this.store.discardCurrentDraft();
    }
    await action();
    return true;
  }

  /**
   * Signing out closes the library, so it is a transition like any other: the
   * unsaved-changes guard runs first. Null when the user chose to stay.
   */
  async signOut(): Promise<AuthResult | null> {
    let result: AuthResult | null = null;
    await this.guardedTransition(async () => {
      result = await this.auth.signOut();
      if (result.ok) this.store.closeLibrary();
    });
    return result;
  }

  async selectShader(id: string): Promise<boolean> {
    if (id === this.store.selectedId()) return true;
    return this.guardedTransition(() => this.store.select(id));
  }

  async resolveStaleRecovery(): Promise<void> {
    if (!this.store.staleRecovery()) return;
    const { RecoveryDialog } = await import('./dialogs/recovery-dialog');
    const restore = await firstValueFrom(
      this.dialog
        .open<InstanceType<typeof RecoveryDialog>, never, boolean>(RecoveryDialog, {
          disableClose: true,
        })
        .afterClosed(),
    );
    this.store.resolveRecovery(restore === true);
  }

  async openEditorSettings(): Promise<void> {
    const { EditorSettingsDialog } = await import('./editor/editor-settings-dialog');
    this.dialog.open(EditorSettingsDialog, { width: '720px', maxWidth: '92vw' });
  }

  /** `disableClose`: a stray Escape mid-capture would leave the render running behind a closed dialog. */
  async openExport(): Promise<void> {
    const { ExportDialog } = await import('./dialogs/export-dialog');
    this.dialog.open(ExportDialog, { maxWidth: '92vw', disableClose: true });
  }

  /** Opens the Keyboard Shortcuts catalog dialog (desktop Help menu). */
  async openKeyboardShortcuts(): Promise<void> {
    if (this.dialog.getDialogById(SHORTCUTS_DIALOG_ID)) return;
    const { KeyboardShortcutsDialog } = await import('./help/keyboard-shortcuts-dialog');
    this.dialog.open(KeyboardShortcutsDialog, {
      id: SHORTCUTS_DIALOG_ID,
      width: '520px',
      maxWidth: '92vw',
    });
  }

  /**
   * About Shadergrove… — same dialog as Check for Updates, without forcing a
   * network check. Also offered on the web, where it drops the update status.
   */
  async openAboutShadergrove(): Promise<void> {
    if (this.dialog.getDialogById(ABOUT_DIALOG_ID)) return;
    const { AboutShadergroveDialog } = await import('./dialogs/desktop-version-dialog');
    this.dialog.open(AboutShadergroveDialog, {
      id: ABOUT_DIALOG_ID,
      width: '480px',
      maxWidth: '92vw',
    });
  }

  /**
   * Check for Updates… — forces `DesktopUpdater.check()`, then shows the About
   * dialog. Errors from the check propagate; an already-open About instance is
   * reused rather than stacked.
   */
  async checkForUpdates(): Promise<void> {
    if (!this.desktop.available) return;
    await this.updater.check();
    await this.openAboutShadergrove();
  }

  private async promptFor(data: PromptDialogData): Promise<PromptDialogResult | undefined> {
    const { PromptDialog } = await import('./dialogs/prompt-dialog');
    return firstValueFrom(
      this.dialog
        .open<InstanceType<typeof PromptDialog>, PromptDialogData, PromptDialogResult>(
          PromptDialog,
          { data },
        )
        .afterClosed(),
    );
  }

  /** The name only — for the prompts that carry no extra option. */
  private async prompt(data: PromptDialogData): Promise<string | undefined> {
    return (await this.promptFor(data))?.value;
  }

  private async confirm(data: ConfirmDialogData): Promise<boolean> {
    const { ConfirmDialog } = await import('./dialogs/confirm-dialog');
    const result = await firstValueFrom(
      this.dialog
        .open<InstanceType<typeof ConfirmDialog>, ConfirmDialogData, boolean>(ConfirmDialog, {
          data,
        })
        .afterClosed(),
    );
    return result === true;
  }

  // --- Shaders ------------------------------------------------------------

  async createShader(): Promise<void> {
    const { NewShaderDialog } = await import('./dialogs/new-shader-dialog');
    const result = await firstValueFrom(
      this.dialog
        .open<InstanceType<typeof NewShaderDialog>, never, NewShaderDialogResult>(NewShaderDialog)
        .afterClosed(),
    );
    if (!result) return;
    if (result.action === 'plugin') {
      // A plugin importer chosen instead: its own command takes it from here.
      result.command.action();
      return;
    }
    await this.guardedTransition(() => this.store.create(result.name));
  }

  async renameShader(id: string, currentName: string): Promise<void> {
    const name = await this.prompt({
      title: this.i18n.t('dialog.renameShader'),
      label: this.i18n.t('dialog.name'),
      value: currentName,
      confirmText: this.i18n.t('dialog.renameConfirm'),
      hint: this.i18n.t('dialog.renameHint'),
    });
    if (name && name !== currentName) await this.store.rename(id, name);
  }

  async duplicateShader(id: string, currentName: string): Promise<void> {
    const name = await this.prompt({
      title: this.i18n.t('dialog.duplicateShader'),
      label: this.i18n.t('dialog.duplicateName'),
      value: `${currentName} ${this.i18n.t('dialog.copySuffix')}`,
      confirmText: this.i18n.t('dialog.duplicateConfirm'),
    });
    if (name) await this.guardedTransition(() => this.store.duplicate(id, name));
  }

  /**
   * A shader linked to the signed-in account also offers "Delete everywhere",
   * bound to the account and revision on screen now: if either moved on by the
   * time it runs, nothing is deleted. Only `not-linked` falls back to the plain
   * confirm.
   */
  async deleteShader(id: string, name: string): Promise<void> {
    const userId = this.account.state().user?.id;
    const revision = this.store.shaders().find((shader) => shader.id === id)?.revision;
    if (this.sync.isLinked(id) && userId && revision !== undefined) {
      const mode = await this.chooseDeleteMode(name);
      if (!mode) return;
      let result = undefined as SyncRemoveResult | undefined;
      await this.removeFromStore(id, async () => {
        result = await this.sync.remove({ id, mode, userId, revision });
        return result === 'ok';
      });
      if (result === 'changed' || result === 'account-changed') {
        const key = result === 'changed' ? 'sync.deleteChanged' : 'sync.deleteAccountChanged';
        this.store.notice.set({ text: this.i18n.t(key, { name }), error: true });
      }
      if (result !== 'not-linked') return;
    }
    const confirmed = await this.confirm({
      title: this.i18n.t('dialog.deleteShader'),
      message: this.i18n.t('dialog.deleteShaderMessage', { name }),
      confirmText: this.i18n.t('action.delete'),
      destructive: true,
    });
    if (confirmed) await this.removeFromStore(id);
  }

  private async removeFromStore(id: string, removeRecord?: () => Promise<boolean>): Promise<void> {
    const remove = () => this.store.remove(id, removeRecord);
    if (id === this.store.selectedId()) await this.guardedTransition(remove);
    else await remove();
  }

  private async chooseDeleteMode(name: string): Promise<SyncRemoveMode | undefined> {
    const { DeleteLinkedDialog } = await import('./dialogs/delete-linked-dialog');
    return firstValueFrom(
      this.dialog
        .open<InstanceType<typeof DeleteLinkedDialog>, DeleteLinkedDialogData, SyncRemoveMode>(
          DeleteLinkedDialog,
          { data: { name } },
        )
        .afterClosed(),
    );
  }

  /** Publish, update or unpublish a shader's public snapshot. Web only. */
  async openPublish(shaderId: string, name: string): Promise<void> {
    const { PublishDialog } = await import('../publications/publish-dialog');
    this.dialog.open(PublishDialog, {
      data: { shaderId, name },
      maxWidth: 'calc(100vw - 32px)',
    });
  }

  // --- Files and passes ---------------------------------------------------

  async createFile(): Promise<void> {
    if (!this.store.draft()) return;

    const name = await this.prompt({
      title: this.i18n.t('dialog.newFile'),
      label: this.i18n.t('dialog.fileName'),
      value: 'untitled.glsl',
      confirmText: this.i18n.t('action.create'),
      hint: this.i18n.t('dialog.newFileHint'),
    });
    if (name) this.store.addSourceFile(name);
  }

  async renameDocument(doc: EditorDocument): Promise<void> {
    const name = await this.prompt({
      title: this.i18n.t(doc.kind === 'file' ? 'dialog.renameFile' : 'dialog.renamePass'),
      label: this.i18n.t('dialog.name'),
      value: doc.name,
      confirmText: this.i18n.t('dialog.renameConfirm'),
      hint: this.i18n.t(doc.kind === 'file' ? 'dialog.renameFileHint' : 'dialog.renamePassHint'),
    });
    if (!name || name === doc.name) return;

    if (doc.kind === 'file') this.store.renameSourceFile(doc.id, name);
    else this.store.renamePassById(doc.id, name);
  }

  /**
   * Deleting a buffer is not the same size of action as deleting a file, and the
   * confirmation says so: a file is text, but a buffer is something other passes
   * may be *sampling*, and removing it silently unbinds every channel that named
   * it. Naming those consumers is the difference between a confirmation and a
   * formality.
   */
  async deleteDocument(doc: EditorDocument): Promise<void> {
    const project = this.store.project();
    if (!project) return;

    if (doc.kind === 'file') {
      const confirmed = await this.confirm({
        title: this.i18n.t('dialog.deleteFile'),
        message: this.i18n.t('dialog.deleteFileMessage', { name: doc.name }),
        confirmText: this.i18n.t('action.delete'),
        destructive: true,
      });
      if (confirmed) this.store.removeSourceFile(doc.id);
      return;
    }

    const consumers = project.passes
      .filter(
        (pass) =>
          pass.id !== doc.id &&
          pass.channels.some((binding) => binding.kind === 'buffer' && binding.passId === doc.id),
      )
      .map((pass) => pass.name);

    const confirmed = await this.confirm({
      title: this.i18n.t('dialog.deleteBuffer'),
      message:
        this.i18n.t('dialog.deleteBufferMessage', { name: doc.name }) +
        (consumers.length === 0
          ? ''
          : consumers.length === 1
            ? this.i18n.t('dialog.deleteBufferConsumersOne', { name: consumers[0] })
            : this.i18n.t('dialog.deleteBufferConsumersMany', {
                names: this.i18n.formatList(consumers),
              })),
      confirmText: this.i18n.t('action.delete'),
      destructive: true,
    });
    if (confirmed) this.store.removeBufferPass(doc.id);
  }

  // --- File explorer ------------------------------------------------------

  /** Activate an editor document tab — opens it if needed, no shader switch. */
  selectDocument(docId: string): void {
    this.openDocs.activate(docId);
  }

  createBufferPass(): void {
    this.store.addBufferPass();
  }

  duplicateDocument(doc: EditorDocument): void {
    if (doc.kind === 'file') this.store.duplicateSourceFile(doc.id);
    else if (doc.passKind === 'buffer') this.store.duplicateBufferPass(doc.id);
  }

  setBufferEnabled(docId: string, enabled: boolean): void {
    this.store.setPassEnabledById(docId, enabled);
  }

  /**
   * Reorder within buffer or file lists — same rules as explorer drag/drop.
   * Cross-list drops are ignored.
   */
  reorderExplorer(intent: ExplorerReorderIntent): void {
    const project = this.store.project();
    if (!project) return;

    if (intent.list === 'file') {
      const index = project.files.findIndex((file) => file.id === intent.targetDocId);
      if (index >= 0) this.store.moveSourceFile(intent.sourceDocId, index);
      return;
    }

    const index = this.store.buffers().findIndex((pass) => pass.id === intent.targetDocId);
    if (index >= 0) this.store.movePassTo(intent.sourceDocId, index);
  }

  /**
   * Dispatch explorer context-menu or header commands through the same flows
   * as editor tabs — confirmations and dialogs included.
   */
  async runExplorerCommand(command: ExplorerContextCommand, docId?: string): Promise<void> {
    switch (command) {
      case 'create-file':
        await this.createFile();
        return;
      case 'create-buffer':
        this.createBufferPass();
        return;
      case 'rename':
      case 'duplicate':
      case 'delete':
      case 'enable':
      case 'disable': {
        if (!docId) return;
        const doc = this.store.documents().find((entry) => entry.id === docId);
        if (!doc) return;
        switch (command) {
          case 'rename':
            await this.renameDocument(doc);
            break;
          case 'duplicate':
            this.duplicateDocument(doc);
            break;
          case 'delete':
            await this.deleteDocument(doc);
            break;
          case 'enable':
            this.setBufferEnabled(docId, true);
            break;
          case 'disable':
            this.setBufferEnabled(docId, false);
            break;
        }
      }
    }
  }

  // --- Source ---------------------------------------------------------------

  /**
   * Copy the fragment as a standalone file: the source plus the declarations
   * the engine would otherwise have supplied. What you paste into another
   * engine, or into a bug report, is then the shader as it actually compiles.
   */
  async copyFullGlsl(): Promise<void> {
    const draft = this.store.draft();
    if (!draft) return;

    // The Image pass, composed: Common and any `#include`s folded in, so what
    // lands on the clipboard is what the driver actually saw — not a source with
    // half its declarations in another tab.
    const { source } = composePass(draft.project, imagePass(draft.project));
    const glsl = buildFullGlsl(source, this.store.controls());

    try {
      await navigator.clipboard.writeText(glsl);
      this.store.notice.set({ text: this.i18n.t('notice.copiedGlsl'), error: false });
    } catch {
      // Denied permission, or an insecure context — neither is worth a console
      // trace, but the user is owed an explanation for the nothing that happened.
      this.store.notice.set({ text: this.i18n.t('notice.clipboardUnavailable'), error: true });
    }
  }

  // --- Presets ------------------------------------------------------------

  async savePreset(): Promise<void> {
    const result = await this.promptFor({
      title: this.i18n.t('dialog.savePreset'),
      label: this.i18n.t('dialog.presetName'),
      confirmText: this.i18n.t('action.save'),
      hint: this.i18n.t('dialog.savePresetHint'),
      option: {
        label: this.i18n.t('dialog.presetCaptureRender'),
        hint: this.i18n.t('dialog.presetCaptureRenderHint'),
      },
    });
    if (result) await this.store.savePreset(result.value, result.checked);
  }

  async deletePreset(presetId: string, name: string): Promise<void> {
    const confirmed = await this.confirm({
      title: this.i18n.t('dialog.deletePreset'),
      message: this.i18n.t('dialog.deletePresetMessage', { name }),
      confirmText: this.i18n.t('action.delete'),
      destructive: true,
    });
    if (confirmed) await this.store.deletePreset(presetId);
  }

  // --- Import / export ----------------------------------------------------

  async exportShader(id: string, name: string): Promise<void> {
    try {
      const bundle = await this.store.exportShader(id);
      if (this.desktop.available) {
        if (!(await this.desktop.saveBundle(`${id}.shader.json`, bundle as never))) return;
      } else {
        this.download(bundle, `${id}.shader.json`);
      }
      this.store.notice.set({ text: this.i18n.t('notice.exported', { name }), error: false });
    } catch (error) {
      this.store.notice.set({
        text: this.i18n.t('notice.exportFailed', { error: String(error) }),
        error: true,
      });
    }
  }

  async exportAll(): Promise<void> {
    try {
      const bundle = await this.store.exportAll();
      if (this.desktop.available) {
        if (!(await this.desktop.saveBundle('shadergrove-collection.shader.json', bundle as never)))
          return;
      } else {
        this.download(bundle, 'shadergrove-collection.shader.json');
      }
      this.store.notice.set({ text: this.i18n.t('notice.exportedAll'), error: false });
    } catch (error) {
      this.store.notice.set({
        text: this.i18n.t('notice.exportFailed', { error: String(error) }),
        error: true,
      });
    }
  }

  /**
   * Read a `.shader.json` the user picked and hand it to the API.
   *
   * The bundle is parsed here only to fail fast on something that is not even
   * JSON. The server validates it properly — the client is not the authority.
   */
  async importFile(file: File, mode: ImportMode): Promise<void> {
    let bundle: unknown;
    try {
      bundle = JSON.parse(await file.text());
    } catch {
      this.store.notice.set({
        text: this.i18n.t('notice.invalidJson', { name: file.name }),
        error: true,
      });
      return;
    }

    if (mode === 'overwrite') {
      const confirmed = await this.confirm({
        title: this.i18n.t('dialog.importReplace'),
        message: this.i18n.t('dialog.importReplaceMessage'),
        confirmText: this.i18n.t('action.replace'),
        destructive: true,
      });
      if (!confirmed) return;
    }

    await this.guardedTransition(() => this.store.importBundle(bundle, mode));
  }

  async importDesktop(mode: ImportMode): Promise<void> {
    try {
      const picked = await this.desktop.openBundle();
      if (!picked) return;
      if (mode === 'overwrite') {
        const confirmed = await this.confirm({
          title: this.i18n.t('dialog.importReplace'),
          message: this.i18n.t('dialog.importReplaceDesktop'),
          confirmText: this.i18n.t('action.replace'),
          destructive: true,
        });
        if (!confirmed) return;
      }
      await this.guardedTransition(() => this.store.importBundle(picked.bundle, mode));
    } catch (error) {
      this.store.notice.set({
        text: this.i18n.t('notice.importFailed', { error: String(error) }),
        error: true,
      });
    }
  }

  async resolveFirstRunMigration(): Promise<void> {
    if (!this.desktop.available || !(await this.desktop.migrationPending())) return;
    const shouldImport = await this.confirm({
      title: this.i18n.t('dialog.migrateTitle'),
      message: this.i18n.t('dialog.migrateMessage'),
      confirmText: this.i18n.t('dialog.chooseFolder'),
    });
    if (!shouldImport) {
      await this.desktop.declineMigration();
      return;
    }
    try {
      const notice = await this.desktop.migrate();
      if (notice) {
        await this.store.refreshList();
        this.store.notice.set({ text: notice, error: false });
      }
    } catch (error) {
      this.store.notice.set({
        text: this.i18n.t('notice.importFailed', { error: String(error) }),
        error: true,
      });
    }
  }

  private download(bundle: unknown, filename: string): void {
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    this.downloadBlob(blob, filename);
  }

  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }
}
