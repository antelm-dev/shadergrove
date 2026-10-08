/**
 * The open shader's saved states, newest first: name the ones worth keeping,
 * and restore one as a new head.
 *
 * Opening it reads only, so it is offered over a dirty draft. Restoring goes
 * through `WorkspaceActions.restoreHistory`, which is where the unsaved-changes
 * guard lives. The dialog belongs to the shader it was opened for: once another
 * one is open (a switch, or this one was deleted), it closes rather than act on
 * the wrong shader.
 */

import { Component, computed, effect, inject, signal, type OnInit } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';

import type { ShaderHistoryCause, ShaderHistoryEntry } from '@shadergrove/shared/model';
import { LIMITS, validateName } from '@shadergrove/shared/validate';
import { ApiError, ShaderApi } from '../../api/shader-api';
import { I18n } from '../../i18n/i18n';
import type { TranslationKey } from '../../i18n/keys';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { ShaderStore } from '../../workspace/shader-store';
import { WorkspaceActions } from '../workspace-actions';

export interface HistoryDialogData {
  shaderId: string;
  name: string;
}

/** Every cause has a label: a `Record` fails to compile when the shared type grows. */
const CAUSE_KEYS: Record<ShaderHistoryCause, TranslationKey> = {
  create: 'history.cause.create',
  import: 'history.cause.import',
  duplicate: 'history.cause.duplicate',
  baseline: 'history.cause.baseline',
  update: 'history.cause.update',
  'preset-save': 'history.cause.presetSave',
  'preset-delete': 'history.cause.presetDelete',
  sync: 'history.cause.sync',
  restore: 'history.cause.restore',
};

const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
  ['second', 1],
];

/** "3 minutes ago", in the language worn; empty for a date that does not parse. */
export function relativeTime(value: string, now: number, locale: string): string {
  // Never in the future: the server's clock may run a little ahead of this one.
  const seconds = Math.min(0, (Date.parse(value) - now) / 1000);
  if (Number.isNaN(seconds)) return '';
  const [unit, size] = UNITS.find(([, size]) => Math.abs(seconds) >= size) ?? UNITS.at(-1)!;
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(
    Math.round(seconds / size),
    unit,
  );
}

@Component({
  selector: 'app-history-dialog',
  imports: [
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MatTooltipModule,
    TranslatePipe,
  ],
  template: `
    <h2 mat-dialog-title>{{ 'history.title' | translate: { name: data.name } }}</h2>

    @if (busy() || entries() === null) {
      <mat-progress-bar mode="indeterminate" [attr.aria-label]="'history.loading' | translate" />
    }

    <mat-dialog-content>
      <p class="scope">{{ 'history.scope' | translate }}</p>

      @if (message(); as text) {
        <p class="notice" role="alert">{{ text }}</p>
      }

      @if (loadError(); as error) {
        <div class="state" role="alert">
          <p>{{ 'history.loadFailed' | translate: { error } }}</p>
          <button matButton="tonal" type="button" (click)="load()">
            {{ 'history.retry' | translate }}
          </button>
        </div>
      } @else if (entries(); as list) {
        <ol class="entries" [attr.aria-label]="'history.menu' | translate">
          @for (entry of list; track entry.revision) {
            <li [class.current]="entry.revision === headRevision()">
              <div class="summary">
                <p class="heading">
                  <span class="revision">
                    {{ 'history.revision' | translate: { revision: entry.revision } }}
                  </span>
                  @if (entry.checkpointName) {
                    <span class="checkpoint">
                      <mat-icon aria-hidden="true">bookmark</mat-icon>{{ entry.checkpointName }}
                    </span>
                  }
                  @if (entry.revision === headRevision()) {
                    <span class="badge">{{ 'history.current' | translate }}</span>
                  }
                </p>
                <p class="meta">
                  {{ causeLabel(entry.cause) | translate }} ·
                  <time [attr.datetime]="entry.createdAt" [attr.title]="absolute(entry.createdAt)">
                    {{ relative(entry.createdAt) }}
                  </time>
                  <span class="absolute">({{ absolute(entry.createdAt) }})</span>
                  @if (entry.restoredFromRevision !== null) {
                    ·
                    {{
                      'history.restoredFrom' | translate: { revision: entry.restoredFromRevision }
                    }}
                  }
                </p>
              </div>

              @if (editing() === entry.revision) {
                <div class="edit">
                  <mat-form-field appearance="outline" subscriptSizing="dynamic">
                    <mat-label>{{ 'history.checkpointName' | translate }}</mat-label>
                    <input
                      matInput
                      cdkFocusInitial
                      [attr.maxlength]="maxName"
                      [value]="draftName()"
                      [disabled]="busy()"
                      (input)="draftName.set($any($event.target).value)"
                      (keyup.enter)="saveName(entry)"
                    />
                    @if (nameError(); as error) {
                      <mat-hint class="invalid" role="alert">{{ error }}</mat-hint>
                    } @else {
                      <mat-hint>{{ 'history.checkpointHint' | translate }}</mat-hint>
                    }
                  </mat-form-field>
                  <button
                    matButton="filled"
                    type="button"
                    [disabled]="busy()"
                    (click)="saveName(entry)"
                  >
                    {{ 'action.save' | translate }}
                  </button>
                  <button matButton type="button" [disabled]="busy()" (click)="editing.set(null)">
                    {{ 'action.cancel' | translate }}
                  </button>
                </div>
              } @else {
                <div class="actions">
                  <button
                    matIconButton
                    type="button"
                    [disabled]="locked()"
                    [attr.aria-label]="nameLabel(entry) | translate"
                    [matTooltip]="nameLabel(entry) | translate"
                    (click)="startEditing(entry)"
                  >
                    <mat-icon>{{ entry.checkpointName ? 'edit' : 'bookmark_add' }}</mat-icon>
                  </button>
                  @if (entry.checkpointName) {
                    <button
                      matIconButton
                      type="button"
                      [disabled]="locked()"
                      [attr.aria-label]="'history.clearCheckpoint' | translate"
                      [matTooltip]="'history.clearCheckpoint' | translate"
                      (click)="setName(entry, null)"
                    >
                      <mat-icon>bookmark_remove</mat-icon>
                    </button>
                  }
                  <button
                    matButton="tonal"
                    type="button"
                    [disabled]="locked() || entry.revision === headRevision()"
                    [attr.aria-label]="
                      'history.restoreRevision' | translate: { revision: entry.revision }
                    "
                    (click)="restore(entry)"
                  >
                    {{ 'action.restore' | translate }}
                  </button>
                </div>
              }
            </li>
          } @empty {
            <li class="state">{{ 'history.empty' | translate }}</li>
          }
        </ol>
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close type="button">{{ 'action.close' | translate }}</button>
    </mat-dialog-actions>
  `,
  styles: `
    mat-dialog-content {
      width: min(600px, 80vw);
    }

    .scope,
    .meta {
      margin: 0;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }

    .notice {
      margin: 12px 0 0;
      padding: 10px 12px;
      border-radius: 10px;
      background: var(--mat-sys-error-container);
      color: var(--mat-sys-on-error-container);
      font: var(--mat-sys-body-small);
    }

    .state {
      padding: 16px 0;
      color: var(--mat-sys-on-surface-variant);
    }

    .entries {
      margin: 12px 0 0;
      padding: 0;
      list-style: none;
    }

    .entries li {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 12px;
      padding: 10px 0;
      border-top: 1px solid var(--mat-sys-outline-variant);
    }

    .summary {
      flex: 1 1 240px;
      min-width: 0;
    }

    .heading {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px 10px;
      margin: 0 0 2px;
      font: var(--mat-sys-title-small);
    }

    .checkpoint {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      overflow-wrap: anywhere;
      color: var(--mat-sys-primary);
    }

    .checkpoint mat-icon {
      width: 18px;
      height: 18px;
      font-size: 18px;
    }

    .badge {
      padding: 0 8px;
      border-radius: 8px;
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
      font: var(--mat-sys-label-small);
    }

    .actions,
    .edit {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .edit {
      flex: 1 1 100%;
      align-items: flex-start;
      gap: 8px;
    }

    .edit mat-form-field {
      flex: 1;
    }

    .invalid {
      color: var(--mat-sys-error);
    }
  `,
})
export class HistoryDialog implements OnInit {
  protected readonly data = inject<HistoryDialogData>(MAT_DIALOG_DATA);
  private readonly api = inject(ShaderApi);
  private readonly store = inject(ShaderStore);
  private readonly workspace = inject(WorkspaceActions);
  private readonly i18n = inject(I18n);
  private readonly ref = inject(MatDialogRef<HistoryDialog>);

  protected readonly maxName = LIMITS.nameLength;

  /** `null` until the first answer, so loading never reads as "no history". */
  protected readonly entries = signal<ShaderHistoryEntry[] | null>(null);
  protected readonly loadError = signal<string | null>(null);
  /** One write at a time: every action is disabled while one is in flight. */
  protected readonly busy = signal(false);
  protected readonly message = signal<string | null>(null);
  protected readonly editing = signal<number | null>(null);
  protected readonly draftName = signal('');
  protected readonly nameError = signal<string | null>(null);

  /** The open record's revision: the entry it matches is the current state. */
  protected readonly headRevision = computed(() => this.store.record()?.revision ?? null);
  /** A shared example reads but never takes a name or a restore; the server refuses both. */
  protected readonly locked = computed(
    () => this.busy() || this.store.record()?.kind === 'template',
  );

  private now = Date.now();

  constructor() {
    effect(() => {
      if (this.store.selectedId() !== this.data.shaderId) this.ref.close();
    });
  }

  ngOnInit(): Promise<void> {
    return this.load();
  }

  async load(): Promise<void> {
    this.loadError.set(null);
    this.entries.set(null);
    try {
      const entries = await this.api.listHistory(this.data.shaderId);
      this.now = Date.now();
      this.entries.set(entries);
    } catch (error) {
      this.loadError.set(errorText(error));
    }
  }

  protected causeLabel(cause: ShaderHistoryCause): TranslationKey {
    return CAUSE_KEYS[cause];
  }

  protected nameLabel(entry: ShaderHistoryEntry): TranslationKey {
    return entry.checkpointName ? 'history.renameCheckpoint' : 'history.nameCheckpoint';
  }

  protected relative(createdAt: string): string {
    return relativeTime(createdAt, this.now, this.i18n.locale());
  }

  protected absolute(createdAt: string): string {
    return this.i18n.formatDate(createdAt);
  }

  protected startEditing(entry: ShaderHistoryEntry): void {
    this.message.set(null);
    this.nameError.set(null);
    this.draftName.set(entry.checkpointName ?? '');
    this.editing.set(entry.revision);
  }

  protected saveName(entry: ShaderHistoryEntry): Promise<void> {
    const name = validateName(this.draftName());
    if (!name.ok) {
      this.nameError.set(this.i18n.t('history.checkpointInvalid', { max: LIMITS.nameLength }));
      return Promise.resolve();
    }
    return this.setName(entry, name.value);
  }

  /** Names or clears an entry; the shader's revision does not move, so nothing else is reloaded. */
  protected async setName(entry: ShaderHistoryEntry, name: string | null): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.message.set(null);
    try {
      const updated = await this.api.setCheckpoint(this.data.shaderId, entry.revision, name);
      this.entries.update(
        (list) =>
          list?.map((item) => (item.revision === updated.revision ? updated : item)) ?? null,
      );
      this.editing.set(null);
    } catch (error) {
      this.message.set(this.i18n.t('history.checkpointFailed', { error: errorText(error) }));
    } finally {
      this.busy.set(false);
    }
  }

  protected async restore(entry: ShaderHistoryEntry): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.message.set(null);
    try {
      const outcome = await this.workspace.restoreHistory(this.data.shaderId, entry.revision);
      if (outcome === 'cancelled') return;
      if (outcome === 'conflict') this.message.set(this.i18n.t('history.conflict'));
      if (outcome === 'failed') {
        this.message.set(this.i18n.t('history.restoreFailed', { revision: entry.revision }));
      }
      // Restored: the new head and its provenance. Refused: whatever moved the head on.
      if (this.store.selectedId() === this.data.shaderId) await this.load();
    } finally {
      this.busy.set(false);
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof ApiError ? error.summary : String(error);
}
