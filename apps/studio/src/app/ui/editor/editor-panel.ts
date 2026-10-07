import {
  Component,
  DestroyRef,
  ElementRef,
  PLATFORM_ID,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';

import {
  FILE_EXPLORER_LIMITS,
  FILE_EXPLORER_OVERLAY_BREAKPOINT,
  clampFileExplorerWidth,
} from '@shadergrove/shared/panel-prefs';
import { findPass } from '@shadergrove/shared/project';
import {
  DEFAULT_EDITOR_GROUP_ID,
  editorSurfaceId,
  type EditorGroupId,
  type SurfaceId,
} from '@shadergrove/shared/surfaces';
import { CodeEditor, type EditorDoc } from '../../editor/code-editor';
import { EditorSettings } from '../../editor/editor-settings';
import {
  EditorNavigation,
  resolveNavigationTarget,
  type EditorLocationRequest,
} from '../../editor/editor-navigation';
import { Preferences } from '../../prefs/preferences';
import { ShaderStore, type EditorDocument } from '../../workspace/shader-store';
import { DocumentStatus } from './document-status';
import { EditorTabs } from './editor-tabs';
import { EditorWindowControls } from './editor-window-controls';
import { EditorGroups } from './editor-groups';
import { PassConfigPanel } from '../inspector/pass-config-panel';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { WorkspaceActions } from '../workspace-actions';
import {
  ExplorerPanel,
  buildExplorerTree,
  type ExplorerCommandEvent,
  type ExplorerReorderIntent,
  type ExplorerSelectEvent,
  type ExplorerViewMode,
} from '../file-explorer';

type EditorSurface = Pick<CodeEditor, 'focus' | 'format' | 'layout' | 'revealIn'>;

@Component({
  selector: 'app-editor-panel',
  imports: [
    CodeEditor,
    EditorTabs,
    EditorWindowControls,
    ExplorerPanel,
    MatButtonModule,
    MatDividerModule,
    MatIconModule,
    MatMenuModule,
    MatTooltipModule,
    PassConfigPanel,
    TranslatePipe,
  ],
  template: `
    <div
      class="editor-toolbar"
      [class.draggable]="dragEnabled()"
      [matContextMenuTriggerFor]="editorMenu"
      (pointerdown)="onToolbarPointerDown($event)"
    >
      <app-editor-tabs
        class="tabs"
        [activeId]="activeDoc()?.id ?? null"
        [groupId]="ownGroupId()"
        (select)="selectDoc($event)"
        (closed)="onTabClosed($event)"
      />

      <div class="spacer"></div>

      @if (status.state() === 'unsaved' || status.state() === 'saving') {
        <span class="dirty" aria-live="polite">{{ status.label() }}</span>
      }

      @if (activePass() && !collapsed()) {
        <button
          type="button"
          class="config-toggle"
          [matButton]="configOpen() ? 'tonal' : 'text'"
          [attr.aria-pressed]="configOpen()"
          [attr.aria-label]="'editor.passSettings' | translate"
          [matTooltip]="'editor.passSettings' | translate"
          (click)="configOpen.set(!configOpen())"
        >
          <mat-icon>tune</mat-icon>
        </button>
      }

      <app-editor-window-controls [surfaceId]="surfaceId()" />
    </div>

    <mat-menu #editorMenu="matMenu">
      <button
        mat-menu-item
        type="button"
        [disabled]="!status.canSave()"
        [matTooltip]="status.saveHint()"
        (click)="store.save()"
      >
        <mat-icon>save</mat-icon>
        <span>{{ (store.saving() ? 'action.saving' : 'action.saveShader') | translate }}</span>
        <span class="menu-hint">Ctrl+S</span>
      </button>
      <button
        mat-menu-item
        type="button"
        [disabled]="!store.dirty() || store.saving()"
        (click)="store.revert()"
      >
        <mat-icon>undo</mat-icon>
        <span>{{ 'action.revert' | translate }}</span>
      </button>
      <mat-divider />
      <button
        mat-menu-item
        type="button"
        [disabled]="!store.canAddBuffer()"
        (click)="store.addBufferPass()"
      >
        <mat-icon>layers</mat-icon>
        <span>{{ 'editor.newBuffer' | translate }}</span>
      </button>
      <button
        mat-menu-item
        type="button"
        [disabled]="!store.draft()"
        (click)="workspace.createFile()"
      >
        <mat-icon>description</mat-icon>
        <span>{{ 'editor.newFile' | translate }}</span>
        <span class="menu-hint">Ctrl+N</span>
      </button>
      <mat-divider />
      <button
        mat-menu-item
        type="button"
        [disabled]="!store.draft() || activeDoc()?.language !== 'glsl'"
        (click)="formatSource()"
      >
        <mat-icon>format_align_left</mat-icon>
        <span>{{ 'editor.formatGlsl' | translate }}</span>
        <span class="menu-hint">Shift+Alt+F</span>
      </button>
      <button
        mat-menu-item
        type="button"
        [disabled]="!store.draft()"
        [matTooltip]="'editor.copyFullGlsl' | translate"
        (click)="workspace.copyFullGlsl()"
      >
        <mat-icon>content_copy</mat-icon>
        <span>{{ 'editor.copyGlsl' | translate }}</span>
      </button>
      <mat-divider />
      <button mat-menu-item type="button" (click)="workspace.openEditorSettings()">
        <mat-icon>tune</mat-icon>
        <span>{{ 'action.appearance' | translate }}</span>
      </button>
    </mat-menu>

    <div
      #editorBody
      class="editor-body"
      [class.collapsed]="collapsed()"
      [class.overlay-open]="explorerOverlayOpen()"
      [attr.inert]="collapsed() || null"
    >
      @if (showExplorerReopen()) {
        <button
          type="button"
          class="explorer-reopen"
          [matButton]="explorerOverlayAvailable() ? 'tonal' : 'text'"
          [matTooltip]="
            (explorerPreferredOpen() ? 'explorer.expand' : 'explorer.title') | translate
          "
          [attr.aria-label]="
            (explorerOverlayAvailable() ? 'explorer.expand' : 'explorer.title') | translate
          "
          (click)="reopenExplorer()"
        >
          <mat-icon>folder_open</mat-icon>
        </button>
      }

      @if (explorerDocked()) {
        <app-explorer-panel
          class="explorer"
          [style.width.px]="explorerWidth()"
          [tree]="explorerTree()"
          [canCreateBuffer]="store.canAddBuffer()"
          (viewChange)="setExplorerView($event)"
          (select)="onExplorerSelect($event)"
          (command)="onExplorerCommand($event)"
          (reorder)="onExplorerReorder($event)"
          (collapse)="collapseExplorer()"
        />

        <div
          class="explorer-resizer"
          role="separator"
          tabindex="0"
          aria-orientation="vertical"
          [attr.aria-label]="'explorer.resizeHandle' | translate"
          [attr.aria-valuenow]="explorerWidth()"
          [attr.aria-valuemin]="fileExplorerLimits.width.min"
          [attr.aria-valuemax]="fileExplorerLimits.width.max"
          (pointerdown)="startExplorerResize($event)"
          (keydown)="onExplorerResizeKeydown($event)"
        ></div>
      }

      <div class="editor-main">
        @if (editorDoc(); as doc) {
          <app-code-editor
            #editorSurface
            class="editor"
            [doc]="doc"
            [liveIds]="liveIds()"
            [appearance]="settings.effective()"
            [diagnostics]="activeDiagnostics()"
            (valueChange)="store.setDocSource($event.id, $event.value)"
          />

          @if (activePass(); as pass) {
            @if (configOpen()) {
              <app-pass-config-panel class="config" [pass]="pass" />
            }
          }
        } @else {
          <p class="empty">{{ 'editor.empty' | translate }}</p>
        }
      </div>

      @if (explorerOverlayOpen()) {
        <button
          type="button"
          class="explorer-scrim"
          tabindex="-1"
          aria-hidden="true"
          (click)="closeExplorerOverlay()"
        ></button>

        <div class="explorer-overlay" (keydown.escape)="onOverlayEscape()">
          <app-explorer-panel
            class="explorer overlay-panel"
            [style.width.px]="explorerWidth()"
            [tree]="explorerTree()"
            [canCreateBuffer]="store.canAddBuffer()"
            (viewChange)="setExplorerView($event)"
            (select)="onExplorerSelect($event)"
            (command)="onExplorerCommand($event)"
            (reorder)="onExplorerReorder($event)"
            (collapse)="collapseExplorer()"
          />
        </div>
      }
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
      height: 100%;
      background: var(--mat-sys-surface-container-lowest);
    }

    .editor-toolbar {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 0 0 auto;
      min-height: 34px;
      padding: 2px 5px 2px 7px;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
      user-select: none;
      cursor: context-menu;
    }

    .editor-toolbar.draggable {
      cursor: move;
    }

    .tabs {
      min-width: 0;
      flex: 1 1 auto;
    }

    .spacer {
      flex: 0 0 auto;
    }

    .dirty {
      flex: 0 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--mat-sys-tertiary);
      font: var(--mat-sys-label-medium);
      white-space: nowrap;
    }

    .config-toggle {
      flex: 0 0 28px;
      min-width: 0;
      width: 28px;
      height: 28px;
      padding: 0;
    }

    .config-toggle mat-icon {
      width: 16px;
      height: 16px;
      margin: 0;
      font-size: 16px;
      line-height: 16px;
    }

    .editor-body {
      position: relative;
      display: flex;
      flex: 1;
      min-height: 0;
      min-width: 0;
    }

    .editor-body.collapsed {
      flex: 0 0 0;
      height: 0;
      overflow: hidden;
      visibility: hidden;
    }

    .editor-main {
      display: flex;
      flex: 1;
      min-width: 0;
      min-height: 0;
    }

    .explorer {
      flex: 0 0 auto;
      min-width: 0;
      max-width: 100%;
    }

    .explorer-resizer {
      flex: 0 0 6px;
      min-width: 6px;
      cursor: ew-resize;
      touch-action: none;
      background: transparent;
    }

    .explorer-resizer:focus-visible {
      outline: 2px solid var(--mat-sys-primary);
      outline-offset: -2px;
      background: color-mix(in srgb, var(--mat-sys-primary) 20%, transparent);
    }

    .explorer-reopen {
      position: absolute;
      left: 8px;
      top: 10px;
      z-index: 4;
      min-width: 0;
      width: 32px;
      height: 32px;
      padding: 0;
      border-radius: 999px;
    }

    .editor {
      flex: 1;
      min-width: 0;
    }

    .config {
      flex: 0 0 268px;
      max-width: 50%;
    }

    .explorer-scrim {
      position: absolute;
      inset: 0;
      z-index: 3;
      border: 0;
      background: color-mix(in srgb, var(--mat-sys-shadow) 24%, transparent);
      cursor: default;
    }

    .explorer-overlay {
      position: absolute;
      inset: 0 auto 0 0;
      z-index: 4;
      display: flex;
      max-width: min(86%, 400px);
      pointer-events: none;
    }

    .overlay-panel {
      pointer-events: auto;
      width: min(86vw, 400px);
      max-width: 100%;
      box-shadow: var(--mat-sys-level3);
    }

    /*
     * On a narrow panel the settings sit *under* the editor rather than beside
     * it: 268px of controls next to 200px of code is not an editor with a
     * sidebar, it is two things that have both stopped working.
     */
    @container (max-width: 640px) {
      .editor-main {
        flex-direction: column;
      }

      .config {
        flex: 0 0 auto;
        max-width: none;
        max-height: 45%;
        border-left: 0;
        border-top: 1px solid var(--mat-sys-outline-variant);
      }
    }

    .empty {
      display: grid;
      place-items: center;
      height: 100%;
      width: 100%;
      margin: 0;
      color: var(--mat-sys-on-surface-variant);
    }
  `,
  host: {
    style: 'container-type: inline-size',
  },
})
export class EditorPanel {
  protected readonly store = inject(ShaderStore);
  protected readonly preferences = inject(Preferences);
  protected readonly settings = inject(EditorSettings);
  protected readonly workspace = inject(WorkspaceActions);
  protected readonly status = inject(DocumentStatus);
  protected readonly groups = inject(EditorGroups);
  protected readonly fileExplorerLimits = FILE_EXPLORER_LIMITS;

  /**
   * The group whose tabs and active document this panel shows. Absent means the
   * legacy lone editor: the default group's tabs, `store.activeDoc()` and every
   * navigation request, even for a document a group nobody renders owns.
   */
  readonly groupId = input<EditorGroupId | null>(null);
  /** The surface framing this panel, for its window controls; default when absent. */
  readonly surfaceId = input<SurfaceId>(editorSurfaceId(DEFAULT_EDITOR_GROUP_ID));
  readonly collapsed = input(false);
  readonly dragEnabled = input(false);
  readonly dragStart = output<PointerEvent>();

  private readonly documentRef = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly editor = viewChild<EditorSurface>('editorSurface');
  private readonly explorerPanel = viewChild(ExplorerPanel);
  private readonly tabs = viewChild(EditorTabs);

  protected readonly configOpen = signal(false);
  private readonly narrow = signal(false);
  private readonly overlayDismissed = signal(false);
  private readonly liveExplorerWidth = signal<number | null>(null);
  private stopExplorerResize: (() => void) | null = null;

  protected readonly ownGroupId = computed(() => this.groupId() ?? DEFAULT_EDITOR_GROUP_ID);
  /**
   * With an explicit group, that group's document, not `store.activeDoc()`: the
   * store's is one global pick, and every panel would otherwise show the same file.
   */
  protected readonly activeDoc = computed<EditorDocument | null>(() => {
    if (this.groupId() === null) return this.store.activeDoc();
    const id = this.groups.activeDocumentId(this.groupId()!);
    return (id && this.store.documents().find((doc) => doc.id === id)) || null;
  });
  protected readonly explorerPreferredOpen = computed(
    () => this.preferences.value().fileExplorerOpen,
  );
  protected readonly explorerWidth = computed(
    () => this.liveExplorerWidth() ?? this.preferences.value().fileExplorerWidth,
  );
  protected readonly explorerTree = computed(() =>
    buildExplorerTree({
      view: this.preferences.value().fileExplorerView,
      loading: this.store.loading(),
      project: this.store.project(),
      documents: this.store.documents(),
      activeDocId: this.activeDoc()?.id ?? null,
      dirty: this.store.dirty(),
      compiling: this.store.compiling(),
      errorCountFor: (docId) => this.store.errorCountFor(docId),
      renderOrder: this.store.renderOrder(),
      canAddBuffer: this.store.canAddBuffer(),
    }),
  );
  protected readonly explorerDocked = computed(
    () => !this.collapsed() && this.explorerPreferredOpen() && !this.narrow(),
  );
  protected readonly explorerOverlayAvailable = computed(
    () => !this.collapsed() && this.explorerPreferredOpen() && this.narrow(),
  );
  protected readonly explorerOverlayOpen = computed(
    () => this.explorerOverlayAvailable() && !this.overlayDismissed(),
  );
  protected readonly showExplorerReopen = computed(
    () =>
      !this.collapsed() &&
      (!this.explorerPreferredOpen() ||
        (this.explorerOverlayAvailable() && !this.explorerOverlayOpen())),
  );

  /** The open document, in the shape the editor wants. */
  protected readonly editorDoc = computed<EditorDoc | null>(() => {
    const doc = this.activeDoc();
    return doc ? { id: doc.id, language: doc.language, value: doc.source } : null;
  });

  /** Every document that still exists — the editor drops the models of the rest. */
  protected readonly liveIds = computed(() => this.store.documents().map((doc) => doc.id));

  /** The open document, when it is a pass: what the settings panel configures. */
  protected readonly activePass = computed(() => {
    const doc = this.activeDoc();
    const project = this.store.project();
    if (!doc || !project || doc.kind !== 'pass') return null;

    const pass = findPass(project, doc.id);
    // Common is not rendered, so it has no channels, no target and nothing to
    // configure. Showing it an empty settings panel would only raise the question.
    return pass && pass.kind !== 'common' ? pass : null;
  });

  protected readonly activeDiagnostics = computed(() =>
    this.store.diagnosticsFor(this.activeDoc()?.id ?? ''),
  );

  private readonly editorNavigation = inject(EditorNavigation);

  constructor() {
    afterNextRender(() => this.observeEditorWidth());

    // The Problems panel does not hold a reference to `CodeEditor` — it asks
    // through `EditorNavigation` instead, and this is the one place that picks
    // the request up and acts on it, the same way `reveal` below used to for a
    // click on the (now removed) inline diagnostics list.
    effect(() => {
      const request = this.editorNavigation.request();
      if (!request) return;
      untracked(() => this.handleNavigation(request));
    });

    effect(() => {
      this.collapsed();
      this.explorerDocked();
      this.explorerOverlayOpen();
      this.explorerWidth();
      this.configOpen();
      untracked(() => this.scheduleRelayout());
    });

    effect(() => {
      if (!this.narrow()) {
        this.overlayDismissed.set(false);
      }
    });

    this.destroyRef.onDestroy(() => this.stopExplorerResize?.());
  }

  relayout(): void {
    this.editor()?.layout();
  }

  focusEditor(): void {
    this.editor()?.focus();
  }

  protected selectDoc(id: string): void {
    this.groups.activate(id, this.ownGroupId());
    queueMicrotask(() => this.relayout());
  }

  protected onTabClosed(nextActiveId: string | null): void {
    if (nextActiveId) {
      queueMicrotask(() => {
        this.tabs()?.focusTab(nextActiveId);
        this.relayout();
      });
      return;
    }
    queueMicrotask(() => this.focusEditor());
  }

  protected setExplorerView(view: ExplorerViewMode): void {
    this.preferences.patch({ fileExplorerView: view });
  }

  protected onExplorerSelect(event: ExplorerSelectEvent): void {
    this.selectDoc(event.docId);
  }

  protected async onExplorerCommand(event: ExplorerCommandEvent): Promise<void> {
    await this.workspace.runExplorerCommand(event.command, event.docId);
    queueMicrotask(() => {
      if (this.explorerDocked() || this.explorerOverlayOpen()) {
        this.explorerPanel()?.focusNode(event.docId ?? this.activeDoc()?.id ?? null);
      } else {
        this.focusEditor();
      }
      this.relayout();
    });
  }

  protected onExplorerReorder(intent: ExplorerReorderIntent): void {
    this.workspace.reorderExplorer(intent);
    queueMicrotask(() => this.relayout());
  }

  protected collapseExplorer(): void {
    this.preferences.patch({ fileExplorerOpen: false });
    this.overlayDismissed.set(false);
    queueMicrotask(() => this.focusEditor());
  }

  protected reopenExplorer(): void {
    if (!this.explorerPreferredOpen()) {
      this.preferences.patch({ fileExplorerOpen: true });
    }
    this.overlayDismissed.set(false);
    queueMicrotask(() => {
      if (this.explorerDocked() || this.explorerOverlayOpen()) {
        this.explorerPanel()?.focusNode(this.activeDoc()?.id ?? null);
      }
    });
  }

  protected closeExplorerOverlay(): void {
    if (!this.explorerOverlayOpen()) return;
    this.overlayDismissed.set(true);
    queueMicrotask(() => this.focusEditor());
  }

  protected onOverlayEscape(): void {
    this.closeExplorerOverlay();
  }

  protected startExplorerResize(event: PointerEvent): void {
    if (!this.isBrowser || event.button !== 0 || !this.explorerDocked()) return;

    event.preventDefault();
    const startX = event.clientX;
    const startWidth = this.explorerWidth();
    const target = event.currentTarget as HTMLElement | null;
    target?.setPointerCapture?.(event.pointerId);

    const move = (moveEvent: PointerEvent) => {
      this.liveExplorerWidth.set(
        clampFileExplorerWidth(startWidth + moveEvent.clientX - startX, startWidth),
      );
      this.relayout();
    };
    const finish = (finishEvent: PointerEvent) => {
      const width = clampFileExplorerWidth(startWidth + finishEvent.clientX - startX, startWidth);
      this.preferences.patch({ fileExplorerWidth: width });
      this.liveExplorerWidth.set(null);
      target?.releasePointerCapture?.(event.pointerId);
      this.stopExplorerResize?.();
      this.scheduleRelayout();
    };

    this.bindExplorerResize(move, finish);
  }

  protected onExplorerResizeKeydown(event: KeyboardEvent): void {
    if (!this.explorerDocked()) return;

    const step = event.shiftKey ? 32 : 16;
    const key = event.key;
    let next: number | null = null;

    if (key === 'ArrowLeft') next = this.explorerWidth() - step;
    if (key === 'ArrowRight') next = this.explorerWidth() + step;
    if (key === 'Home') next = FILE_EXPLORER_LIMITS.width.min;
    if (key === 'End') next = FILE_EXPLORER_LIMITS.width.max;
    if (next === null) return;

    event.preventDefault();
    this.preferences.patch({
      fileExplorerWidth: clampFileExplorerWidth(next, this.preferences.value().fileExplorerWidth),
    });
    this.scheduleRelayout();
  }

  /**
   * Select the document a navigation request names and put the cursor on its
   * line.
   *
   * The reveal is *handed to* the editor rather than performed by the caller,
   * because the document it names is usually not mounted yet — mounting happens
   * in an effect, and effects have not run. `CodeEditor.revealIn` holds the
   * request until the model is in.
   */
  private handleNavigation(request: EditorLocationRequest): void {
    const resolved = resolveNavigationTarget(
      request,
      this.store.documents().map((doc) => doc.id),
      this.activeDoc()?.id ?? null,
    );
    if (!resolved || !this.ownsNavigation(resolved.docId)) return;

    this.groups.activate(resolved.docId, this.ownGroupId());

    if (resolved.reveal) this.editor()?.revealIn(resolved.docId, resolved.line);
    else this.focusEditor();

    queueMicrotask(() => this.relayout());
  }

  /**
   * With explicit groups, every mounted panel sees every navigation request; only the one whose group
   * holds the document (or, for a document no group holds, the active group)
   * acts on it — the rest would pull the document's tab into their own strip.
   */
  private ownsNavigation(docId: string): boolean {
    if (this.groupId() === null) return true;
    const owner = this.groups.ownerGroupId(docId);
    if (owner) return owner === this.groupId();
    return (this.groups.activeGroupId() ?? this.groups.primaryGroupId) === this.groupId();
  }

  /** Format the source in the open tab. The config tab is JSON, and has none. */
  protected async formatSource(): Promise<void> {
    await this.editor()?.format();
  }

  protected onToolbarPointerDown(event: PointerEvent): void {
    if (!this.dragEnabled() || event.button !== 0) return;

    const target = event.target as HTMLElement | null;
    if (target?.closest('button, a, input, [role="tab"]')) return;

    this.dragStart.emit(event);
  }

  private observeEditorWidth(): void {
    const element = this.host.nativeElement;
    if (!this.isBrowser || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? element.getBoundingClientRect().width;
      this.narrow.set(width <= FILE_EXPLORER_OVERLAY_BREAKPOINT);
    });
    observer.observe(element);
    this.destroyRef.onDestroy(() => observer.disconnect());
  }

  private bindExplorerResize(
    onMove: (event: PointerEvent) => void,
    onFinish: (event: PointerEvent) => void,
  ): void {
    this.stopExplorerResize?.();

    const move = (event: Event) => onMove(event as PointerEvent);
    const finish = (event: Event) => onFinish(event as PointerEvent);
    const cancel = () => {
      this.liveExplorerWidth.set(null);
      this.stopExplorerResize?.();
      this.scheduleRelayout();
    };

    this.documentRef.addEventListener('pointermove', move);
    this.documentRef.addEventListener('pointerup', finish, { once: true });
    this.documentRef.addEventListener('pointercancel', cancel, { once: true });
    this.stopExplorerResize = () => {
      this.documentRef.removeEventListener('pointermove', move);
      this.documentRef.removeEventListener('pointerup', finish);
      this.documentRef.removeEventListener('pointercancel', cancel);
      this.stopExplorerResize = null;
    };
  }

  private scheduleRelayout(): void {
    if (!this.isBrowser) return;
    requestAnimationFrame(() => this.relayout());
  }
}
