import { isPlatformBrowser } from '@angular/common';
import {
  Component,
  DestroyRef,
  ElementRef,
  PLATFORM_ID,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

import { arrowKeyDelta } from '@shader-studio/shared/geometry';
import {
  BOTTOM_PANEL_HEIGHT_LIMITS,
  DEFAULT_BOTTOM_PANEL_HEIGHT,
  type BottomPanelTab,
} from '@shader-studio/shared/panel-prefs';
import { I18n } from '../../i18n/i18n';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { Preferences } from '../../prefs/preferences';
import { PointerGesture } from '../layout/pointer-gesture';
import { ShaderStore } from '../../workspace/shader-store';
import { OutputPanel } from './output-panel';
import { ProblemsPanel } from './problems-panel';

const TABS: readonly BottomPanelTab[] = ['problems', 'output'];

/**
 * The bottom-docked workspace surface: Problems and Output.
 *
 * Deliberately not a mode of `EditorShell` / `EditorWindow` — the source
 * editor and this panel are two independent surfaces that happen to share an
 * edge of the workspace, and can be open, closed and resized independently of
 * each other. See the workspace grid in `app.html`/`app.scss` for how the two
 * rows stack when both are open.
 *
 * The resize gesture follows `EditorShell`'s docked-bottom handle: a live
 * height while dragging, committed to `Preferences` only once the gesture
 * ends, so a drag does not serialise the whole preference object to
 * `localStorage` on every `pointermove`.
 */
@Component({
  selector: 'app-bottom-panel',
  imports: [
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    OutputPanel,
    ProblemsPanel,
    TranslatePipe,
  ],
  template: `
    <div
      class="resize-handle"
      role="separator"
      tabindex="0"
      aria-orientation="horizontal"
      [attr.aria-label]="'panel.resize' | translate"
      [attr.aria-valuenow]="displayHeight()"
      [attr.aria-valuemin]="minHeight"
      [attr.aria-valuemax]="effectiveMax()"
      (pointerdown)="startResize($event)"
      (keydown)="onHandleKeydown($event)"
      (dblclick)="resetHeight()"
    ></div>

    <div class="header">
      <div
        class="tablist"
        role="tablist"
        [attr.aria-label]="'panel.problems' | translate"
        (keydown)="onTabListKeydown($event)"
      >
        <button
          #problemsTab
          type="button"
          role="tab"
          id="bottom-panel-tab-problems"
          class="tab"
          [class.active]="tab() === 'problems'"
          [attr.aria-selected]="tab() === 'problems'"
          aria-controls="bottom-panel-panel-problems"
          [tabindex]="tab() === 'problems' ? 0 : -1"
          (click)="selectTab('problems')"
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
          #outputTab
          type="button"
          role="tab"
          id="bottom-panel-tab-output"
          class="tab"
          [class.active]="tab() === 'output'"
          [attr.aria-selected]="tab() === 'output'"
          aria-controls="bottom-panel-panel-output"
          [tabindex]="tab() === 'output' ? 0 : -1"
          (click)="selectTab('output')"
        >
          <mat-icon aria-hidden="true">terminal</mat-icon>
          <span>{{ 'panel.output' | translate }}</span>
        </button>
      </div>

      <span class="spacer"></span>

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
        <app-problems-panel />
      </div>
      <div
        id="bottom-panel-panel-output"
        class="tabpanel"
        role="tabpanel"
        aria-labelledby="bottom-panel-tab-output"
        [hidden]="tab() !== 'output'"
      >
        <app-output-panel />
      </div>
    </div>
  `,
  styles: `
    :host {
      position: relative;
      display: flex;
      flex-direction: column;
      grid-area: bottom-panel;
      min-height: 0;
      overflow: hidden;
      border-top: 1px solid var(--mat-sys-outline-variant);
      background: color-mix(in srgb, var(--mat-sys-surface-container-lowest) 94%, transparent);
      backdrop-filter: blur(18px);
      transition: height 160ms ease;
    }

    :host(.dragging) {
      transition: none;
    }

    @media (prefers-reduced-motion: reduce) {
      :host {
        transition: none;
      }
    }

    .resize-handle {
      position: absolute;
      top: -4px;
      left: 0;
      right: 0;
      z-index: 2;
      height: 7px;
      cursor: ns-resize;
      background: transparent;
      touch-action: none;
    }

    .resize-handle::after {
      position: absolute;
      top: 3px;
      right: 50%;
      left: 50%;
      height: 1px;
      content: '';
      background: var(--mat-sys-outline-variant);
      opacity: 0;
      transition: opacity 120ms ease;
    }

    .resize-handle:hover::after,
    :host(.dragging) .resize-handle::after,
    .resize-handle:focus-visible::after {
      right: 12px;
      left: 12px;
      opacity: 1;
    }

    .resize-handle:focus-visible {
      outline: 2px solid var(--mat-sys-primary);
      outline-offset: -2px;
      background: color-mix(in srgb, var(--mat-sys-primary) 24%, transparent);
    }

    .header {
      display: flex;
      align-items: center;
      flex: 0 0 auto;
      gap: 4px;
      min-height: 34px;
      padding: 3px 5px 3px 7px;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
      background: color-mix(in srgb, var(--mat-sys-surface-container-low) 82%, transparent);
    }

    .tablist {
      display: flex;
      align-items: center;
      gap: 2px;
      min-width: 0;
    }

    .tab {
      display: flex;
      align-items: center;
      gap: 6px;
      height: 28px;
      padding-inline: 10px;
      border: 0;
      border-radius: var(--mat-sys-corner-small, 6px);
      background: transparent;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-medium);
      white-space: nowrap;
      cursor: pointer;

      mat-icon {
        width: 16px;
        height: 16px;
        font-size: 16px;
      }
    }

    .tab:hover {
      background: color-mix(in srgb, var(--mat-sys-on-surface) 8%, transparent);
    }

    .tab.active {
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
    }

    .tab:focus-visible {
      outline: 2px solid var(--mat-sys-primary);
      outline-offset: -2px;
    }

    .counts {
      display: inline-flex;
      gap: 4px;
    }

    .count {
      display: inline-grid;
      place-items: center;
      min-width: 17px;
      height: 17px;
      padding: 0 4px;
      border-radius: 9px;
      font: var(--mat-sys-label-small);
    }

    .count.error {
      background: var(--mat-sys-error);
      color: var(--mat-sys-on-error);
    }

    .count.warning {
      background: var(--mat-sys-tertiary);
      color: var(--mat-sys-on-tertiary);
    }

    .spacer {
      flex: 1;
    }

    .close {
      width: 28px;
      height: 28px;
      padding: 4px;

      mat-icon {
        width: 18px;
        height: 18px;
        font-size: 18px;
      }
    }

    .body {
      position: relative;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }

    /*
     * Not \`.tabpanel { display: flex }\`: an author rule's \`display\` always
     * wins over the UA stylesheet's \`[hidden] { display: none }\` regardless of
     * specificity, so an unconditional \`display: flex\` here would render both
     * tabpanels at once, stacked, whichever one is \`hidden\`. Scoping the rule to
     * \`:not([hidden])\` leaves the hidden one with no author rule to override the
     * default.
     */
    .tabpanel:not([hidden]) {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
  `,
  host: {
    '[class.dragging]': 'dragging()',
    '[style.height.px]': 'displayHeight()',
  },
})
export class BottomPanel {
  protected readonly store = inject(ShaderStore);
  protected readonly preferences = inject(Preferences);
  protected readonly minHeight = BOTTOM_PANEL_HEIGHT_LIMITS.min;

  private readonly i18n = inject(I18n);
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly destroyRef = inject(DestroyRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  private readonly problemsTab = viewChild<ElementRef<HTMLButtonElement>>('problemsTab');
  private readonly outputTab = viewChild<ElementRef<HTMLButtonElement>>('outputTab');

  protected readonly tab = computed(() => this.preferences.value().bottomPanelTab);

  protected readonly errorCount = computed(
    () =>
      this.store.allDiagnostics().filter((diagnostic) => diagnostic.severity === 'error').length,
  );
  protected readonly warningCount = computed(
    () =>
      this.store.allDiagnostics().filter((diagnostic) => diagnostic.severity === 'warning').length,
  );

  protected readonly countsLabel = computed(() => {
    const parts: string[] = [];
    if (this.errorCount() > 0)
      parts.push(this.i18n.t('panel.errorCount', { count: this.errorCount() }));
    if (this.warningCount() > 0) {
      parts.push(this.i18n.t('panel.warningCount', { count: this.warningCount() }));
    }
    return parts.join(', ');
  });

  // --- Height: workspace-aware, live during a drag --------------------------

  private readonly workspaceHeight = signal(0);
  private readonly live = signal<number | null>(null);
  private readonly gesture = new PointerGesture();
  protected readonly dragging = this.gesture.dragging;

  /** Never more than ~72% of the workspace: a bottom panel that eats the whole
   * window has stopped being a panel and started hiding the shader entirely. */
  protected readonly effectiveMax = computed(() => {
    const workspace = this.workspaceHeight();
    const max = workspace > 0 ? Math.round(workspace * 0.72) : BOTTOM_PANEL_HEIGHT_LIMITS.max;
    return Math.max(max, this.minHeight);
  });

  protected readonly displayHeight = computed(() => {
    const live = this.live();
    if (live !== null) return live;
    return Math.min(this.preferences.value().bottomPanelHeight, this.effectiveMax());
  });

  constructor() {
    afterNextRender(() => this.observeWorkspace());
  }

  private observeWorkspace(): void {
    const workspace = this.host.nativeElement.parentElement;
    if (!this.isBrowser || !workspace) return;

    const measure = (): void => this.workspaceHeight.set(workspace.getBoundingClientRect().height);
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    this.destroyRef.onDestroy(() => observer.disconnect());
  }

  // --- Tabs -------------------------------------------------------------

  protected selectTab(tab: BottomPanelTab): void {
    this.preferences.patch({ bottomPanelTab: tab });
  }

  protected onTabListKeydown(event: KeyboardEvent): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

    const index = TABS.indexOf(this.tab());
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = TABS[(index + step + TABS.length) % TABS.length];

    event.preventDefault();
    this.selectTab(next);
    queueMicrotask(() => this.focusTab(next));
  }

  private focusTab(tab: BottomPanelTab): void {
    const ref = tab === 'problems' ? this.problemsTab() : this.outputTab();
    ref?.nativeElement.focus();
  }

  protected close(): void {
    this.preferences.patch({ bottomPanelOpen: false });
  }

  // --- Resizing -----------------------------------------------------------

  protected startResize(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const start = this.preferences.value().bottomPanelHeight;
    const target = event.currentTarget as HTMLElement | null;

    this.gesture.begin(event, target, {
      onMove: (_dx, dy) => this.live.set(this.clamp(start - dy)),
      onCommit: (_dx, dy) => {
        const height = this.clamp(start - dy);
        this.live.set(null);
        this.preferences.patch({ bottomPanelHeight: height });
      },
    });
  }

  protected onHandleKeydown(event: KeyboardEvent): void {
    const move = arrowKeyDelta(event);
    if (!move) return;

    const [, dy] = move;
    event.preventDefault();
    this.preferences.patch({
      bottomPanelHeight: this.clamp(this.preferences.value().bottomPanelHeight - dy),
    });
  }

  protected resetHeight(): void {
    this.preferences.patch({ bottomPanelHeight: DEFAULT_BOTTOM_PANEL_HEIGHT });
  }

  private clamp(value: number): number {
    return Math.round(Math.min(Math.max(value, this.minHeight), this.effectiveMax()));
  }
}
