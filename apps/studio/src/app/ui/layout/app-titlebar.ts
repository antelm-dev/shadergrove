import { Component, computed, inject } from '@angular/core';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';

import { DesktopPlatform } from '../../desktop/desktop-platform';
import { Preferences } from '../../prefs/preferences';
import { AppThemes } from '../../themes/app-themes';
import { ThemeMenu } from '../../themes/theme-menu';
import { ShaderStore } from '../../workspace/shader-store';
import { I18n } from '../../i18n/i18n';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { DocumentStatus } from '../editor/document-status';
import { PluginCommands } from '../../plugins/plugin-commands';
import { MenuCommands, type MenuCommand } from '../menu-commands';
import { SurfaceLayoutService } from '../../surfaces';
import { WorkspaceActions } from '../workspace-actions';
import { WindowTitlebar } from './window-titlebar';

@Component({
  selector: 'app-titlebar',
  imports: [
    MatDividerModule,
    MatIconModule,
    MatMenuModule,
    MatTooltipModule,
    ThemeMenu,
    TranslatePipe,
    WindowTitlebar,
  ],
  template: `
    <app-window-titlebar [title]="title()" (closeRequest)="desktop.close()">
      <nav class="menus no-drag" [attr.aria-label]="'menu.application' | translate">
        <button type="button" class="menu-trigger" [matMenuTriggerFor]="fileMenu">
          {{ 'menu.file' | translate }}
        </button>
        <button type="button" class="menu-trigger" [matMenuTriggerFor]="viewMenu">
          {{ 'menu.view' | translate }}
        </button>
        <button type="button" class="menu-trigger" [matMenuTriggerFor]="windowMenu">
          {{ 'menu.window' | translate }}
        </button>
        <button type="button" class="menu-trigger" [matMenuTriggerFor]="helpMenu">
          {{ 'menu.help' | translate }}
        </button>
      </nav>
    </app-window-titlebar>

    <mat-menu #fileMenu="matMenu">
      @for (item of newCommands; track item.id) {
        <button mat-menu-item type="button" (click)="item.action()">
          <mat-icon>{{ item.icon() }}</mat-icon>
          <span>{{ item.label() }}</span>
        </button>
      }
      <mat-divider />
      @for (item of importExportCommands(); track item.id) {
        <button
          mat-menu-item
          type="button"
          [disabled]="item.disabled?.() ?? false"
          (click)="item.action()"
        >
          <mat-icon>{{ item.icon() }}</mat-icon>
          <span>{{ item.label() }}</span>
        </button>
      }
      <mat-divider />
      <!-- Save carries the tooltip that explains why it is dimmed, so it keeps
           its own markup — see the toolbar's save button. -->
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
      <mat-divider />
      <button mat-menu-item type="button" (click)="desktop.close()">
        <mat-icon>logout</mat-icon>
        <span>{{ 'action.quit' | translate }}</span>
      </button>
    </mat-menu>

    <mat-menu #viewMenu="matMenu">
      @for (item of viewCommands; track item.id) {
        <button mat-menu-item type="button" (click)="item.action()">
          <mat-icon>{{ item.icon() }}</mat-icon>
          <span>{{ item.label() }}</span>
          @if (item.shortcut) {
            <span class="menu-hint">{{ item.shortcut }}</span>
          }
        </button>
      }
      <mat-divider />
      <button mat-menu-item type="button" [matMenuTriggerFor]="themeMenu.menu()">
        <mat-icon>{{ themes.icon() }}</mat-icon>
        <span>{{ 'menu.theme' | translate }}</span>
      </button>
      <button mat-menu-item type="button" (click)="workspace.openEditorSettings()">
        <mat-icon>settings</mat-icon>
        <span>{{ 'menu.editorAppearance' | translate }}</span>
      </button>
      <mat-divider />
      @for (item of captureCommands; track item.id) {
        <button mat-menu-item type="button" (click)="item.action()">
          <mat-icon>{{ item.icon() }}</mat-icon>
          <span>{{ item.label() }}</span>
          @if (item.shortcut) {
            <span class="menu-hint">{{ item.shortcut }}</span>
          }
        </button>
      }
      <mat-divider />
      <button mat-menu-item type="button" (click)="desktop.toggleDevTools()">
        <mat-icon>code</mat-icon>
        <span>{{ 'menu.toggleDevTools' | translate }}</span>
        <span class="menu-hint">Ctrl+Shift+I</span>
      </button>
    </mat-menu>

    <app-theme-menu #themeMenu="appThemeMenu" />

    <mat-menu #windowMenu="matMenu">
      @for (item of windowCommands; track item.id) {
        <button mat-menu-item type="button" (click)="item.action()">
          <mat-icon>{{ item.icon() }}</mat-icon>
          <span>{{ item.label() }}</span>
        </button>
      }
      <mat-divider />
      <button mat-menu-item type="button" (click)="desktop.close()">
        <mat-icon>close</mat-icon>
        <span>{{ 'action.close' | translate }}</span>
      </button>
    </mat-menu>

    <mat-menu #helpMenu="matMenu">
      <button mat-menu-item type="button" (click)="workspace.openKeyboardShortcuts()">
        <mat-icon>keyboard</mat-icon>
        <span>{{ 'menu.keyboardShortcuts' | translate }}</span>
      </button>
      <button mat-menu-item type="button" (click)="desktop.openSupportLink('documentation')">
        <mat-icon>menu_book</mat-icon>
        <span>{{ 'menu.documentation' | translate }}</span>
      </button>
      <button mat-menu-item type="button" (click)="desktop.openSupportLink('issues')">
        <mat-icon>bug_report</mat-icon>
        <span>{{ 'menu.reportIssue' | translate }}</span>
      </button>
      <mat-divider />
      <button mat-menu-item type="button" (click)="workspace.checkForUpdates()">
        <mat-icon>system_update</mat-icon>
        <span>{{ 'menu.checkForUpdates' | translate }}</span>
      </button>
      <button mat-menu-item type="button" (click)="workspace.openAboutShadergrove()">
        <mat-icon>info</mat-icon>
        <span>{{ 'menu.aboutShadergrove' | translate }}</span>
      </button>
    </mat-menu>
  `,
  styles: `
    :host {
      display: block;
      flex: 0 0 auto;
      pointer-events: auto;
      z-index: 2;
    }

    .no-drag {
      -webkit-app-region: no-drag;
    }

    .menus {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-left: 8px;
    }

    .menu-trigger {
      margin: 0;
      padding: 2px 6px;
      border: 0;
      border-radius: 0;
      background: transparent;
      font: var(--mat-sys-label-small);
      font-weight: 400;
      letter-spacing: 0.01em;
      color: color-mix(in srgb, var(--mat-sys-on-surface-variant) 72%, transparent);
      cursor: pointer;
      transition: color 120ms ease;

      &:hover,
      &:focus-visible,
      &[aria-expanded='true'] {
        background: transparent;
        color: var(--mat-sys-on-surface);
        outline: none;
      }
    }
  `,
})
export class AppTitlebar {
  protected readonly desktop = inject(DesktopPlatform);
  protected readonly store = inject(ShaderStore);
  protected readonly workspace = inject(WorkspaceActions);
  protected readonly preferences = inject(Preferences);
  protected readonly status = inject(DocumentStatus);
  protected readonly i18n = inject(I18n);
  private readonly commands = inject(MenuCommands);
  private readonly pluginCommands = inject(PluginCommands);
  private readonly layout = inject(SurfaceLayoutService);

  protected readonly themes = inject(AppThemes);

  protected readonly title = computed(() => {
    const shader = this.store.record();
    return shader ? `${shader.name} — Shadergrove` : 'Shadergrove';
  });

  // --- Menus --------------------------------------------------------------
  // One group of one menu each — the groups the dividers separate. Save, Quit,
  // Close and the Theme submenu are none of them plain rows, and stay written
  // out above.

  protected readonly newCommands: readonly MenuCommand[] = [this.commands.newShader];

  /** The app's file commands and, between them, what the active plugins add. */
  protected readonly importExportCommands = computed<readonly MenuCommand[]>(() => [
    this.commands.import('rename', 'action.import'),
    this.commands.import('overwrite', 'action.importReplace'),
    ...this.pluginCommands.imports(),
    this.commands.exportShader,
    ...this.pluginCommands.exports(),
    this.commands.exportAll,
  ]);

  protected readonly viewCommands: readonly MenuCommand[] = [
    {
      id: 'toggle-browser',
      icon: () => 'view_sidebar',
      label: () =>
        this.i18n.t(
          this.preferences.value().browserOpen ? 'action.hideBrowser' : 'action.showBrowser',
        ),
      action: () => this.commands.toggle('browserOpen'),
    },
    {
      id: 'toggle-controls',
      icon: () => 'tune',
      label: () =>
        this.i18n.t(this.layout.inspectorOpen() ? 'action.hideControls' : 'action.showControls'),
      shortcut: 'H',
      action: () => this.layout.toggleInspectorOpen(),
    },
    this.commands.toggleEditor,
    this.commands.zenMode,
  ];

  protected readonly captureCommands: readonly MenuCommand[] = [
    {
      id: 'screenshot',
      icon: () => 'photo_camera',
      label: () => this.i18n.t('action.screenshot'),
      shortcut: 'S',
      action: () => this.commands.captureImage(),
    },
    this.commands.exportSequence,
    {
      id: 'toggle-fullscreen',
      icon: () => (this.desktop.fullscreen() ? 'fullscreen_exit' : 'fullscreen'),
      label: () =>
        this.i18n.t(this.desktop.fullscreen() ? 'action.exitFullscreen' : 'action.enterFullscreen'),
      shortcut: 'F11',
      action: () => this.desktop.toggleFullscreen(),
    },
  ];

  protected readonly windowCommands: readonly MenuCommand[] = [
    {
      id: 'minimize',
      icon: () => 'remove',
      label: () => this.i18n.t('action.minimize'),
      action: () => this.desktop.minimize(),
    },
    {
      id: 'maximize',
      icon: () => (this.desktop.maximized() ? 'filter_none' : 'crop_square'),
      label: () => this.i18n.t(this.desktop.maximized() ? 'action.restore' : 'action.maximize'),
      action: () => this.desktop.toggleMaximize(),
    },
  ];
}
