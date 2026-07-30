import { Component, computed, inject } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

import type { CompileDiagnostic } from '@shader-studio/shared/diagnostic';
import { EditorNavigation } from '../../editor/editor-navigation';
import { SurfaceLayoutService } from '../../surfaces/surface-layout';
import { I18n } from '../../i18n/i18n';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { ShaderStore } from '../../workspace/shader-store';

/**
 * The project-wide diagnostics list — every pass, every file, not just the
 * document open in the editor. It used to live under the Monaco editor in
 * `EditorPanel`; it lives here now so it exists whether or not the source
 * editor is even open, and does not compete with the editor for vertical
 * space when it is.
 *
 * Never touches `CodeEditor` directly: a click asks `EditorWindow` to make
 * sure the editor is visible, then hands the reveal to `EditorNavigation`,
 * which `EditorPanel` — the one place that actually holds a `CodeEditor` —
 * picks up once the target document is mounted.
 */
@Component({
  selector: 'app-problems-panel',
  imports: [MatIconModule, TranslatePipe],
  host: {
    '[class.empty-state]': 'diagnostics().length === 0',
  },
  template: `
    @if (diagnostics().length === 0) {
      <p class="empty">{{ 'panel.noProblems' | translate }}</p>
    } @else {
      <ul class="list" [attr.aria-label]="'panel.problems' | translate" aria-live="polite">
        @for (diagnostic of diagnostics(); track key(diagnostic)) {
          <li>
            <button
              type="button"
              class="row"
              [class.warning]="diagnostic.severity === 'warning'"
              (click)="open(diagnostic)"
            >
              <mat-icon class="icon" [attr.aria-label]="severityLabel(diagnostic)">
                {{ diagnostic.severity === 'warning' ? 'warning' : 'error' }}
              </mat-icon>
              <span class="where">
                {{ diagnostic.docName ?? diagnostic.source }}
                @if (diagnostic.line) {
                  <span>:{{ diagnostic.line }}</span>
                }
              </span>
              <span class="message">{{ diagnostic.message }}</span>
            </button>
          </li>
        }
      </ul>
    }
  `,
  styles: `
    :host {
      display: block;
      min-height: 0;
      height: 100%;
      overflow-y: auto;
    }

    :host(.empty-state) {
      overflow: hidden;
    }

    .empty {
      box-sizing: border-box;
      display: grid;
      place-items: center;
      height: 100%;
      margin: 0;
      padding: 16px;
      color: var(--mat-sys-on-surface-variant);
      text-align: center;
    }

    .list {
      margin: 0;
      padding: 4px 0;
      list-style: none;
    }

    .row {
      display: flex;
      align-items: baseline;
      gap: 8px;
      width: 100%;
      padding: 4px 12px;
      border: 0;
      background: transparent;
      text-align: left;
      cursor: pointer;
      font: var(--mat-sys-body-small);
      font-family: 'JetBrains Mono', Consolas, monospace;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .row:hover {
      background: color-mix(in srgb, var(--mat-sys-on-surface) 8%, transparent);
    }

    .row:focus-visible {
      outline: 2px solid var(--mat-sys-primary);
      outline-offset: -2px;
    }

    .icon {
      align-self: center;
      flex: 0 0 auto;
      font-size: 16px;
      width: 16px;
      height: 16px;
      color: var(--mat-sys-error);
    }

    .row.warning .icon {
      color: var(--mat-sys-tertiary);
    }

    .where {
      flex: 0 0 auto;
      color: var(--mat-sys-on-surface-variant);
      white-space: nowrap;
    }

    .message {
      color: var(--mat-sys-on-surface);
    }
  `,
})
export class ProblemsPanel {
  private readonly store = inject(ShaderStore);
  private readonly layout = inject(SurfaceLayoutService);
  private readonly navigation = inject(EditorNavigation);
  private readonly i18n = inject(I18n);

  protected readonly diagnostics = computed(() => this.store.allDiagnostics());

  protected key(diagnostic: CompileDiagnostic): string {
    return `${diagnostic.docId ?? ''}|${diagnostic.line}|${diagnostic.severity}|${diagnostic.message}`;
  }

  protected severityLabel(diagnostic: CompileDiagnostic): string {
    return this.i18n.t(
      diagnostic.severity === 'warning' ? 'output.level.warning' : 'output.level.error',
    );
  }

  /**
   * Open the editor if it is not, restore it if it was minimized, select the
   * diagnostic's document if it names a current one, and reveal its line —
   * gracefully doing as much of that as it can for a diagnostic with no
   * `docId`, a deleted document, or line 0.
   */
  protected open(diagnostic: CompileDiagnostic): void {
    this.layout.openEditor();
    this.navigation.reveal(diagnostic.docId ?? '', diagnostic.line);
  }
}
