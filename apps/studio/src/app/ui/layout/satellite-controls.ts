import { Component, inject, input } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

import { DesktopPlatform } from '../../desktop/desktop-platform';
import type { TranslationKey } from '../../i18n/keys';
import { TranslatePipe } from '../../i18n/translate.pipe';

/**
 * Dock and Close for a panel's native window. Both go through the surface
 * IPC, which lets a window act on its own surface only: Dock hands the panel
 * back to the main window, Close only hides it there — it stays detached.
 */
@Component({
  selector: 'app-satellite-controls',
  imports: [MatButtonModule, MatIconModule, MatTooltipModule, TranslatePipe],
  template: `
    <button
      matIconButton
      type="button"
      class="dock"
      [matTooltip]="'action.dockInMain' | translate"
      [attr.aria-label]="'action.dockInMain' | translate"
      (click)="dock()"
    >
      <mat-icon>{{ dockIcon() }}</mat-icon>
    </button>
    <button
      matIconButton
      type="button"
      class="close"
      [matTooltip]="closeLabel() | translate"
      [attr.aria-label]="closeLabel() | translate"
      (click)="close()"
    >
      <mat-icon>close</mat-icon>
    </button>
  `,
  styles: `
    :host {
      display: flex;
      align-items: center;
      flex: 0 0 auto;
    }

    button {
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
  `,
})
export class SatelliteControls {
  private readonly desktop = inject(DesktopPlatform);

  readonly surfaceId = input.required<string>();
  readonly dockIcon = input('dock_to_bottom');
  readonly closeLabel = input<TranslationKey>('action.close');

  protected dock(): void {
    void this.desktop.returnSurface(this.surfaceId()).catch(() => undefined);
  }

  protected close(): void {
    void this.desktop.closeSurface(this.surfaceId()).catch(() => undefined);
  }
}
