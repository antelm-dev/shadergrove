import { Component, ElementRef, inject, input, output, viewChildren } from '@angular/core';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';

import { I18n } from '../../i18n/i18n';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { ShaderStore, type EditorDocument } from '../../workspace/shader-store';
import { DEFAULT_EDITOR_GROUP_ID, type EditorGroupId } from '@shadergrove/shared/surfaces';
import { EditorGroups } from './editor-groups';

/** What a tab is doing, which is what its dot is coloured for. */
export type TabState = 'idle' | 'compiling' | 'error' | 'ok';

/**
 * Open-document tab strip.
 *
 * Shows only documents currently opened for editing. Structural project actions
 * (create, rename, duplicate, delete, enable/disable, project reorder) live in
 * the explorer. Tabs open/activate/close, show compile/dirty/error/disabled
 * status, and may reorder the *session* open set — never the project.
 */
@Component({
  selector: 'app-editor-tabs',
  imports: [MatDividerModule, MatIconModule, MatMenuModule, MatTooltipModule, TranslatePipe],
  template: `
    <div class="tabs" role="tablist" [attr.aria-label]="'editor.documents' | translate">
      @for (doc of groups.openDocs(groupId()); track doc.id) {
        <div
          class="tab-wrap"
          [class.active]="doc.id === activeId()"
          [class.disabled-pass]="doc.enabled === false"
        >
          <button
            #tabButton
            type="button"
            role="tab"
            class="tab"
            [attr.data-doc-id]="doc.id"
            [attr.aria-selected]="doc.id === activeId()"
            [attr.tabindex]="doc.id === activeId() ? 0 : -1"
            [attr.draggable]="true"
            [matTooltip]="tooltip(doc)"
            [matContextMenuTriggerFor]="tabMenu"
            [matContextMenuTriggerData]="{ doc }"
            (click)="onSelect(doc.id)"
            (keydown)="onTabKeydown($event, doc)"
            (dragstart)="onDragStart($event, doc)"
            (dragover)="onDragOver($event, doc)"
            (drop)="onDrop($event, doc)"
            (auxclick)="onAuxClick($event, doc)"
          >
            <mat-icon class="tab-icon" aria-hidden="true">{{ icon(doc) }}</mat-icon>
            <span class="tab-name">{{ doc.name }}</span>

            @if (doc.kind === 'pass' || doc.kind === 'vertex' || doc.kind === 'config') {
              @if (errorCount(doc.id); as count) {
                <span class="badge error" [attr.aria-label]="count + ' errors'">{{ count }}</span>
              } @else {
                <span class="dot" [class]="state(doc)" aria-hidden="true"></span>
              }
            }
          </button>

          @if (groups.canClose(groupId())) {
            <button
              type="button"
              class="tab-close"
              [attr.aria-label]="'editor.closeTab' | translate: { name: doc.name }"
              [matTooltip]="'editor.closeTab' | translate: { name: doc.name }"
              (click)="onClose($event, doc)"
            >
              <mat-icon aria-hidden="true">close</mat-icon>
            </button>
          }
        </div>
      }
    </div>

    <mat-menu #tabMenu="matMenu">
      <ng-template matMenuContent let-doc="doc">
        <button
          mat-menu-item
          type="button"
          [disabled]="!groups.canClose(groupId())"
          (click)="onCloseMenu(doc)"
        >
          <mat-icon>close</mat-icon>
          <span>{{ 'editor.closeTabMenu' | translate }}</span>
        </button>
        <button
          mat-menu-item
          type="button"
          [disabled]="!groups.canClose(groupId())"
          (click)="groups.closeOthers(doc.id, groupId())"
        >
          <mat-icon>tab_close</mat-icon>
          <span>{{ 'editor.closeOtherTabs' | translate }}</span>
        </button>
        <mat-divider />
        <button mat-menu-item type="button" (click)="moveToNewGroup(doc)">
          <mat-icon>open_in_new</mat-icon>
          <span>{{ 'editor.moveToNewGroup' | translate }}</span>
        </button>
        @for (targetGroup of groups.otherGroupIds(groupId()); track targetGroup) {
          <button mat-menu-item type="button" (click)="moveToGroup(doc, targetGroup)">
            <mat-icon>drive_file_move</mat-icon>
            <span>{{ 'editor.moveToGroup' | translate: { id: targetGroup } }}</span>
          </button>
        }
        <button mat-menu-item type="button" disabled>
          <mat-icon>launch</mat-icon>
          <span>{{ 'editor.externalizeGroup' | translate }}</span>
        </button>
      </ng-template>
    </mat-menu>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
      overflow-x: auto;
      scrollbar-width: thin;
    }

    .tabs {
      display: flex;
      align-items: center;
      gap: 2px;
      min-width: min-content;
    }

    .tab-wrap {
      display: flex;
      align-items: center;
      flex: 0 0 auto;
      max-width: 196px;
      border-radius: var(--mat-sys-corner-small, 6px);
    }

    .tab-wrap:hover {
      background: color-mix(in srgb, var(--mat-sys-on-surface) 8%, transparent);
    }

    .tab-wrap.active {
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
    }

    .tab {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 1 1 auto;
      min-width: 0;
      height: 28px;
      padding-inline: 9px 4px;
      border: 0;
      border-radius: var(--mat-sys-corner-small, 6px);
      background: transparent;
      color: inherit;
      font: var(--mat-sys-label-medium);
      white-space: nowrap;
      cursor: pointer;
    }

    .tab-wrap:not(.active) .tab {
      color: var(--mat-sys-on-surface-variant);
    }

    /* A disabled buffer is still editable — it just is not in the picture. */
    .tab-wrap.disabled-pass .tab-name,
    .tab-wrap.disabled-pass .tab-icon {
      opacity: 0.5;
      text-decoration: line-through;
    }

    .tab-icon {
      flex: 0 0 auto;
      width: 15px;
      height: 15px;
      font-size: 15px;
    }

    .tab-name {
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .tab-close {
      display: inline-grid;
      place-items: center;
      flex: 0 0 auto;
      width: 22px;
      height: 22px;
      margin-inline-end: 4px;
      padding: 0;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: inherit;
      cursor: pointer;
      opacity: 0.7;
    }

    .tab-close:hover,
    .tab-close:focus-visible {
      opacity: 1;
      background: color-mix(in srgb, var(--mat-sys-on-surface) 12%, transparent);
    }

    .tab-close mat-icon {
      width: 14px;
      height: 14px;
      font-size: 14px;
    }

    .badge {
      display: inline-grid;
      place-items: center;
      min-width: 17px;
      height: 17px;
      padding: 0 4px;
      border-radius: 9px;
      font: var(--mat-sys-label-small);
    }

    .badge.error {
      background: var(--mat-sys-error);
      color: var(--mat-sys-on-error);
    }

    .dot {
      flex: 0 0 auto;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: transparent;
    }

    /* Unsaved. The one state that persists, so it is the one that is solid. */
    .dot.idle {
      background: var(--mat-sys-tertiary);
    }

    .dot.ok {
      background: color-mix(in srgb, var(--mat-sys-primary) 55%, transparent);
    }

    .dot.compiling {
      background: var(--mat-sys-on-surface-variant);
      animation: pulse 1s ease-in-out infinite;
    }

    @keyframes pulse {
      50% {
        opacity: 0.25;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .dot.compiling {
        animation: none;
      }
    }
  `,
})
export class EditorTabs {
  protected readonly store = inject(ShaderStore);
  protected readonly groups = inject(EditorGroups);
  private readonly i18n = inject(I18n);
  private readonly tabButtons = viewChildren<ElementRef<HTMLButtonElement>>('tabButton');

  readonly activeId = input<string | null>(null);
  readonly groupId = input<EditorGroupId>(DEFAULT_EDITOR_GROUP_ID);

  readonly select = output<string>();
  /** Emitted after a close so the panel can restore focus. */
  readonly closed = output<string | null>();

  protected icon(doc: EditorDocument): string {
    if (doc.kind === 'file') return 'description';
    if (doc.kind === 'vertex') return 'change_history';
    if (doc.kind === 'config') return 'data_object';

    switch (doc.passKind) {
      case 'image':
        return 'image';
      case 'common':
        return 'share';
      default:
        return 'layers';
    }
  }

  protected tooltip(doc: EditorDocument): string {
    switch (doc.passKind) {
      case 'image':
        return this.i18n.t('explorer.tooltip.imagePass');
      case 'common':
        return this.i18n.t('explorer.tooltip.commonPass');
      case 'buffer':
        return doc.enabled === false
          ? this.i18n.t('explorer.tooltip.bufferDisabled', { slot: doc.slot ?? '' })
          : this.i18n.t('explorer.tooltip.bufferPass', { slot: doc.slot ?? '' });
      default:
        break;
    }

    if (doc.kind === 'file') return this.i18n.t('explorer.tooltip.sourceFile', { name: doc.name });
    if (doc.kind === 'vertex') return this.i18n.t('explorer.tooltip.vertex');
    return this.i18n.t('explorer.tooltip.config');
  }

  protected errorCount(id: string): number {
    return this.store.errorCountFor(id);
  }

  /**
   * A tab's state is only ever about *this* pass. A project where Buffer B fails
   * to compile shows an error on Buffer B and a healthy Image pass.
   */
  protected state(doc: EditorDocument): TabState {
    if (this.store.compiling().has(doc.id)) return 'compiling';
    if (this.store.errorCountFor(doc.id) > 0) return 'error';
    return this.store.dirty() ? 'idle' : 'ok';
  }

  protected onSelect(id: string): void {
    this.select.emit(id);
  }

  protected onClose(event: Event, doc: EditorDocument): void {
    event.stopPropagation();
    event.preventDefault();
    this.closeTab(doc.id);
  }

  protected onCloseMenu(doc: EditorDocument): void {
    this.closeTab(doc.id);
  }

  protected onAuxClick(event: MouseEvent, doc: EditorDocument): void {
    // Middle-click closes when more than one tab is open.
    if (event.button !== 1 || !this.groups.canClose(this.groupId())) return;
    event.preventDefault();
    this.closeTab(doc.id);
  }

  protected onTabKeydown(event: KeyboardEvent, doc: EditorDocument): void {
    const ids = this.groups.openIds(this.groupId());
    const index = ids.indexOf(doc.id);
    if (index < 0) return;

    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const step = event.key === 'ArrowRight' ? 1 : -1;
      const next = ids[(index + step + ids.length) % ids.length];
      if (!next) return;
      this.select.emit(next);
      queueMicrotask(() => this.focusTab(next));
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      const first = ids[0];
      if (!first) return;
      this.select.emit(first);
      queueMicrotask(() => this.focusTab(first));
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      const last = ids[ids.length - 1];
      if (!last) return;
      this.select.emit(last);
      queueMicrotask(() => this.focusTab(last));
      return;
    }

    if (
      (event.key === 'Delete' || event.key === 'Backspace') &&
      this.groups.canClose(this.groupId())
    ) {
      event.preventDefault();
      this.closeTab(doc.id);
    }
  }

  private closeTab(docId: string): void {
    const closed = this.groups.close(docId, this.groupId());
    if (!closed) return;

    const nextActive = this.groups.activeDocumentId(this.groupId());
    this.closed.emit(nextActive);
    queueMicrotask(() => {
      if (nextActive) this.focusTab(nextActive);
    });
  }

  focusTab(docId: string): void {
    const button = this.tabButtons().find(
      (ref) => ref.nativeElement.getAttribute('data-doc-id') === docId,
    );
    button?.nativeElement.focus();
  }

  // --- Session-only reorder -----------------------------------------------

  private dragging: EditorDocument | null = null;

  protected onDragStart(event: DragEvent, doc: EditorDocument): void {
    this.dragging = doc;
    event.dataTransfer?.setData('text/plain', doc.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  protected onDragOver(event: DragEvent, doc: EditorDocument): void {
    if (!this.dragging || this.dragging.id === doc.id) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  }

  protected onDrop(event: DragEvent, doc: EditorDocument): void {
    const source = this.dragging;
    this.dragging = null;
    if (!source || source.id === doc.id) return;

    event.preventDefault();
    this.groups.reorder(source.id, doc.id, this.groupId());
  }

  protected moveToNewGroup(doc: EditorDocument): void {
    this.groups.moveToNewGroup(doc.id);
  }

  protected moveToGroup(doc: EditorDocument, targetGroupId: EditorGroupId): void {
    this.groups.moveDocument(doc.id, targetGroupId, { sourceGroupId: this.groupId() });
  }
}
