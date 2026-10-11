import { Component, computed, effect, inject, input } from '@angular/core';
import { Title } from '@angular/platform-browser';

import { DesktopPlatform } from '../../desktop/desktop-platform';
import type { TranslationKey } from '../../i18n/keys';
import { WindowTitlebar } from './window-titlebar';

/**
 * The title bar of a panel's native window: the main window's bar, with the
 * app icon where the menus are and "<panel> — Shadergrove" as the title (the
 * OS's too). Minimize and maximize act on this window; Close only hides the
 * panel there — it stays detached, as with the panel's own Close.
 */
@Component({
  selector: 'app-satellite-titlebar',
  imports: [WindowTitlebar],
  template: `
    <app-window-titlebar
      [title]="windowTitle()"
      [closeLabel]="closeLabel()"
      (closeRequest)="close()"
    >
      <img class="app-icon" src="assets/shadergrove-icon.svg" alt="" width="16" height="16" />
    </app-window-titlebar>
  `,
  styles: `
    :host {
      display: block;
      flex: 0 0 auto;
    }

    .app-icon {
      display: block;
      width: 16px;
      height: 16px;
      margin-inline-start: 4px;
      pointer-events: none;
    }
  `,
})
export class SatelliteTitlebar {
  private readonly desktop = inject(DesktopPlatform);

  readonly surfaceId = input.required<string>();
  /** The panel's name, already translated. */
  readonly panel = input.required<string>();
  readonly closeLabel = input<TranslationKey>('action.close');

  protected readonly windowTitle = computed(() => `${this.panel()} — Shadergrove`);

  constructor() {
    const title = inject(Title);
    effect(() => title.setTitle(this.windowTitle()));
  }

  protected close(): void {
    void this.desktop.closeSurface(this.surfaceId()).catch(() => undefined);
  }
}
