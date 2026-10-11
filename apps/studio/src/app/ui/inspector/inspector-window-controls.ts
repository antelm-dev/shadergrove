import { Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';

import { isContainedPlacement } from '@shadergrove/shared/surfaces';
import { DesktopPlatform } from '../../desktop/desktop-platform';
import { SurfaceLayoutService } from '../../surfaces';
import { TranslatePipe } from '../../i18n/translate.pipe';

/**
 * The inspector's own window chrome: float / dock right / reset geometry /
 * close live in the overflow menu (there is only one dock side, so "dock"
 * reduces to a single toggle against float); minimize and maximize stay as
 * separate always-visible buttons, matching the editor and preview shells.
 *
 * Lives inside `InspectorPanel`'s header so it is reachable whether the
 * inspector is docked or floating — the affordance to float it can only ever
 * live somewhere that is visible *before* it floats.
 */
@Component({
  selector: 'app-inspector-window-controls',
  imports: [
    MatButtonModule,
    MatDividerModule,
    MatIconModule,
    MatMenuModule,
    MatTooltipModule,
    TranslatePipe,
  ],
  template: `
    <button
      matIconButton
      type="button"
      class="control"
      [matTooltip]="'inspector.windowMenu' | translate"
      [attr.aria-label]="'inspector.windowMenuAria' | translate"
      [matMenuTriggerFor]="windowMenu"
    >
      <mat-icon>more_vert</mat-icon>
    </button>

    <mat-menu #windowMenu="matMenu">
      <button mat-menu-item type="button" [attr.aria-checked]="floating()" (click)="float()">
        <mat-icon>open_in_new</mat-icon>
        <span>{{ 'action.detach' | translate }}</span>
        @if (floating()) {
          <mat-icon class="check" aria-hidden="true">check</mat-icon>
        }
      </button>
      @if (desktop.available) {
        <button mat-menu-item type="button" class="open-in-window" (click)="openInWindow()">
          <mat-icon>select_window</mat-icon>
          <span>{{ 'action.openInWindow' | translate }}</span>
        </button>
      }
      <button mat-menu-item type="button" [attr.aria-checked]="dockedRight()" (click)="dock()">
        <mat-icon>dock_to_right</mat-icon>
        <span>{{ 'inspector.dockRight' | translate }}</span>
        @if (dockedRight()) {
          <mat-icon class="check" aria-hidden="true">check</mat-icon>
        }
      </button>
      <mat-divider />
      <button mat-menu-item type="button" (click)="layout.resetGeometry(inspectorId)">
        <mat-icon>aspect_ratio</mat-icon>
        <span>{{ 'action.resetWindow' | translate }}</span>
      </button>
      <mat-divider />
      <button mat-menu-item type="button" (click)="layout.close(inspectorId)">
        <mat-icon>close</mat-icon>
        <span>{{ 'inspector.closeWindow' | translate }}</span>
      </button>
    </mat-menu>

    <button
      matIconButton
      type="button"
      class="control"
      [matTooltip]="
        (minimized() ? 'inspector.expandWindow' : 'inspector.minimizeWindow') | translate
      "
      [attr.aria-label]="
        (minimized() ? 'inspector.expandWindow' : 'inspector.minimizeWindow') | translate
      "
      [attr.aria-expanded]="!minimized()"
      (click)="layout.toggleMinimized(inspectorId)"
    >
      <mat-icon>{{ minimized() ? 'expand_less' : 'minimize' }}</mat-icon>
    </button>

    <button
      matIconButton
      type="button"
      class="control"
      [matTooltip]="
        (maximized() ? 'inspector.restoreWindow' : 'inspector.maximizeWindow') | translate
      "
      [attr.aria-label]="
        (maximized() ? 'inspector.restoreWindow' : 'inspector.maximizeWindow') | translate
      "
      [attr.aria-pressed]="maximized()"
      (click)="layout.toggleMaximized(inspectorId)"
    >
      <mat-icon>{{ maximized() ? 'close_fullscreen' : 'open_in_full' }}</mat-icon>
    </button>
  `,
  styles: `
    :host {
      display: flex;
      align-items: center;
      gap: 0;
    }

    .control {
      width: 28px;
      height: 28px;
      padding: 5px;
      --mat-icon-button-state-layer-size: 28px;
      --mat-icon-button-icon-size: 16px;
    }

    .check {
      margin-left: auto;
    }
  `,
})
export class InspectorWindowControls {
  protected readonly layout = inject(SurfaceLayoutService);
  protected readonly desktop = inject(DesktopPlatform);
  protected readonly inspectorId = this.layout.inspectorId;

  private readonly surface = computed(() => this.layout.inspector());

  protected readonly floating = computed(() => {
    const placement = this.surface().placement;
    return isContainedPlacement(placement) && placement.mode === 'floating';
  });

  protected readonly dockedRight = computed(() => {
    const placement = this.surface().placement;
    if (!isContainedPlacement(placement)) return false;
    if (placement.mode === 'docked') return placement.side === 'right';
    if (
      (placement.mode === 'maximized' || placement.mode === 'minimized') &&
      placement.restore.mode === 'docked'
    ) {
      return placement.restore.side === 'right';
    }
    return false;
  });

  protected readonly maximized = computed(() => {
    const placement = this.surface().placement;
    return isContainedPlacement(placement) && placement.mode === 'maximized';
  });

  protected readonly minimized = computed(() => {
    const placement = this.surface().placement;
    return isContainedPlacement(placement) && placement.mode === 'minimized';
  });

  protected float(): void {
    if (this.floating()) return;
    this.layout.float(this.inspectorId);
  }

  /** Desktop only: into a native window of its own, until docked again. */
  protected openInWindow(): void {
    void this.layout.detach(this.inspectorId);
  }

  protected dock(): void {
    if (this.dockedRight()) return;
    this.layout.dock(this.inspectorId, 'right');
  }
}
