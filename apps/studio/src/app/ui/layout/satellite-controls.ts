import { Component, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

import { DesktopPlatform } from '../../desktop/desktop-platform';
import type { TranslationKey } from '../../i18n/keys';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { SessionMirror } from '../../workspace/session-sync/session-mirror';
import type { SessionRefusal } from '../../workspace/session-sync/session-protocol';

/** How long a refused change is reported. */
const NOTICE_MS = 8_000;

const REFUSAL_KEYS: Record<SessionRefusal, TranslationKey> = {
  conflict: 'session.conflict',
  'too-large': 'session.tooLarge',
  'other-shader': 'session.refused',
  invalid: 'session.refused',
  failed: 'session.refused',
};

/**
 * Dock and Close for a panel's native window. Both go through the surface
 * IPC, which lets a window act on its own surface only: Dock hands the panel
 * back to the main window, Close only hides it there — it stays detached.
 * Beside them, a change the main window refused is reported for a while: the
 * window has already gone back to the main window's state.
 */
@Component({
  selector: 'app-satellite-controls',
  imports: [MatButtonModule, MatIconModule, MatTooltipModule, TranslatePipe],
  template: `
    <span class="notice" role="status">
      @if (notice(); as key) {
        {{ key | translate }}
      }
    </span>
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
      flex: 0 1 auto;
      min-width: 0;
    }

    .notice {
      min-width: 0;
      margin-inline-end: 6px;
      overflow: hidden;
      color: var(--mat-sys-error);
      font: var(--mat-sys-label-small);
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    button {
      flex: 0 0 auto;
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
  private readonly mirror = inject(SessionMirror);

  readonly surfaceId = input.required<string>();
  readonly dockIcon = input('dock_to_bottom');
  readonly closeLabel = input<TranslationKey>('action.close');

  protected readonly notice = signal<TranslationKey | null>(null);

  constructor() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    inject(DestroyRef).onDestroy(() => clearTimeout(timer));
    effect(() => {
      const refusal = this.mirror.refusal();
      if (!refusal) return;
      untracked(() => {
        clearTimeout(timer);
        this.notice.set(REFUSAL_KEYS[refusal.reason] ?? 'session.refused');
        timer = setTimeout(() => this.notice.set(null), NOTICE_MS);
      });
    });
  }

  protected dock(): void {
    void this.desktop.returnSurface(this.surfaceId()).catch(() => undefined);
  }

  protected close(): void {
    void this.desktop.closeSurface(this.surfaceId()).catch(() => undefined);
  }
}
