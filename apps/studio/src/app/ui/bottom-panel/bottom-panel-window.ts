import { Component, ElementRef, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

import { WELL_KNOWN_SURFACE_IDS } from '@shadergrove/shared/surfaces';
import { DesktopPlatform } from '../../desktop/desktop-platform';
import { I18n } from '../../i18n/i18n';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { BottomPanelMirror, type BottomPanelMirrorTab } from '../../workspace/bottom-panel-sync';
import { OutputPanel } from './output-panel';
import { PANEL_CHROME_STYLES } from './panel-chrome-styles';
import { ProblemsPanel } from './problems-panel';

/**
 * The whole page of the desktop's native Problems/Output window, bootstrapped
 * in place of `App` (see `rootComponent`) — hence the `app-root` selector.
 *
 * A view of the main window's session, never a second one: it creates no
 * `ShaderStore`, no routing or startup coordinator and no global shortcuts,
 * and a diagnostic click or Clear only asks the main window to act.
 */
@Component({
  selector: 'app-root',
  imports: [
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    OutputPanel,
    ProblemsPanel,
    TranslatePipe,
  ],
  template: `
    <div class="header">
      <div
        class="tablist"
        role="tablist"
        [attr.aria-label]="'panel.problems' | translate"
        (keydown)="onTabListKeydown($event)"
      >
        <button
          type="button"
          role="tab"
          id="bottom-panel-tab-problems"
          class="tab"
          [class.active]="tab() === 'problems'"
          [attr.aria-selected]="tab() === 'problems'"
          aria-controls="bottom-panel-panel-problems"
          [tabindex]="tab() === 'problems' ? 0 : -1"
          (click)="mirror.tab.set('problems')"
        >
          <mat-icon aria-hidden="true">report</mat-icon>
          <span>{{ 'panel.problems' | translate }}</span>
          @if (errorCount() > 0 || warningCount() > 0) {
            <span class="counts" [attr.aria-label]="countsLabel()">
              @if (errorCount() > 0) {
                <span class="count error">{{ errorCount() }}</span>
              }
              @if (warningCount() > 0) {
                <span class="count warning">{{ warningCount() }}</span>
              }
            </span>
          }
        </button>

        <button
          type="button"
          role="tab"
          id="bottom-panel-tab-output"
          class="tab"
          [class.active]="tab() === 'output'"
          [attr.aria-selected]="tab() === 'output'"
          aria-controls="bottom-panel-panel-output"
          [tabindex]="tab() === 'output' ? 0 : -1"
          (click)="mirror.tab.set('output')"
        >
          <mat-icon aria-hidden="true">terminal</mat-icon>
          <span>{{ 'panel.output' | translate }}</span>
        </button>
      </div>

      <span class="spacer"></span>

      <button
        matIconButton
        type="button"
        class="action dock"
        [matTooltip]="'editor.dockBottom' | translate"
        [attr.aria-label]="'editor.dockBottom' | translate"
        (click)="dock()"
      >
        <mat-icon>vertical_align_bottom</mat-icon>
      </button>

      <button
        matIconButton
        type="button"
        class="close"
        [matTooltip]="'panel.close' | translate"
        [attr.aria-label]="'panel.close' | translate"
        (click)="close()"
      >
        <mat-icon>close</mat-icon>
      </button>
    </div>

    <div class="body">
      <div
        id="bottom-panel-panel-problems"
        class="tabpanel"
        role="tabpanel"
        aria-labelledby="bottom-panel-tab-problems"
        [hidden]="tab() !== 'problems'"
      >
        <app-problems-panel
          [diagnostics]="mirror.diagnostics()"
          (activate)="mirror.reveal($event)"
        />
      </div>
      <div
        id="bottom-panel-panel-output"
        class="tabpanel"
        role="tabpanel"
        aria-labelledby="bottom-panel-tab-output"
        [hidden]="tab() !== 'output'"
      >
        <app-output-panel [entries]="mirror.entries()" (cleared)="mirror.clearOutput()" />
      </div>
    </div>
  `,
  styles: [
    PANEL_CHROME_STYLES,
    `
      :host {
        display: flex;
        flex-direction: column;
        height: 100vh;
        overflow: hidden;
        background: var(--mat-sys-surface-container-lowest);
        color: var(--mat-sys-on-surface);
      }
    `,
  ],
})
export class BottomPanelWindow {
  protected readonly mirror = inject(BottomPanelMirror);
  private readonly desktop = inject(DesktopPlatform);
  private readonly i18n = inject(I18n);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly surfaceId = WELL_KNOWN_SURFACE_IDS.bottomPanel;

  protected readonly tab = this.mirror.tab.asReadonly();

  protected readonly errorCount = computed(
    () => this.mirror.diagnostics().filter((diagnostic) => diagnostic.severity === 'error').length,
  );
  protected readonly warningCount = computed(
    () =>
      this.mirror.diagnostics().filter((diagnostic) => diagnostic.severity === 'warning').length,
  );
  protected readonly countsLabel = computed(() => {
    const parts: string[] = [];
    if (this.errorCount() > 0)
      parts.push(this.i18n.t('panel.errorCount', { count: this.errorCount() }));
    if (this.warningCount() > 0)
      parts.push(this.i18n.t('panel.warningCount', { count: this.warningCount() }));
    return parts.join(', ');
  });

  constructor() {
    this.mirror.start();
  }

  /** Hands the panel back to the main window, which docks it and closes this one. */
  protected dock(): void {
    void this.desktop.returnSurface(this.surfaceId).catch(() => undefined);
  }

  /** The main window hears the close and hides its panel. */
  protected close(): void {
    void this.desktop.closeSurface(this.surfaceId).catch(() => undefined);
  }

  protected onTabListKeydown(event: KeyboardEvent): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next: BottomPanelMirrorTab = this.tab() === 'problems' ? 'output' : 'problems';
    this.mirror.tab.set(next);
    queueMicrotask(() =>
      this.host.nativeElement.querySelector<HTMLElement>(`#bottom-panel-tab-${next}`)?.focus(),
    );
  }
}
