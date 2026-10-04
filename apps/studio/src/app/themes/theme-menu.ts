import { Component, computed, inject, viewChild } from '@angular/core';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatMenu, MatMenuModule } from '@angular/material/menu';

import { DEFAULT_THEMES_PACKAGE_ID } from '@shadergrove/shared/plugin';

import { I18n } from '../i18n/i18n';
import { TranslatePipe } from '../i18n/translate.pipe';
import { colorSchemeIcon } from '../prefs/preferences';
import { AppThemes } from './app-themes';
import { officialThemeKey, pairKey, type PluginThemeEntry, type ThemePair } from './theme-catalog';

/**
 * The Theme submenu: every theme of the active plugins — the official Light
 * and Dark included — and, for each light/dark pair, a System row that follows
 * the OS between them. Paired themes show their scheme's icon; any other a
 * swatch of its own colours. One menu for every place that offers it — the
 * web's More menu, the desktop title bar and the preview's — so the choice is
 * the same everywhere.
 *
 * Opened from a parent menu's item with `[matMenuTriggerFor]="themes.menu()"`.
 * Its rows are `menuitemradio`s: arrow keys move between them and the checked
 * one is announced.
 */
@Component({
  selector: 'app-theme-menu',
  exportAs: 'appThemeMenu',
  imports: [MatDividerModule, MatIconModule, MatMenuModule, TranslatePipe],
  template: `
    <mat-menu #menu="matMenu">
      @for (pair of themes.pairs(); track pair.key; let first = $first) {
        @if (!first) {
          <mat-divider />
        }
        @for (entry of [pair.light, pair.dark]; track entry.ref) {
          @let checked = themes.isFixed(entry.ref);
          <button
            mat-menu-item
            type="button"
            role="menuitemradio"
            [attr.aria-checked]="checked"
            [attr.data-testid]="'theme-option-' + entry.ref"
            (click)="themes.selectPlugin(entry.ref)"
          >
            <mat-icon>{{ schemeIcon(entry) }}</mat-icon>
            <span class="label">
              <span>{{ name(entry) }}</span>
              @if (!official(pair)) {
                <span class="by">{{ entry.packageName }}</span>
              }
            </span>
            @if (checked) {
              <mat-icon class="theme-check" aria-hidden="true">check</mat-icon>
            }
          </button>
        }
        @let system = themes.isSystemSelected(pair.key);
        <button
          mat-menu-item
          type="button"
          role="menuitemradio"
          [attr.aria-checked]="system"
          [attr.data-testid]="'theme-system-' + pair.key"
          (click)="themes.selectSystem(pair.key)"
        >
          <mat-icon>{{ systemIcon }}</mat-icon>
          <span class="label">
            <span>{{ 'theme.system' | translate }}</span>
            @if (!official(pair)) {
              <span class="by">{{ pair.light.packageName }}</span>
            }
          </span>
          @if (system) {
            <mat-icon class="theme-check" aria-hidden="true">check</mat-icon>
          }
        </button>
      }

      @if (unpaired().length > 0) {
        @if (themes.pairs().length > 0) {
          <mat-divider />
          <p class="section" aria-hidden="true">{{ 'theme.installed' | translate }}</p>
        }
        @for (entry of unpaired(); track entry.ref) {
          @let checked = themes.isFixed(entry.ref);
          <button
            mat-menu-item
            type="button"
            role="menuitemradio"
            [attr.aria-checked]="checked"
            [attr.data-testid]="'theme-option-' + entry.ref"
            (click)="themes.selectPlugin(entry.ref)"
          >
            <span class="swatch" aria-hidden="true" [style.background]="entry.theme.ui.background">
              <i [style.background]="entry.theme.ui['surface-container-high']"></i>
              <i [style.background]="entry.theme.ui.primary"></i>
            </span>
            <span class="label">
              <span>{{ entry.theme.name }}</span>
              <span class="by">{{ entry.packageName }}</span>
            </span>
            @if (checked) {
              <mat-icon class="theme-check" aria-hidden="true">check</mat-icon>
            }
          </button>
        }
      }

      @if (themes.entries().length === 0) {
        <button mat-menu-item type="button" disabled data-testid="theme-none">
          <mat-icon>{{ themes.icon() }}</mat-icon>
          <span>{{ 'theme.none' | translate }}</span>
        </button>
      }
    </mat-menu>
  `,
  styles: `
    /* The menu renders in an overlay; the host is only where it is declared. */
    :host {
      display: none;
    }

    .section {
      margin: 0;
      padding: 6px 16px 2px;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-small);
    }

    .swatch {
      display: inline-flex;
      flex: 0 0 auto;
      align-items: flex-end;
      gap: 2px;
      width: 18px;
      height: 18px;
      margin-right: 12px;
      padding: 3px;
      box-sizing: border-box;
      vertical-align: middle;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 3px;
    }

    .swatch i {
      flex: 1;
      height: 60%;
      border-radius: 1px;
    }

    .label {
      display: inline-flex;
      flex-direction: column;
      vertical-align: middle;
      line-height: 1.2;
    }

    .by {
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-small);
    }
  `,
})
export class ThemeMenu {
  protected readonly themes = inject(AppThemes);
  private readonly i18n = inject(I18n);
  protected readonly systemIcon = colorSchemeIcon('system');

  readonly menu = viewChild.required(MatMenu);

  /** The themes that are not one of a pair. */
  protected readonly unpaired = computed(() =>
    this.themes.entries().filter((entry) => pairKey(entry) === null),
  );

  protected name(entry: PluginThemeEntry): string {
    const key = officialThemeKey(entry.ref);
    return key ? this.i18n.t(key) : entry.theme.name;
  }

  protected schemeIcon(entry: PluginThemeEntry): string {
    return colorSchemeIcon(entry.theme.scheme);
  }

  /** The app's own pair needs no credit line. */
  protected official(pair: ThemePair): boolean {
    return pair.light.packageId === DEFAULT_THEMES_PACKAGE_ID;
  }
}
