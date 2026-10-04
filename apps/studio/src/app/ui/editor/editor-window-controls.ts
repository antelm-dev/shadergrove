import { Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';

import { EDITOR_DOCK_SIDES, type EditorDockSide } from '@shadergrove/shared/editor-prefs';
import { COMPACT_VIEWPORT_WIDTH, isContainedPlacement } from '@shadergrove/shared/surfaces';
import { SurfaceLayoutService, SurfaceRegistry, describeSurfaceCommands } from '../../surfaces';
import { I18n } from '../../i18n/i18n';
import { TranslatePipe } from '../../i18n/translate.pipe';
import type { TranslationKey } from '../../i18n/keys';
import { WorkspaceActions } from '../workspace-actions';

const DOCK_LABELS: Record<EditorDockSide, TranslationKey> = {
  bottom: 'editor.dockBottom',
  left: 'editor.dockLeft',
  right: 'editor.dockRight',
};

const DOCK_ICONS: Record<EditorDockSide, string> = {
  bottom: 'dock_to_bottom',
  left: 'dock_to_left',
  right: 'dock_to_right',
};

@Component({
  selector: 'app-editor-window-controls',
  imports: [MatButtonModule, MatIconModule, MatMenuModule, MatTooltipModule, TranslatePipe],
  template: `
    <button
      matIconButton
      type="button"
      class="control"
      [matTooltip]="'editor.windowMenu' | translate"
      [attr.aria-label]="'editor.windowMenuAria' | translate"
      [matMenuTriggerFor]="windowMenu"
    >
      <mat-icon>more_vert</mat-icon>
    </button>

    <mat-menu #windowMenu="matMenu">
      <button mat-menu-item type="button" (click)="workspace.openEditorSettings()">
        <mat-icon>tune</mat-icon>
        <span>{{ 'action.appearance' | translate }}</span>
      </button>
      @if (!compact()) {
        <button mat-menu-item type="button" (click)="layout.float(editorId)">
          <mat-icon>open_in_new</mat-icon>
          <span>{{ 'action.detach' | translate }}</span>
        </button>
      }
      @for (side of dockSides; track side) {
        <button
          mat-menu-item
          type="button"
          [attr.aria-checked]="dockedOn(side)"
          (click)="layout.dock(editorId, side)"
        >
          <mat-icon>{{ dockIcon(side) }}</mat-icon>
          <span>{{ dockLabel(side) }}</span>
          @if (dockedOn(side)) {
            <mat-icon class="check" aria-hidden="true">check</mat-icon>
          }
        </button>
      }
    </mat-menu>

    <button
      matIconButton
      type="button"
      class="control"
      [matTooltip]="(minimized() ? 'editor.expand' : 'editor.collapse') | translate"
      [attr.aria-label]="(minimized() ? 'editor.expand' : 'editor.collapse') | translate"
      [attr.aria-expanded]="!minimized()"
      (click)="layout.toggleMinimized(editorId)"
    >
      <mat-icon>{{ minimized() ? 'expand_less' : 'minimize' }}</mat-icon>
    </button>

    <button
      matIconButton
      type="button"
      class="control"
      [matTooltip]="(maximized() ? 'editor.restore' : 'editor.maximize') | translate"
      [attr.aria-label]="(maximized() ? 'editor.restore' : 'editor.maximize') | translate"
      [attr.aria-pressed]="maximized()"
      (click)="layout.toggleMaximized(editorId)"
    >
      <mat-icon>{{ maximized() ? 'close_fullscreen' : 'open_in_full' }}</mat-icon>
    </button>

    <button
      matIconButton
      type="button"
      class="control"
      [matTooltip]="'editor.close' | translate"
      [attr.aria-label]="'editor.close' | translate"
      (click)="layout.close(editorId)"
    >
      <mat-icon>close</mat-icon>
    </button>
  `,
  styles: `
    :host {
      display: flex;
      align-items: center;
      flex: 0 0 auto;
      gap: 0;
    }

    .control {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      width: 28px;
      height: 28px;
      padding: 6px;
      --mat-icon-button-state-layer-size: 28px;
      --mat-icon-button-icon-size: 16px;
    }

    .control mat-icon {
      width: 16px;
      height: 16px;
      font-size: 16px;
      line-height: 16px;
    }

    .check {
      margin-left: auto;
    }
  `,
})
export class EditorWindowControls {
  protected readonly layout = inject(SurfaceLayoutService);
  protected readonly registry = inject(SurfaceRegistry);
  protected readonly workspace = inject(WorkspaceActions);
  private readonly i18n = inject(I18n);
  protected readonly dockSides = EDITOR_DOCK_SIDES;
  protected readonly editorId = this.layout.editorId;

  private readonly surface = computed(() => this.layout.editor());

  protected readonly compact = computed(() => {
    const { width } = this.registry.viewport();
    return width > 0 && width < COMPACT_VIEWPORT_WIDTH;
  });

  protected readonly maximized = computed(() => {
    const placement = this.surface().placement;
    return isContainedPlacement(placement) && placement.mode === 'maximized';
  });

  protected readonly minimized = computed(() => {
    const placement = this.surface().placement;
    return isContainedPlacement(placement) && placement.mode === 'minimized';
  });

  private readonly activeDockSide = computed(() => this.layout.editorDockSide());

  protected dockedOn(side: EditorDockSide): boolean {
    return this.activeDockSide() === side;
  }

  protected dockLabel(side: EditorDockSide): string {
    return this.i18n.t(DOCK_LABELS[side]);
  }

  protected dockIcon(side: EditorDockSide): string {
    return DOCK_ICONS[side];
  }

  /** Capability-filtered commands for future menu wiring. */
  protected readonly commands = computed(() =>
    describeSurfaceCommands(this.surface(), this.layout.commandContext()),
  );
}
