import { Component, inject } from '@angular/core';
import { MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';

import type { Preset } from '@shadergrove/shared/model';
import { InspectorSession } from './inspector-session';
import { I18n } from '../../i18n/i18n';
import { TranslatePipe } from '../../i18n/translate.pipe';

/** The Presets tab. Its heading and its save action belong to `InspectorPanel`. */
@Component({
  selector: 'app-preset-panel',
  imports: [MatChipsModule, MatIconModule, MatMenuModule, TranslatePipe],
  template: `
    @if (session.presets().length === 0) {
      <p class="empty">
        {{ 'inspector.presetsEmpty' | translate }}
      </p>
    } @else {
      <mat-chip-listbox
        class="presets"
        [attr.aria-label]="'inspector.presets' | translate"
        [value]="session.activePresetId()"
        (change)="apply($event.value)"
      >
        @for (preset of session.presets(); track preset.id) {
          <mat-chip-option
            class="preset-chip"
            [value]="preset.id"
            [selected]="preset.id === session.activePresetId()"
            [title]="hint(preset)"
            [matContextMenuTriggerFor]="presetMenu"
            [matContextMenuTriggerData]="{ preset }"
          >
            @if (preset.render) {
              <mat-icon matChipAvatar aria-hidden="true">tune</mat-icon>
            }
            {{ preset.name }}
          </mat-chip-option>
        }
      </mat-chip-listbox>
    }

    <mat-menu #presetMenu="matMenu">
      <ng-template matMenuContent let-preset="preset">
        <button mat-menu-item type="button" (click)="session.deletePreset(preset.id, preset.name)">
          <mat-icon>delete</mat-icon>
          <span>{{ 'action.delete' | translate }}</span>
        </button>
      </ng-template>
    </mat-menu>
  `,
  styles: `
    :host {
      display: block;
      padding: 0 12px;
    }

    .presets {
      --mdc-chip-container-height: 30px;
    }

    .preset-chip {
      cursor: context-menu;
    }

    .empty {
      margin: 0;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }
  `,
})
export class PresetPanel {
  protected readonly session = inject(InspectorSession);
  private readonly i18n = inject(I18n);

  protected apply(presetId: string | null): void {
    if (presetId) this.session.applyPreset(presetId);
  }

  protected hint(preset: Preset): string {
    return this.i18n.t(preset.render ? 'inspector.presetWithRender' : 'inspector.presetValuesOnly');
  }
}
