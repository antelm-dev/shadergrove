import { Component, computed, effect, inject, untracked, viewChild } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

import { DEFAULT_EDITOR_GROUP_ID, editorSurfaceId } from '@shadergrove/shared/surfaces';
import { CodeEditor, type EditorDoc } from '../../editor/code-editor';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { Preferences } from '../../prefs/preferences';
import { SessionMirror } from '../../workspace/session-sync/session-mirror';
import { textFingerprint } from '../../workspace/session-sync/session-protocol';
import { DocumentDialogs } from '../dialogs/document-dialogs';
import type {
  ExplorerCommandEvent,
  ExplorerReorderIntent,
  ExplorerViewMode,
} from '../file-explorer/contract';
import { ExplorerPanel } from '../file-explorer/explorer-panel';
import { SatelliteControls } from '../layout/satellite-controls';
import { SatelliteTitlebar } from '../layout/satellite-titlebar';

/**
 * The whole page of the editor's native window, bootstrapped in place of
 * `App` (see `rootComponent`).
 *
 * It edits the main window's documents, never copies of them: every
 * keystroke goes to the main window as the document's whole text, scoped to
 * the shader it was typed in, and the main window's store applies it — so
 * dirty state, draft recovery, compiling and saving all happen there, once.
 * The text typed here shows at once and the main window's state waits until
 * it has confirmed it (`SessionMirror`), so a slower echo never rewrites what
 * was typed or its undo history. Undo and redo are Monaco's, per document,
 * as in the docked editor.
 */
@Component({
  selector: 'app-root',
  imports: [
    CodeEditor,
    ExplorerPanel,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    SatelliteControls,
    SatelliteTitlebar,
    TranslatePipe,
  ],
  template: `
    <app-satellite-titlebar
      [surfaceId]="surfaceId"
      [panel]="'toolbar.editor' | translate"
      closeLabel="editor.close"
    />

    <header class="header">
      @if (!explorerOpen()) {
        <button
          matIconButton
          type="button"
          class="explorer-reopen"
          [matTooltip]="'explorer.expand' | translate"
          [attr.aria-label]="'explorer.expand' | translate"
          (click)="setExplorerOpen(true)"
        >
          <mat-icon>folder_open</mat-icon>
        </button>
      }
      <div class="tablist" role="tablist" [attr.aria-label]="'editor.documents' | translate">
        @for (document of documents(); track document.id) {
          @let selected = document.id === activeDoc()?.id;
          @let errors = errorCount(document.id);
          <button
            type="button"
            role="tab"
            class="tab"
            [class.active]="selected"
            [attr.aria-selected]="selected"
            [tabindex]="selected ? 0 : -1"
            (click)="select(document.id)"
          >
            <span class="name">{{ document.name }}</span>
            @if (errors > 0) {
              <span
                class="count error"
                [attr.aria-label]="'panel.errorCount' | translate: { count: errors }"
                >{{ errors }}</span
              >
            }
          </button>
        }
      </div>

      <span class="spacer"></span>

      @if (dirty()) {
        <span class="status" role="status">{{ 'status.unsaved' | translate }}</span>
      }
      <button
        matIconButton
        type="button"
        class="save"
        [disabled]="!dirty() || saving()"
        [matTooltip]="'action.saveShader' | translate"
        [attr.aria-label]="'action.saveShader' | translate"
        (click)="save()"
      >
        <mat-icon>save</mat-icon>
      </button>
      <app-satellite-controls
        [surfaceId]="surfaceId"
        dockIcon="dock_to_bottom"
        closeLabel="editor.close"
      />
    </header>

    <div class="body">
      @if (explorerOpen()) {
        <app-explorer-panel
          class="explorer"
          [style.width.px]="explorerWidth()"
          [tree]="explorer().tree"
          [canCreateBuffer]="explorer().canAddBuffer"
          (viewChange)="setExplorerView($event)"
          (select)="select($event.docId)"
          (command)="onExplorerCommand($event)"
          (reorder)="onExplorerReorder($event)"
          (collapse)="setExplorerOpen(false)"
        />
      }

      @if (editorDoc(); as doc) {
        <app-code-editor
          class="code"
          [doc]="doc"
          [liveIds]="liveIds()"
          [diagnostics]="activeDiagnostics()"
          [appearance]="appearance()"
          (valueChange)="edit($event.id, $event.value)"
        />
      } @else {
        <p class="empty">{{ 'editor.empty' | translate }}</p>
      }
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
      background: var(--mat-sys-surface-container-lowest);
      color: var(--mat-sys-on-surface);
    }

    .header {
      display: flex;
      align-items: center;
      flex: 0 0 auto;
      gap: 4px;
      min-height: 34px;
      padding: 3px 5px 3px 7px;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
      background: var(--mat-sys-surface-container-low);
    }

    .tablist {
      display: flex;
      gap: 2px;
      min-width: 0;
      overflow-x: auto;
      scrollbar-width: thin;
    }

    .tab {
      display: flex;
      align-items: center;
      gap: 6px;
      height: 28px;
      padding-inline: 10px;
      border: 0;
      border-radius: var(--mat-sys-corner-small, 6px);
      background: transparent;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-medium);
      white-space: nowrap;
      cursor: pointer;
    }

    .tab:hover {
      background: color-mix(in srgb, var(--mat-sys-on-surface) 8%, transparent);
    }

    .tab.active {
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
    }

    .tab:focus-visible {
      outline: 2px solid var(--mat-sys-primary);
      outline-offset: -2px;
    }

    .count.error {
      display: inline-grid;
      place-items: center;
      min-width: 17px;
      height: 17px;
      padding: 0 4px;
      border-radius: 9px;
      background: var(--mat-sys-error);
      color: var(--mat-sys-on-error);
      font: var(--mat-sys-label-small);
    }

    .spacer {
      flex: 1;
    }

    .status {
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-small);
      white-space: nowrap;
    }

    .save,
    .explorer-reopen {
      width: 28px;
      height: 28px;
      padding: 4px;
      --mat-icon-button-state-layer-size: 28px;

      mat-icon {
        width: 18px;
        height: 18px;
        font-size: 18px;
      }
    }

    .body {
      display: flex;
      flex: 1;
      min-height: 0;
    }

    .explorer {
      flex: 0 0 auto;
      min-width: 0;
      max-width: 50%;
      border-right: 1px solid var(--mat-sys-outline-variant);
    }

    .code {
      flex: 1;
      min-width: 0;
      min-height: 0;
    }

    .empty {
      margin: 16px;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-medium);
    }
  `,
  host: {
    '(window:keydown)': 'onKeydown($event)',
  },
})
export class EditorWindow {
  private readonly mirror = inject(SessionMirror);
  protected readonly surfaceId = editorSurfaceId(DEFAULT_EDITOR_GROUP_ID);

  private readonly editor = viewChild(CodeEditor);

  private readonly shader = this.mirror.field('shader');
  protected readonly documents = this.mirror.field('documents');
  protected readonly dirty = this.mirror.field('dirty');
  protected readonly saving = this.mirror.field('saving');
  protected readonly appearance = this.mirror.field('editorAppearance');
  private readonly diagnostics = this.mirror.field('diagnostics');
  protected readonly explorer = this.mirror.field('explorer');

  private readonly preferences = inject(Preferences);
  private readonly dialogs = inject(DocumentDialogs);
  /** Open or collapsed, and how wide: this window's own, never saved (a panel window saves nothing). */
  protected readonly explorerOpen = computed(() => this.preferences.value().fileExplorerOpen);
  protected readonly explorerWidth = computed(() => this.preferences.value().fileExplorerWidth);

  protected readonly activeDoc = computed(() => {
    const documents = this.documents();
    const id = this.mirror.field('activeDocId')();
    return documents.find((document) => document.id === id) ?? documents.at(0) ?? null;
  });

  protected readonly liveIds = computed(() => this.documents().map((document) => document.id));

  /**
   * Scoped to the shader: a document id another shader also has (every shader
   * has an Image pass and a Config) starts a fresh undo history there.
   */
  protected readonly editorDoc = computed<EditorDoc | null>(() => {
    const doc = this.activeDoc();
    const shader = this.shader();
    if (!doc || !shader) return null;
    return { id: doc.id, language: doc.language, value: doc.source, scope: shader.id };
  });

  protected readonly activeDiagnostics = computed(() => {
    const id = this.activeDoc()?.id;
    return this.diagnostics().filter((diagnostic) => diagnostic.docId === id);
  });

  constructor() {
    this.mirror.start('editor');

    // A line the main window asks to show: a diagnostic clicked anywhere, the Config.
    effect(() => {
      const request = this.mirror.revealRequest();
      if (!request) return;
      untracked(() => {
        const editor = this.editor();
        if (request.line > 0) editor?.revealIn(request.docId, request.line);
        else editor?.focus();
      });
    });
  }

  protected errorCount(docId: string): number {
    return this.diagnostics().filter(
      (diagnostic) => diagnostic.docId === docId && diagnostic.severity === 'error',
    ).length;
  }

  protected select(docId: string): void {
    void this.mirror.send({ kind: 'select-doc', docId }, { activeDocId: docId });
  }

  /**
   * One keystroke: the document's whole text goes to the main window, for the
   * shader it was typed in and naming the text it was typed on — the model's,
   * which may be older than what just arrived from the main window. It shows
   * here at once; the main window refuses it if its text has moved on, and this
   * window then shows the main window's text.
   */
  protected edit(docId: string, source: string): void {
    const shaderId = this.shader()?.id;
    const typedOn =
      this.editor()?.textBefore(docId) ??
      this.documents().find((document) => document.id === docId)?.source;
    if (!shaderId || typedOn === undefined) return;
    const documents = this.documents().map((document) =>
      document.id === docId ? { ...document, source } : document,
    );
    const base = textFingerprint(typedOn);
    void this.mirror.send({ kind: 'edit', shaderId, docId, base, source }, { documents });
  }

  protected setExplorerOpen(open: boolean): void {
    this.preferences.patch({ fileExplorerOpen: open });
  }

  /** The main window's explorer view: its tree is built there. */
  protected setExplorerView(view: ExplorerViewMode): void {
    void this.mirror.send({ kind: 'explorer-view', view });
  }

  /**
   * The explorer's commands, as in the docked editor: a question (a name, a
   * confirmation) is asked here, where the user is, and only the answer goes
   * to the main window, which checks it against its own documents. Each names
   * the shader it was asked in, so an answer never lands in another one.
   */
  protected async onExplorerCommand({ command, docId }: ExplorerCommandEvent): Promise<void> {
    const shaderId = this.shader()?.id;
    if (!shaderId) return;
    if (command === 'create-file') {
      const name = await this.dialogs.askNewFileName();
      if (name) void this.mirror.send({ kind: 'add-file', shaderId, name });
      return;
    }
    if (command === 'create-buffer') {
      void this.mirror.send({ kind: 'add-buffer', shaderId });
      return;
    }
    const doc = this.documents().find((document) => document.id === docId);
    if (!doc) return;
    switch (command) {
      case 'rename': {
        const name = await this.dialogs.askRename(doc);
        if (name) void this.mirror.send({ kind: 'rename-doc', shaderId, docId: doc.id, name });
        return;
      }
      case 'duplicate':
        void this.mirror.send({ kind: 'duplicate-doc', shaderId, docId: doc.id });
        return;
      case 'delete':
        if (await this.dialogs.confirmDelete(doc, this.explorer().consumers[doc.id] ?? [])) {
          void this.mirror.send({ kind: 'delete-doc', shaderId, docId: doc.id });
        }
        return;
      case 'enable':
      case 'disable':
        void this.mirror.send({
          kind: 'set-doc-enabled',
          shaderId,
          docId: doc.id,
          enabled: command === 'enable',
        });
        return;
    }
  }

  protected onExplorerReorder(intent: ExplorerReorderIntent): void {
    const shaderId = this.shader()?.id;
    if (!shaderId) return;
    void this.mirror.send({
      kind: 'move-doc',
      shaderId,
      docId: intent.sourceDocId,
      targetDocId: intent.targetDocId,
      list: intent.list,
    });
  }

  /** Saved by the main window, after every edit sent before it. */
  protected save(): void {
    void this.mirror.send({ kind: 'save' });
  }

  protected onKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      this.save();
    }
  }
}
