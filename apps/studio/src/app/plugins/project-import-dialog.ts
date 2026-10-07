import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { filter, merge } from 'rxjs';

import type { ProjectImporterContribution } from '@shadergrove/shared/plugin';
import { I18n } from '../i18n/i18n';
import { TranslatePipe } from '../i18n/translate.pipe';
import { Preferences } from '../prefs/preferences';
import { HostAdapters, type ProviderField } from './host-adapters';
import { PluginInstallations, type PluginOperationContext } from './plugin-installations';
import {
  ProjectPluginActions,
  type ProjectActionOutcome,
  type ProjectImportRequest,
} from './project-actions';

/** Which importer to open, and the installation the opener resolved it from. */
export interface ProjectImportDialogData {
  context: PluginOperationContext;
  contributionId: string;
}

/** What came of it: `imported` when a shader was created; `toEditor` when the user asked to go back. */
export interface ProjectImportDialogResult {
  imported?: { name: string; warnings: readonly string[] };
  toEditor: boolean;
}

type Mode = 'paste' | 'provider';
type Report = { text: string; error: boolean };

/**
 * The form of one `projectImporter`, drawn by the host: the modes and fields
 * its manifest and host adapter describe, and nothing the plugin supplies.
 * Opened from the editor commands and the Installed page alike, so there is one
 * place a project import is started.
 *
 * The importer is resolved when the dialog opens and checked again on every
 * change and at submission: a different profile, or the package updated,
 * reinstalled or switched off, ends the dialog's use (`stale`). The work itself
 * is `ProjectPluginActions.runImport`, which keeps its own adoption, abort and
 * unsaved-changes protections; this dialog only asks, shows progress and says
 * what happened. Closing while it runs cancels that run, waits for it to
 * settle, and then closes.
 */
@Component({
  selector: 'app-project-import-dialog',
  imports: [
    FormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    TranslatePipe,
  ],
  template: `
    <h2 mat-dialog-title>{{ title() }}</h2>
    <mat-dialog-content>
      @if (done(); as result) {
        <p role="status" data-testid="import-done">
          {{ 'plugins.importedShader' | translate: { name: result.name } }}
        </p>
        @if (result.warnings.length > 0) {
          <p class="muted">{{ 'plugins.warnings' | translate }}</p>
          <ul data-testid="import-warnings">
            @for (warning of result.warnings; track $index) {
              <li>{{ warning }}</li>
            }
          </ul>
        }
      } @else if (!valid()) {
        <p class="error" role="alert" data-testid="import-stale">
          {{ 'plugins.staleResult' | translate }}
        </p>
      } @else if (!target) {
        <p class="muted">{{ 'plugins.noAdapter' | translate }}</p>
      } @else {
        <p class="muted">{{ 'plugins.contentRights' | translate }}</p>
        @if (target.contribution.modes.length > 1) {
          <div class="modes" role="radiogroup" [attr.aria-label]="target.contribution.name">
            @for (option of target.contribution.modes; track option) {
              <label>
                <input
                  type="radio"
                  name="project-import-mode"
                  [attr.data-testid]="'import-mode-' + option"
                  [disabled]="working()"
                  [checked]="mode() === option"
                  (change)="mode.set(option)"
                />
                {{
                  (option === 'provider' ? 'plugins.modeProvider' : 'plugins.modePaste') | translate
                }}
              </label>
            }
          </div>
        }
        @if (mode() === 'provider' && target.provider) {
          @for (field of target.provider.fields; track field.key) {
            <mat-form-field appearance="outline" class="field">
              <mat-label>{{ field.label | translate }}</mat-label>
              <input
                matInput
                [type]="field.kind === 'credential' ? 'password' : 'text'"
                [attr.autocomplete]="field.kind === 'credential' ? 'off' : null"
                [attr.data-testid]="'import-field-' + field.key"
                [attr.maxlength]="field.maxLength"
                [placeholder]="field.placeholder ?? ''"
                [disabled]="working()"
                [ngModel]="fieldValue(field)"
                (ngModelChange)="setField(field, $event)"
                (keyup.enter)="submit()"
              />
              @if (field.hint) {
                <mat-hint>{{ field.hint | translate }}</mat-hint>
              }
            </mat-form-field>
          }
        } @else {
          <mat-form-field appearance="outline" class="field">
            <mat-label>{{ 'plugins.pasteName' | translate }}</mat-label>
            <input
              matInput
              maxlength="64"
              data-testid="import-paste-name"
              [disabled]="working()"
              [ngModel]="pasteName()"
              (ngModelChange)="pasteName.set($event)"
            />
          </mat-form-field>
          <mat-form-field appearance="outline" class="field">
            <mat-label>{{ 'plugins.pasteSource' | translate }}</mat-label>
            <textarea
              matInput
              rows="8"
              spellcheck="false"
              data-testid="import-paste-source"
              [disabled]="working()"
              [ngModel]="pasteText()"
              (ngModelChange)="pasteText.set($event)"
            ></textarea>
            <mat-hint>{{ 'plugins.pasteHint' | translate }}</mat-hint>
          </mat-form-field>
        }
        @if (working() && projects.running(); as running) {
          <p class="muted" role="status" data-testid="import-step">{{ stepLabel(running.step) }}</p>
        }
        @if (report(); as current) {
          <p
            [class.error]="current.error"
            [attr.role]="current.error ? 'alert' : 'status'"
            data-testid="import-message"
          >
            {{ current.text }}
          </p>
        }
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      @if (done()) {
        <button matButton type="button" data-testid="import-close" (click)="finish(false)">
          {{ 'action.close' | translate }}
        </button>
        <button matButton="filled" type="button" data-testid="import-editor" (click)="finish(true)">
          {{ 'plugins.backToEditor' | translate }}
        </button>
      } @else {
        <button matButton type="button" data-testid="import-cancel" (click)="requestClose()">
          {{ 'action.cancel' | translate }}
        </button>
        @if (valid() && target) {
          <button
            matButton="filled"
            type="button"
            data-testid="import-run"
            [disabled]="!canSubmit()"
            (click)="submit()"
          >
            {{ 'plugins.runImport' | translate }}
          </button>
        }
      }
    </mat-dialog-actions>
  `,
  styles: `
    mat-dialog-content {
      width: min(560px, 80vw);
    }

    .field {
      display: block;
      margin-top: 8px;
    }

    .modes {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: 8px;
    }

    ul {
      margin: 4px 0 0;
      padding-left: 18px;
    }

    .muted {
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }

    .error {
      color: var(--mat-sys-error);
    }
  `,
})
export class ProjectImportDialog {
  private readonly dialogRef =
    inject<MatDialogRef<ProjectImportDialog, ProjectImportDialogResult>>(MatDialogRef);
  private readonly data = inject<ProjectImportDialogData>(MAT_DIALOG_DATA);
  private readonly installations = inject(PluginInstallations);
  private readonly adapters = inject(HostAdapters);
  private readonly preferences = inject(Preferences);
  private readonly i18n = inject(I18n);
  protected readonly projects = inject(ProjectPluginActions);

  /**
   * The importer this dialog was opened for. A manifest does not change within
   * an install (`valid` ends the dialog's use when the install does), so it is
   * read once. `null` when it is not an importer this app can run.
   */
  protected readonly target = this.resolve();

  /** The installation is still the one the dialog was opened for, under the same profile, switched on. */
  protected readonly valid = computed(() => this.installations.isCurrent(this.data.context));

  protected readonly mode = signal<Mode>(this.target?.contribution.modes[0] ?? 'paste');
  private readonly fields = signal<Record<string, string>>({});
  protected readonly pasteName = signal(this.i18n.t('shadertoy.defaultName'));
  protected readonly pasteText = signal('');

  /** This dialog's own run, from submission until it settles. */
  protected readonly working = signal(false);
  protected readonly report = signal<Report | null>(null);
  protected readonly done = signal<{ name: string; warnings: readonly string[] } | null>(null);
  private closing = false;

  protected readonly title = computed(() => {
    const contribution = this.target?.contribution;
    const command = this.target?.provider?.command;
    if (command) return this.i18n.t(command.label);
    return contribution ? `${contribution.name}…` : this.i18n.t('plugins.title');
  });

  protected readonly canSubmit = computed(() => {
    const target = this.target;
    if (!target || !this.valid() || this.working() || this.projects.running() !== null)
      return false;
    if (this.mode() === 'paste') return this.pasteText().trim().length > 0;
    // The source reference (an id, a URL) is required; a credential may be left to the provider to refuse.
    return (target.provider?.fields ?? []).every(
      (field) => field.kind === 'credential' || this.fieldValue(field).trim().length > 0,
    );
  });

  constructor() {
    // Escape and a click outside close like Cancel: they must not drop a run in progress unseen.
    merge(
      this.dialogRef.backdropClick(),
      this.dialogRef.keydownEvents().pipe(filter((event) => event.key === 'Escape')),
    )
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.requestClose());
  }

  protected fieldValue(field: ProviderField): string {
    const typed = this.fields()[field.key];
    if (typed !== undefined) return typed;
    return field.remember ? (this.preferences.value()[field.remember] ?? '') : '';
  }

  protected setField(field: ProviderField, value: string): void {
    this.fields.update((all) => ({ ...all, [field.key]: value }));
  }

  protected stepLabel(step: string): string {
    return this.i18n.t(`plugins.step.${step}` as Parameters<I18n['t']>[0]);
  }

  protected async submit(): Promise<void> {
    const target = this.target;
    if (!target || !this.canSubmit()) return;
    let request: ProjectImportRequest;
    if (this.mode() === 'provider' && target.provider) {
      const provider = target.provider;
      const values = Object.fromEntries(
        provider.fields.map((field) => [field.key, this.fieldValue(field).trim()]),
      );
      // Credentials the host remembers stay in the host's preferences.
      for (const field of provider.fields) {
        if (field.remember && values[field.key]) {
          this.preferences.patch({ [field.remember]: values[field.key] });
        }
      }
      request = { mode: 'provider', values };
    } else {
      request = { mode: 'paste', name: this.pasteName().trim(), text: this.pasteText() };
    }
    this.report.set(null);
    this.working.set(true);
    let outcome: ProjectActionOutcome;
    try {
      outcome = await this.projects.runImport(
        this.data.context.id,
        this.data.contributionId,
        request,
      );
    } finally {
      this.working.set(false);
    }
    if (outcome.status === 'imported') {
      const imported = { name: outcome.name, warnings: outcome.warnings };
      // Warnings stay readable until the user chooses to go on.
      if (outcome.warnings.length > 0 && !this.closing) this.done.set(imported);
      else this.dialogRef.close({ imported, toEditor: false });
      return;
    }
    if (this.closing) {
      this.dialogRef.close({ toEditor: false });
      return;
    }
    switch (outcome.status) {
      case 'cancelled':
        this.report.set({ text: this.i18n.t('plugins.runCancelled'), error: false });
        return;
      case 'stale':
        this.report.set({ text: this.i18n.t('plugins.staleResult'), error: true });
        return;
      case 'failed':
        this.report.set({
          text: this.i18n.t('plugins.failed', { message: outcome.message }),
          error: true,
        });
        return;
    }
  }

  /** Cancel, Escape, a click outside: while this dialog's run is going, cancel it and close once it has settled. */
  protected requestClose(): void {
    if (this.done()) return this.finish(false);
    if (!this.working()) return this.dialogRef.close({ toEditor: false });
    if (this.closing) return;
    this.closing = true;
    this.projects.cancel();
  }

  protected finish(toEditor: boolean): void {
    const imported = this.done() ?? undefined;
    this.dialogRef.close({ ...(imported ? { imported } : {}), toEditor });
  }

  private resolve(): {
    contribution: ProjectImporterContribution;
    provider: ReturnType<HostAdapters['provider']>;
  } | null {
    const contribution = this.installations
      .find(this.data.context.id)
      ?.plugin?.manifest.contributions.find(
        (entry): entry is ProjectImporterContribution =>
          entry.kind === 'projectImporter' && entry.id === this.data.contributionId,
      );
    if (!contribution) return null;
    const provider = contribution.provider ? this.adapters.provider(contribution.provider) : null;
    return contribution.provider && !provider ? null : { contribution, provider };
  }
}
