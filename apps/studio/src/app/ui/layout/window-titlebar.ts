import { Component, inject, input, output } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

import { DesktopPlatform } from '../../desktop/desktop-platform';
import type { TranslationKey } from '../../i18n/keys';
import { TranslatePipe } from '../../i18n/translate.pipe';

/**
 * The custom title bar of a frameless desktop window: the main window's and
 * every panel window's, so they look and behave alike. What leads it (the
 * application menus, or the app icon) is projected; the title is centred;
 * minimize and maximize act on the window it is drawn in, and Close is the
 * owner's to decide (`closeRequest`). The bar itself drags the window, and a
 * double-click on it maximizes or restores it.
 */
@Component({
  selector: 'app-window-titlebar',
  imports: [MatIconModule, MatTooltipModule, TranslatePipe],
  template: `
    <header class="titlebar" (dblclick)="onDblClick($event)">
      <div class="leading">
        <ng-content />
      </div>

      <div class="title" aria-hidden="true">
        <span class="title-text">{{ title() }}</span>
      </div>

      <div class="trailing no-drag">
        <button
          class="win-btn minimize"
          type="button"
          [matTooltip]="'action.minimize' | translate"
          [attr.aria-label]="'action.minimize' | translate"
          (click)="desktop.minimize()"
        >
          <mat-icon>remove</mat-icon>
        </button>
        <button
          class="win-btn maximize"
          type="button"
          [matTooltip]="(desktop.maximized() ? 'action.restore' : 'action.maximize') | translate"
          [attr.aria-label]="
            (desktop.maximized() ? 'action.restore' : 'action.maximize') | translate
          "
          (click)="desktop.toggleMaximize()"
        >
          <mat-icon>{{ desktop.maximized() ? 'filter_none' : 'crop_square' }}</mat-icon>
        </button>
        <button
          class="win-btn close"
          type="button"
          [matTooltip]="closeLabel() | translate"
          [attr.aria-label]="closeLabel() | translate"
          (click)="closeRequest.emit()"
        >
          <mat-icon>close</mat-icon>
        </button>
      </div>
    </header>
  `,
  styles: `
    :host {
      display: block;
      flex: 0 0 auto;
    }

    .titlebar {
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      align-items: center;
      height: 28px;
      padding-inline: 8px 0;
      background: var(--mat-sys-surface-container-lowest);
      border-bottom: 1px solid var(--mat-sys-outline-variant);
      -webkit-app-region: drag;
      user-select: none;
    }

    .leading,
    .trailing {
      display: flex;
      align-items: center;
      min-width: 0;
    }

    .leading {
      gap: 2px;
      justify-self: start;
    }

    .trailing {
      justify-self: end;
      height: 100%;
    }

    .no-drag {
      -webkit-app-region: no-drag;
    }

    .title {
      justify-self: center;
      max-width: 42vw;
      overflow: hidden;
      pointer-events: none;
    }

    .title-text {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-medium);
      opacity: 0.85;
    }

    .win-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 100%;
      margin: 0;
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--mat-sys-on-surface-variant);
      cursor: default;

      mat-icon {
        font-size: 14px;
        width: 14px;
        height: 14px;
      }

      &:hover {
        background: color-mix(in srgb, var(--mat-sys-on-surface) 8%, transparent);
        color: var(--mat-sys-on-surface);
      }

      &.close:hover {
        background: #e81123;
        color: #fff;
      }
    }
  `,
})
export class WindowTitlebar {
  protected readonly desktop = inject(DesktopPlatform);

  readonly title = input.required<string>();
  readonly closeLabel = input<TranslationKey>('action.close');
  readonly closeRequest = output<void>();

  protected onDblClick(event: MouseEvent): void {
    // Interactive pieces (the menus, the window buttons) opt out with `no-drag`.
    if ((event.target as HTMLElement | null)?.closest('.no-drag')) return;
    this.desktop.toggleMaximize();
  }
}
