import { Component, ElementRef, computed, effect, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { Title } from '@angular/platform-browser';

import type { CompileDiagnostic } from '@shadergrove/shared/diagnostic';
import { BOTTOM_PANEL_TABS, type BottomPanelTab } from '@shadergrove/shared/panel-prefs';
import { WELL_KNOWN_SURFACE_IDS } from '@shadergrove/shared/surfaces';
import { DesktopPlatform } from '../../desktop/desktop-platform';
import { I18n } from '../../i18n/i18n';
import type { TranslationKey } from '../../i18n/keys';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { SessionMirror } from '../../workspace/session-sync/session-mirror';
import { ProfilerView } from '../inspector/profiler-view';
import { SatelliteControls } from '../layout/satellite-controls';
import { OutputPanel } from './output-panel';
import { PANEL_CHROME_STYLES } from './panel-chrome-styles';
import { ProblemsPanel } from './problems-panel';

const TAB_META: Record<BottomPanelTab, { icon: string; label: TranslationKey }> = {
  problems: { icon: 'report', label: 'panel.problems' },
  output: { icon: 'terminal', label: 'panel.output' },
  profiler: { icon: 'query_stats', label: 'panel.profiler' },
  inspection: { icon: 'frame_inspect', label: 'panel.inspection' },
};

/**
 * The whole page of the bottom panel's native window, bootstrapped in place
 * of `App` (see `rootComponent`) — hence the `app-root` selector.
 *
 * A view of the main window's session, never a second one: every tab shows
 * what the main window publishes, the selected tab is the main window's own,
 * and a diagnostic click, Clear or a profiler suggestion only asks the main
 * window to act. Frame inspection reads back the main window's renderer, so
 * its tab says so and offers to dock instead of pretending to capture.
 */
@Component({
  selector: 'app-root',
  imports: [
    MatButtonModule,
    MatIconModule,
    OutputPanel,
    ProblemsPanel,
    ProfilerView,
    SatelliteControls,
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
        @for (item of tabs; track item.id) {
          @let selected = tab() === item.id;
          <button
            type="button"
            role="tab"
            class="tab"
            [id]="'bottom-panel-tab-' + item.id"
            [class.active]="selected"
            [attr.aria-selected]="selected"
            [attr.aria-controls]="'bottom-panel-panel-' + item.id"
            [tabindex]="selected ? 0 : -1"
            (click)="select(item.id)"
          >
            <mat-icon aria-hidden="true">{{ item.icon }}</mat-icon>
            <span>{{ item.label | translate }}</span>
            @if (item.id === 'problems' && (errorCount() > 0 || warningCount() > 0)) {
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
        }
      </div>

      <span class="spacer"></span>

      <app-satellite-controls [surfaceId]="surfaceId" closeLabel="panel.close" />
    </div>

    <div class="body">
      <div
        id="bottom-panel-panel-problems"
        class="tabpanel"
        role="tabpanel"
        aria-labelledby="bottom-panel-tab-problems"
        [hidden]="tab() !== 'problems'"
      >
        <app-problems-panel [diagnostics]="diagnostics()" (activate)="reveal($event)" />
      </div>
      <div
        id="bottom-panel-panel-output"
        class="tabpanel"
        role="tabpanel"
        aria-labelledby="bottom-panel-tab-output"
        [hidden]="tab() !== 'output'"
      >
        <app-output-panel [entries]="entries()" (cleared)="clearOutput()" />
      </div>
      <div
        id="bottom-panel-panel-profiler"
        class="tabpanel scroll"
        role="tabpanel"
        aria-labelledby="bottom-panel-tab-profiler"
        [hidden]="tab() !== 'profiler'"
      >
        <app-profiler-view [state]="profiler()" (apply)="applySuggestion($event)" />
      </div>
      <div
        id="bottom-panel-panel-inspection"
        class="tabpanel"
        role="tabpanel"
        aria-labelledby="bottom-panel-tab-inspection"
        [hidden]="tab() !== 'inspection'"
      >
        <div class="elsewhere">
          <p>{{ 'inspection.detachedHint' | translate }}</p>
          <button matButton="tonal" type="button" class="dock-to-inspect" (click)="dock()">
            <mat-icon aria-hidden="true">dock_to_bottom</mat-icon>
            {{ 'action.dockInMain' | translate }}
          </button>
        </div>
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

      .tabpanel.scroll:not([hidden]) {
        overflow-y: auto;
      }

      .elsewhere {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 12px;
        max-width: 60ch;
        padding: 16px;
        color: var(--mat-sys-on-surface-variant);
        font: var(--mat-sys-body-medium);

        p {
          margin: 0;
        }
      }
    `,
  ],
})
export class BottomPanelWindow {
  private readonly mirror = inject(SessionMirror);
  private readonly desktop = inject(DesktopPlatform);
  private readonly i18n = inject(I18n);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly surfaceId = WELL_KNOWN_SURFACE_IDS.bottomPanel;

  protected readonly tabs = BOTTOM_PANEL_TABS.map((id) => ({ id, ...TAB_META[id] }));
  protected readonly tab = this.mirror.field('bottomPanelTab');
  protected readonly diagnostics = this.mirror.field('diagnostics');
  protected readonly entries = this.mirror.field('entries');
  protected readonly profiler = this.mirror.field('profiler');

  protected readonly errorCount = computed(
    () => this.diagnostics().filter((diagnostic) => diagnostic.severity === 'error').length,
  );
  protected readonly warningCount = computed(
    () => this.diagnostics().filter((diagnostic) => diagnostic.severity === 'warning').length,
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
    const title = inject(Title);
    effect(() => title.setTitle(`${this.i18n.t(TAB_META[this.tab()].label)} — Shadergrove`));
  }

  /** The main window's tab: it is selected there, and this window follows. */
  protected select(tab: BottomPanelTab): void {
    void this.mirror.send({ kind: 'bottom-panel-tab', tab }, { bottomPanelTab: tab });
  }

  protected reveal(diagnostic: CompileDiagnostic): void {
    void this.mirror.send({ kind: 'reveal', docId: diagnostic.docId ?? '', line: diagnostic.line });
  }

  /** The main window clears its log; this copy empties when it does. */
  protected clearOutput(): void {
    void this.mirror.send({ kind: 'clear-output' });
  }

  protected applySuggestion(scale: number): void {
    void this.mirror.send({ kind: 'apply-profiler-suggestion', scale });
  }

  /** Back into the main window, on the Inspection tab, where a frame can be captured. */
  protected dock(): void {
    void this.desktop.returnSurface(this.surfaceId).catch(() => undefined);
  }

  protected onTabListKeydown(event: KeyboardEvent): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const index = BOTTOM_PANEL_TABS.indexOf(this.tab());
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next =
      BOTTOM_PANEL_TABS[(index + step + BOTTOM_PANEL_TABS.length) % BOTTOM_PANEL_TABS.length];
    this.select(next);
    queueMicrotask(() =>
      this.host.nativeElement.querySelector<HTMLElement>(`#bottom-panel-tab-${next}`)?.focus(),
    );
  }
}
