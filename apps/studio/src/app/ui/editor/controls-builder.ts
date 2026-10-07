import { NgTemplateOutlet } from '@angular/common';
import {
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  output,
  signal,
  untracked,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';

import { LIMITS } from '@shadergrove/shared/validate';
import type { ControlType, ShaderControl } from '@shadergrove/shared/model';
import { I18n } from '../../i18n/i18n';
import type { TranslationKey } from '../../i18n/keys';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { parseControls } from '../../workspace/state/controls-schema';
import { ShaderStore } from '../../workspace/shader-store';
import type { ConfirmDialogData } from '../dialogs/confirm-dialog';
import {
  CONTROL_TYPES,
  addOptionRow,
  analyzeForm,
  duplicateControl,
  glslType,
  groupControls,
  isPending,
  moveWithinGroup,
  newControl,
  openTransaction,
  planApply,
  planCommit,
  removeControl,
  removeOptionRow,
  retypeForm,
  staleness,
  uniformName,
  type CommitPlan,
  type ControlForm,
  type FormError,
  type FormField,
  type Snapshot,
  type Transaction,
} from './controls-builder-state';

const TYPE_ICONS: Record<ControlType, string> = {
  number: 'numbers',
  boolean: 'toggle_on',
  color: 'palette',
  select: 'list',
};

const ADD_KEYS: Record<ControlType, TranslationKey> = {
  number: 'builder.addNumber',
  boolean: 'builder.addBoolean',
  color: 'builder.addColor',
  select: 'builder.addSelect',
};

const TYPE_KEYS: Record<ControlType, TranslationKey> = {
  number: 'builder.type.number',
  boolean: 'builder.type.boolean',
  color: 'builder.type.color',
  select: 'builder.type.select',
};

interface Notice {
  text: string;
  error: boolean;
}

let nextBuilderId = 0;

/** The text a writer meant, whatever line ending the editor model it passed through uses. */
function sameText(actual: string | null, expected: string): boolean {
  return actual?.replace(/\r\n/g, '\n') === expected;
}

/**
 * The visual way into the Config document: a grouped list of the shader's
 * controls and a form for the selected one.
 *
 * It holds no copy of the schema. It reads the Config buffer's *text* from the
 * store — never `store.controls()`, which quietly falls back to the last good
 * schema when the text does not parse — and every change leaves through
 * `commit` as the full serialized text, for the editor panel to write into the
 * Config model so the edit lands on its undo stack. A form is a transaction
 * against that text; see `controls-builder-state.ts`.
 */
@Component({
  selector: 'app-controls-builder',
  imports: [
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    NgTemplateOutlet,
    TranslatePipe,
  ],
  host: {
    '[class.has-form]': 'tx() !== null',
  },
  template: `
    @if (invalid()) {
      <div class="repair" role="alert">
        <mat-icon aria-hidden="true">error</mat-icon>
        <p>{{ 'builder.invalid' | translate }}</p>
        <button matButton="tonal" type="button" class="repair-action" (click)="repair.emit()">
          {{ 'builder.repair' | translate }}
        </button>
      </div>
    } @else if (controls() !== null) {
      <div class="banners">
        @if (notice(); as message) {
          <p
            class="notice"
            [class.error]="message.error"
            [attr.role]="message.error ? 'alert' : 'status'"
          >
            {{ message.text }}
          </p>
        }

        @if (pendingAction()) {
          <div class="guard" role="group" [attr.aria-label]="'builder.guardMessage' | translate">
            <p>{{ 'builder.guardMessage' | translate }}</p>
            <div class="actions" (keydown.escape)="cancelGuard()">
              <button matButton="filled" type="button" class="guard-apply" (click)="guardApply()">
                {{ 'builder.guardApply' | translate }}
              </button>
              <button matButton="outlined" type="button" (click)="guardDiscard()">
                {{ 'builder.guardDiscard' | translate }}
              </button>
              <button matButton type="button" (click)="cancelGuard()">
                {{ 'action.cancel' | translate }}
              </button>
            </div>
          </div>
        }

        @if (stale() === 'text') {
          <div class="stale" role="alert">
            <p>{{ 'builder.stale' | translate }}</p>
            <button matButton="outlined" type="button" class="reload" (click)="reload(true)">
              {{ 'builder.reload' | translate }}
            </button>
          </div>
        }
      </div>

      <div class="panes">
        <section class="list-pane" [attr.aria-label]="'builder.listLabel' | translate">
          <div class="add" role="group" [attr.aria-label]="'builder.addGroup' | translate">
            @for (type of types; track type) {
              <button
                matButton="tonal"
                type="button"
                class="add-button"
                [attr.data-add]="type"
                (click)="add(type)"
              >
                <mat-icon aria-hidden="true">add</mat-icon>
                {{ addKey(type) | translate }}
              </button>
            }
          </div>

          @if (groups().length === 0) {
            <p class="hint">{{ 'builder.empty' | translate }}</p>
          }

          @for (group of groups(); track group.name) {
            <section class="group" [attr.aria-labelledby]="uid + '-g-' + $index">
              <h3 class="group-title" [id]="uid + '-g-' + $index">{{ group.name }}</h3>
              <ul class="rows">
                @for (item of group.items; track item.control.key; let at = $index) {
                  <li class="row" [class.selected]="item.control.key === tx()?.key">
                    <button
                      type="button"
                      class="select"
                      [attr.data-key]="item.control.key"
                      [attr.aria-current]="item.control.key === tx()?.key ? 'true' : null"
                      (click)="select(item.control.key)"
                    >
                      <mat-icon aria-hidden="true">{{ icon(item.control.type) }}</mat-icon>
                      <span class="names">
                        <span class="name">{{ display(item.control) }}</span>
                        <span class="uniform">
                          {{ uniform(item.control.key) }} · {{ glsl(item.control.type) }}
                        </span>
                      </span>
                      @if (item.control.key === tx()?.key && pending()) {
                        <span class="dot" aria-hidden="true"></span>
                        <span class="sr-only">{{ 'builder.unapplied' | translate }}</span>
                      }
                    </button>
                    <button
                      matIconButton
                      type="button"
                      class="move"
                      [attr.data-move]="item.control.key + ':up'"
                      [disabled]="at === 0"
                      [attr.aria-label]="'builder.moveUp' | translate: { name: display(item.control) }"
                      (click)="move(item.control.key, -1)"
                    >
                      <mat-icon aria-hidden="true">arrow_upward</mat-icon>
                    </button>
                    <button
                      matIconButton
                      type="button"
                      class="move"
                      [attr.data-move]="item.control.key + ':down'"
                      [disabled]="at === group.items.length - 1"
                      [attr.aria-label]="
                        'builder.moveDown' | translate: { name: display(item.control) }
                      "
                      (click)="move(item.control.key, 1)"
                    >
                      <mat-icon aria-hidden="true">arrow_downward</mat-icon>
                    </button>
                  </li>
                }
              </ul>
            </section>
          }
        </section>

        <section class="form-pane" [attr.aria-label]="'builder.field.type' | translate">
          @if (tx(); as t) {
            <form class="form" novalidate (submit)="$event.preventDefault(); apply()">
              <header class="form-header">
                <button
                  matButton
                  type="button"
                  class="back"
                  (click)="closeForm()"
                >
                  <mat-icon aria-hidden="true">arrow_back</mat-icon>
                  {{ 'builder.back' | translate }}
                </button>
                <h3 class="form-title" tabindex="-1">{{ display(t.original) }}</h3>
                @if (pending()) {
                  <span class="badge">{{ 'builder.unapplied' | translate }}</span>
                }
              </header>

              <p class="uniform-line">
                {{
                  'builder.uniform'
                    | translate: { name: uniform(t.key), type: glsl(t.original.type) }
                }}
              </p>

              <div class="header-actions">
                <button matButton type="button" class="duplicate" (click)="duplicate()">
                  <mat-icon aria-hidden="true">content_copy</mat-icon>
                  {{ 'builder.duplicate' | translate }}
                </button>
                <button matButton type="button" class="delete" (click)="remove()">
                  <mat-icon aria-hidden="true">delete</mat-icon>
                  {{ 'builder.delete' | translate }}
                </button>
              </div>

              <mat-form-field appearance="outline" subscriptSizing="dynamic">
                <mat-label>{{ 'builder.field.type' | translate }}</mat-label>
                <mat-select
                  class="type-select"
                  [value]="t.form.type"
                  (valueChange)="setType($event)"
                >
                  @for (type of types; track type) {
                    <mat-option [value]="type">{{ typeKey(type) | translate }}</mat-option>
                  }
                </mat-select>
              </mat-form-field>

              @if (typeChanged()) {
                <p class="note" role="note">
                  {{
                    'builder.typeChange'
                      | translate
                        : {
                            name: uniform(t.key),
                            from: glsl(t.original.type),
                            to: glsl(t.form.type),
                          }
                  }}
                </p>
              }

              <mat-form-field appearance="outline" subscriptSizing="dynamic">
                <mat-label>{{ 'builder.field.label' | translate }}</mat-label>
                <input
                  matInput
                  class="f-label"
                  [id]="uid + '-label'"
                  [attr.maxlength]="limits.labelLength"
                  [value]="t.form.label"
                  [attr.aria-invalid]="fieldInvalid('label')"
                  [attr.aria-describedby]="describedBy('label')"
                  (input)="patch({ label: text($event) })"
                />
              </mat-form-field>
              <ng-container *ngTemplateOutlet="errorsFor; context: { field: 'label' }" />

              <mat-form-field appearance="outline" subscriptSizing="dynamic">
                <mat-label>{{ 'builder.field.folder' | translate }}</mat-label>
                <input
                  matInput
                  class="f-folder"
                  [id]="uid + '-folder'"
                  [attr.list]="uid + '-folders'"
                  [attr.maxlength]="limits.folderLength"
                  [value]="t.form.folder"
                  [attr.aria-invalid]="fieldInvalid('folder')"
                  [attr.aria-describedby]="describedBy('folder', uid + '-folder-hint')"
                  (input)="patch({ folder: text($event) })"
                />
              </mat-form-field>
              <datalist [id]="uid + '-folders'">
                @for (name of folderNames(); track name) {
                  <option [value]="name"></option>
                }
              </datalist>
              <p class="hint" [id]="uid + '-folder-hint'">
                {{ 'builder.field.folderHint' | translate }}
              </p>
              <ng-container *ngTemplateOutlet="errorsFor; context: { field: 'folder' }" />

              @switch (t.form.type) {
                @case ('number') {
                  <div class="pair">
                    <div>
                      <mat-form-field appearance="outline" subscriptSizing="dynamic">
                        <mat-label>{{ 'builder.field.min' | translate }}</mat-label>
                        <input
                          matInput
                          class="f-min"
                          inputmode="decimal"
                          [id]="uid + '-min'"
                          [value]="t.form.min"
                          [attr.aria-invalid]="fieldInvalid('min')"
                          [attr.aria-describedby]="describedBy('min')"
                          (input)="patch({ min: text($event) })"
                        />
                      </mat-form-field>
                      <ng-container *ngTemplateOutlet="errorsFor; context: { field: 'min' }" />
                    </div>
                    <div>
                      <mat-form-field appearance="outline" subscriptSizing="dynamic">
                        <mat-label>{{ 'builder.field.max' | translate }}</mat-label>
                        <input
                          matInput
                          class="f-max"
                          inputmode="decimal"
                          [id]="uid + '-max'"
                          [value]="t.form.max"
                          [attr.aria-invalid]="fieldInvalid('max')"
                          [attr.aria-describedby]="describedBy('max')"
                          (input)="patch({ max: text($event) })"
                        />
                      </mat-form-field>
                      <ng-container *ngTemplateOutlet="errorsFor; context: { field: 'max' }" />
                    </div>
                    <div>
                      <mat-form-field appearance="outline" subscriptSizing="dynamic">
                        <mat-label>{{ 'builder.field.default' | translate }}</mat-label>
                        <input
                          matInput
                          class="f-default"
                          inputmode="decimal"
                          [id]="uid + '-default'"
                          [value]="t.form.default"
                          [attr.aria-invalid]="fieldInvalid('default')"
                          [attr.aria-describedby]="describedBy('default')"
                          (input)="patch({ default: text($event) })"
                        />
                      </mat-form-field>
                      <ng-container *ngTemplateOutlet="errorsFor; context: { field: 'default' }" />
                    </div>
                    <div>
                      <mat-form-field appearance="outline" subscriptSizing="dynamic">
                        <mat-label>{{ 'builder.field.step' | translate }}</mat-label>
                        <input
                          matInput
                          class="f-step"
                          inputmode="decimal"
                          [id]="uid + '-step'"
                          [value]="t.form.step"
                          [attr.aria-invalid]="fieldInvalid('step')"
                          [attr.aria-describedby]="describedBy('step')"
                          (input)="patch({ step: text($event) })"
                        />
                      </mat-form-field>
                      <ng-container *ngTemplateOutlet="errorsFor; context: { field: 'step' }" />
                    </div>
                  </div>
                }
                @case ('boolean') {
                  <mat-checkbox
                    class="f-checked"
                    [checked]="t.form.checked"
                    (change)="patch({ checked: $event.checked })"
                  >
                    {{ 'builder.field.default' | translate }}
                  </mat-checkbox>
                }
                @case ('color') {
                  <div class="color-row">
                    <mat-form-field appearance="outline" subscriptSizing="dynamic">
                      <mat-label>{{ 'builder.field.default' | translate }}</mat-label>
                      <input
                        matInput
                        class="f-default"
                        autocomplete="off"
                        spellcheck="false"
                        [id]="uid + '-default'"
                        [value]="t.form.default"
                        [attr.aria-invalid]="fieldInvalid('default')"
                        [attr.aria-describedby]="describedBy('default')"
                        (input)="patch({ default: text($event) })"
                      />
                    </mat-form-field>
                    <input
                      type="color"
                      class="swatch"
                      [attr.aria-label]="'builder.field.colorPicker' | translate"
                      [value]="swatch()"
                      (input)="patch({ default: text($event) })"
                    />
                  </div>
                  <ng-container *ngTemplateOutlet="errorsFor; context: { field: 'default' }" />
                }
                @case ('select') {
                  <fieldset class="options">
                    <legend>{{ 'builder.field.options' | translate }}</legend>
                    @for (row of t.form.options; track row.id; let n = $index) {
                      <div class="option">
                        <input
                          type="radio"
                          class="option-default"
                          [name]="uid + '-default'"
                          [checked]="t.form.defaultRow === row.id"
                          [attr.aria-label]="
                            'builder.field.optionDefault' | translate: { n: n + 1 }
                          "
                          (change)="patch({ defaultRow: row.id })"
                        />
                        <mat-form-field
                          class="option-label-field"
                          appearance="outline"
                          subscriptSizing="dynamic"
                        >
                          <input
                            matInput
                            class="option-label"
                            [value]="row.label"
                            [attr.aria-label]="
                              'builder.field.optionLabel' | translate: { n: n + 1 }
                            "
                            [attr.aria-invalid]="rowInvalid(row.id, 'label')"
                            (input)="setRow(row.id, { label: text($event) })"
                          />
                        </mat-form-field>
                        <mat-form-field
                          class="option-value-field"
                          appearance="outline"
                          subscriptSizing="dynamic"
                        >
                          <input
                            matInput
                            class="option-value"
                            inputmode="decimal"
                            [value]="row.value"
                            [attr.aria-label]="
                              'builder.field.optionValue' | translate: { n: n + 1 }
                            "
                            [attr.aria-invalid]="rowInvalid(row.id, 'value')"
                            (input)="setRow(row.id, { value: text($event) })"
                          />
                        </mat-form-field>
                        <button
                          matIconButton
                          type="button"
                          class="option-remove"
                          [disabled]="t.form.options.length <= 1"
                          [attr.aria-label]="'builder.field.removeOption' | translate: { n: n + 1 }"
                          (click)="removeOption(row.id)"
                        >
                          <mat-icon aria-hidden="true">close</mat-icon>
                        </button>
                      </div>
                      @for (error of rowErrors(row.id); track $index) {
                        <p class="error" role="alert">{{ errorText(error) }}</p>
                      }
                    }
                    <button matButton type="button" class="option-add" (click)="addOption()">
                      <mat-icon aria-hidden="true">add</mat-icon>
                      {{ 'builder.field.addOption' | translate }}
                    </button>
                    <ng-container *ngTemplateOutlet="errorsFor; context: { field: 'options' }" />
                    <ng-container *ngTemplateOutlet="errorsFor; context: { field: 'default' }" />
                  </fieldset>
                }
              }

              <div class="footer">
                <button matButton="filled" type="submit" class="apply" [disabled]="!pending()">
                  {{ 'builder.apply' | translate }}
                </button>
                <button
                  matButton="outlined"
                  type="button"
                  class="discard"
                  [disabled]="!pending()"
                  (click)="discard()"
                >
                  {{ 'builder.discard' | translate }}
                </button>
              </div>
            </form>
          } @else {
            <p class="hint placeholder">{{ 'builder.placeholder' | translate }}</p>
          }
        </section>
      </div>
    }

    <ng-template #errorsFor let-field="field">
      @for (error of fieldErrors(field); track $index) {
        <p class="error" role="alert" [id]="uid + '-' + field + '-error-' + $index">
          {{ errorText(error) }}
        </p>
      }
    </ng-template>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      container-type: inline-size;
      overflow: hidden;
      background: var(--mat-sys-surface);
      color: var(--mat-sys-on-surface);
      font: var(--mat-sys-body-medium);
    }

    :host([hidden]) {
      display: none;
    }

    .repair {
      overflow: auto;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 8px;
      max-width: 52ch;
      padding: 16px;
    }

    .repair p {
      margin: 0;
    }

    .repair mat-icon {
      color: var(--mat-sys-error);
    }

    .banners {
      display: flex;
      flex: 0 0 auto;
      flex-direction: column;
      gap: 8px;
      max-height: 45%;
      padding: 8px 8px 0;
      overflow: auto;
    }

    .banners:empty {
      display: none;
    }

    .notice,
    .guard,
    .stale {
      margin: 0;
      padding: 8px 12px;
      border-radius: 8px;
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
    }

    .notice.error,
    .stale {
      background: var(--mat-sys-error-container);
      color: var(--mat-sys-on-error-container);
    }

    .guard p,
    .stale p {
      margin: 0 0 8px;
    }

    .actions,
    .footer,
    .header-actions,
    .add {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    /* The list and the form scroll on their own, so a long form never takes the list with it. */
    .panes {
      display: grid;
      flex: 1 1 auto;
      min-height: 0;
      grid-template-columns: minmax(200px, 280px) minmax(0, 1fr);
      grid-template-rows: minmax(0, 1fr);
    }

    .list-pane {
      min-width: 0;
      min-height: 0;
      overflow: auto;
      padding: 8px;
      border-right: 1px solid var(--mat-sys-outline-variant);
    }

    .form-pane {
      min-width: 0;
      min-height: 0;
      overflow: auto;
      padding: 8px 12px 16px;
    }

    .add {
      margin-bottom: 8px;
    }

    .add-button {
      --mat-button-tonal-container-height: 32px;
    }

    .hint {
      margin: 4px 0;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }

    .group-title {
      margin: 12px 4px 4px;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-large);
      overflow-wrap: anywhere;
    }

    .rows {
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .row {
      display: flex;
      align-items: center;
      gap: 0;
      border-radius: 8px;
    }

    .row.selected {
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
    }

    .select {
      display: flex;
      flex: 1 1 auto;
      align-items: center;
      gap: 8px;
      min-width: 0;
      padding: 6px 8px;
      border: 0;
      border-radius: 8px;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: start;
      cursor: pointer;
    }

    .select:focus-visible,
    .swatch:focus-visible {
      outline: 2px solid var(--mat-sys-primary);
      outline-offset: -2px;
    }

    .select mat-icon {
      flex: 0 0 auto;
      width: 20px;
      height: 20px;
      font-size: 20px;
    }

    .names {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }

    .name,
    .uniform {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .uniform {
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-small);
    }

    .dot {
      flex: 0 0 auto;
      width: 8px;
      height: 8px;
      margin-inline-start: auto;
      border-radius: 50%;
      background: var(--mat-sys-tertiary);
    }

    .move {
      flex: 0 0 auto;
      width: 32px;
      height: 32px;
      padding: 4px;
      --mat-icon-button-state-layer-size: 32px;
    }

    .move mat-icon {
      width: 18px;
      height: 18px;
      font-size: 18px;
    }

    .form {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .form-header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
    }

    .form-title {
      margin: 0;
      font: var(--mat-sys-title-medium);
      overflow-wrap: anywhere;
    }

    .badge {
      padding: 2px 8px;
      border-radius: 999px;
      background: var(--mat-sys-tertiary-container);
      color: var(--mat-sys-on-tertiary-container);
      font: var(--mat-sys-label-small);
    }

    .uniform-line {
      margin: 0;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
      overflow-wrap: anywhere;
    }

    .note {
      margin: 0;
      padding: 8px 12px;
      border-radius: 8px;
      background: var(--mat-sys-tertiary-container);
      color: var(--mat-sys-on-tertiary-container);
      font: var(--mat-sys-body-small);
    }

    .error {
      margin: 0;
      color: var(--mat-sys-error);
      font: var(--mat-sys-body-small);
      overflow-wrap: anywhere;
    }

    mat-form-field {
      width: 100%;
    }

    .pair {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 8px;
    }

    .color-row {
      display: flex;
      align-items: flex-start;
      gap: 8px;
    }

    .swatch {
      flex: 0 0 auto;
      width: 48px;
      height: 48px;
      padding: 2px;
      border: 1px solid var(--mat-sys-outline);
      border-radius: 8px;
      background: transparent;
      cursor: pointer;
    }

    .options {
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 0;
      margin: 0;
      padding: 0;
      border: 0;
    }

    .options legend {
      padding: 0;
      margin-bottom: 4px;
      font: var(--mat-sys-label-large);
    }

    .option {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .option-label-field {
      flex: 1 1 0;
      min-width: 0;
    }

    .option-value-field {
      flex: 0 0 84px;
      width: 84px;
    }

    .option-remove {
      flex: 0 0 auto;
    }

    .option-add {
      align-self: flex-start;
    }

    .footer {
      margin-top: 4px;
    }

    .back {
      display: none;
    }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }

    /* A narrow dock shows the list or the form, never both squeezed side by side. */
    @container (max-width: 559px) {
      .panes {
        grid-template-columns: minmax(0, 1fr);
      }

      .list-pane {
        border-right: 0;
      }

      :host(.has-form) .list-pane,
      :host(:not(.has-form)) .form-pane {
        display: none;
      }

      .back {
        display: inline-flex;
      }
    }
  `,
})
export class ControlsBuilder {
  private readonly store = inject(ShaderStore);
  private readonly dialog = inject(MatDialog);
  private readonly i18n = inject(I18n);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private destroyed = false;

  /** The serialized Config text to write. The panel owns writing it, so the edit is undoable. */
  readonly commit = output<string>();
  /** The user asked to fix invalid JSON in the JSON view. */
  readonly repair = output<void>();

  protected readonly uid = `cb${nextBuilderId++}`;
  protected readonly types = CONTROL_TYPES;
  protected readonly limits = LIMITS;

  protected readonly shaderId = computed(() => this.store.record()?.id ?? null);

  protected readonly snapshot = computed<Snapshot>(() => ({
    shaderId: this.shaderId(),
    text: this.store.draft()?.controlsText ?? null,
  }));

  /** The schema the buffer actually describes — `null` when it does not. */
  protected readonly controls = computed<ShaderControl[] | null>(() => {
    const text = this.snapshot().text;
    return text === null ? null : parseControls(text);
  });

  /** There is a buffer, and it is not a schema the builder may touch. */
  protected readonly invalid = computed(
    () => this.snapshot().text !== null && this.controls() === null,
  );

  protected readonly groups = computed(() => groupControls(this.controls() ?? []));
  protected readonly folderNames = computed(() => this.groups().map((group) => group.name));

  protected readonly tx = signal<Transaction | null>(null);
  protected readonly pending = computed(() => isPending(this.tx()));
  protected readonly notice = signal<Notice | null>(null);
  protected readonly pendingAction = signal<(() => void) | null>(null);

  protected readonly stale = computed(() => {
    const t = this.tx();
    return t ? staleness(t, this.snapshot()) : null;
  });

  protected readonly analysis = computed(() => {
    const t = this.tx();
    const controls = this.controls();
    return t && controls ? analyzeForm(t.form, controls, t.key) : { control: null, errors: [] };
  });

  protected readonly typeChanged = computed(() => {
    const t = this.tx();
    return t !== null && t.form.type !== t.original.type;
  });

  protected readonly swatch = computed(() => {
    const value = this.tx()?.form.default.trim() ?? '';
    return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : '#000000';
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => (this.destroyed = true));

    // A different shader is a different document: nothing of the old form, its
    // notices or a deferred action may reach it.
    effect(() => {
      this.shaderId();
      untracked(() => {
        this.tx.set(null);
        this.notice.set(null);
        this.pendingAction.set(null);
      });
    });

    // While nothing of the user's is at stake the form simply follows the
    // buffer, so a JSON edit or an undo never leaves a stale form behind.
    effect(() => {
      const snapshot = this.snapshot();
      const controls = this.controls();
      untracked(() => {
        const t = this.tx();
        if (!t || isPending(t) || staleness(t, snapshot) !== 'text') return;
        this.tx.set(controls ? openTransaction(snapshot, controls, t.key) : null);
      });
    });
  }

  // --- Public ---------------------------------------------------------------

  /**
   * Run `action` once any unapplied form edit has been dealt with. A pending
   * form asks first — Apply, Discard or Cancel — rather than silently losing or
   * silently committing what the user typed.
   */
  guard(action: () => void): void {
    if (!this.pending()) {
      action();
      return;
    }
    this.pendingAction.set(action);
    this.focusLater('.guard-apply');
  }

  // --- Template helpers -----------------------------------------------------

  protected addKey(type: ControlType): TranslationKey {
    return ADD_KEYS[type];
  }

  protected typeKey(type: ControlType): TranslationKey {
    return TYPE_KEYS[type];
  }

  protected icon(type: ControlType): string {
    return TYPE_ICONS[type];
  }

  protected glsl(type: ControlType): string {
    return glslType(type);
  }

  protected uniform(key: string): string {
    return uniformName(key);
  }

  protected display(control: ShaderControl): string {
    return control.label ?? control.key;
  }

  protected text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected fieldErrors(field: FormField): FormError[] {
    return this.analysis().errors.filter(
      (error) => error.field === field && error.rowId === undefined,
    );
  }

  protected rowErrors(rowId: number): FormError[] {
    return this.analysis().errors.filter((error) => error.rowId === rowId);
  }

  protected fieldInvalid(field: FormField): 'true' | null {
    return this.fieldErrors(field).length > 0 ? 'true' : null;
  }

  protected rowInvalid(rowId: number, part: 'label' | 'value'): 'true' | null {
    return this.analysis().errors.some((error) => error.rowId === rowId && error.part === part)
      ? 'true'
      : null;
  }

  protected describedBy(field: FormField, extra?: string): string | null {
    const ids = this.fieldErrors(field).map((_, index) => `${this.uid}-${field}-error-${index}`);
    if (extra) ids.push(extra);
    return ids.length > 0 ? ids.join(' ') : null;
  }

  protected errorText(error: FormError): string {
    switch (error.code) {
      case 'number':
        return this.i18n.t('builder.error.number');
      case 'optionLabel':
        return this.i18n.t('builder.error.optionLabel');
      case 'optionDuplicate':
        return this.i18n.t('builder.error.optionDuplicate');
      case 'optionDefault':
        return this.i18n.t('builder.error.optionDefault');
      default:
        return error.message ?? '';
    }
  }

  // --- Selection and form state ---------------------------------------------

  protected select(key: string): void {
    this.guard(() => {
      this.notice.set(null);
      this.open(key);
      this.focusLater('.form-pane:not([hidden]) .form-title', true);
    });
  }

  protected closeForm(): void {
    const key = this.tx()?.key;
    this.guard(() => {
      this.tx.set(null);
      if (key) this.focusLater(`.select[data-key="${key}"]`);
    });
  }

  private open(key: string): void {
    const controls = this.controls();
    this.tx.set(controls ? openTransaction(this.snapshot(), controls, key) : null);
  }

  protected patch(change: Partial<ControlForm>): void {
    this.tx.update((t) => (t ? { ...t, form: { ...t.form, ...change } } : t));
  }

  protected setType(type: ControlType): void {
    this.tx.update((t) => (t ? { ...t, form: retypeForm(t.form, type) } : t));
  }

  protected setRow(id: number, change: { label?: string; value?: string }): void {
    this.tx.update((t) =>
      t
        ? {
            ...t,
            form: {
              ...t.form,
              options: t.form.options.map((row) => (row.id === id ? { ...row, ...change } : row)),
            },
          }
        : t,
    );
  }

  protected addOption(): void {
    this.tx.update((t) => (t ? { ...t, form: addOptionRow(t.form) } : t));
  }

  protected removeOption(id: number): void {
    this.tx.update((t) => (t ? { ...t, form: removeOptionRow(t.form, id) } : t));
  }

  protected discard(): void {
    this.tx.update((t) => (t ? { ...t, form: t.baseline } : t));
  }

  /** Throw the form away for the current buffer's version of the same control. */
  protected reload(explain = false): void {
    const key = this.tx()?.key;
    this.tx.set(null);
    if (key) this.open(key);
    if (explain) this.notice.set({ text: this.i18n.t('builder.conflict'), error: true });
  }

  // --- Guard bar --------------------------------------------------------------

  protected guardApply(): void {
    const action = this.pendingAction();
    this.pendingAction.set(null);
    if (action && this.apply()) action();
  }

  protected guardDiscard(): void {
    const action = this.pendingAction();
    this.pendingAction.set(null);
    this.discard();
    action?.();
  }

  protected cancelGuard(): void {
    this.pendingAction.set(null);
    this.focusLater('.form-title');
  }

  // --- Applying ---------------------------------------------------------------

  /** Write the form into the Config. Returns whether the buffer now matches it. */
  protected apply(): boolean {
    const t = this.tx();
    if (!t) return false;

    const outcome = planApply(t, this.snapshot());
    switch (outcome.status) {
      case 'stale':
        this.reload(true);
        return false;
      case 'form-invalid':
        this.notice.set({ text: this.i18n.t('builder.error.fix'), error: true });
        this.focusLater('[aria-invalid="true"]');
        return false;
      default:
        if (!this.write(outcome)) return false;
    }

    this.open(t.key);
    this.notice.set({
      text: this.i18n.t('builder.applied', { name: t.form.label.trim() || t.key }),
      error: false,
    });
    return true;
  }

  /** Hand a plan to the panel. Returns false when nothing could be written. */
  private write(plan: CommitPlan): boolean {
    switch (plan.status) {
      case 'blocked':
        this.notice.set({ text: this.i18n.t('builder.blocked'), error: true });
        return false;
      case 'invalid':
        this.notice.set({ text: plan.errors.join(' '), error: true });
        return false;
      case 'noop':
        return true;
      case 'commit':
        this.commit.emit(plan.text);
        if (!sameText(this.snapshot().text, plan.text)) {
          this.notice.set({ text: this.i18n.t('builder.notApplied'), error: true });
          return false;
        }
        return true;
    }
  }

  // --- Structural edits -------------------------------------------------------

  protected add(type: ControlType): void {
    this.guard(() => {
      const controls = this.controls();
      if (!controls) return;

      const created = newControl(type, controls);
      if (!this.write(planCommit(this.snapshot().text ?? '', [...controls, created]))) return;

      this.open(created.key);
      this.notice.set({
        text: this.i18n.t('builder.added', { name: created.key }),
        error: false,
      });
      this.focusLater('.f-label');
    });
  }

  protected move(key: string, direction: -1 | 1): void {
    this.guard(() => {
      const controls = this.controls();
      const index = controls?.findIndex((control) => control.key === key) ?? -1;
      const next = controls && index >= 0 ? moveWithinGroup(controls, index, direction) : null;
      if (!next) return;
      if (!this.write(planCommit(this.snapshot().text ?? '', next))) return;

      this.notice.set({ text: this.i18n.t('builder.moved', { name: key }), error: false });
      // Moving a node drops focus in some browsers; put it back where the user was.
      const side = direction < 0 ? 'up' : 'down';
      const other = direction < 0 ? 'down' : 'up';
      this.focusLater(`[data-move="${key}:${side}"]:not(:disabled), [data-move="${key}:${other}"]`);
    });
  }

  protected duplicate(): void {
    this.guard(() => {
      const t = this.tx();
      const controls = this.controls();
      const index = controls?.findIndex((control) => control.key === t?.key) ?? -1;
      const copy =
        controls && index >= 0
          ? duplicateControl(controls, index, this.i18n.t('builder.copySuffix'))
          : null;
      if (!copy) return;
      if (!this.write(planCommit(this.snapshot().text ?? '', copy.controls))) return;

      this.open(copy.key);
      this.notice.set({
        text: this.i18n.t('builder.duplicated', { name: copy.key }),
        error: false,
      });
      this.focusLater('.f-label');
    });
  }

  protected remove(): void {
    this.guard(() => void this.confirmRemove());
  }

  private async confirmRemove(): Promise<void> {
    const t = this.tx();
    if (!t) return;
    const shaderId = this.snapshot().shaderId;

    const { ConfirmDialog } = await import('../dialogs/confirm-dialog');
    const confirmed = await new Promise<boolean>((resolve) => {
      this.dialog
        .open<InstanceType<typeof ConfirmDialog>, ConfirmDialogData, boolean>(ConfirmDialog, {
          data: {
            title: this.i18n.t('builder.deleteTitle'),
            message: this.i18n.t('builder.deleteMessage', { name: this.uniform(t.key) }),
            confirmText: this.i18n.t('builder.delete'),
            destructive: true,
          },
        })
        .afterClosed()
        .subscribe((result) => resolve(result === true));
    });
    // The editor can be closed, or another shader opened, while the dialog is up.
    if (!confirmed || this.destroyed || this.snapshot().shaderId !== shaderId) return;

    // Looked up again by key: the buffer may have moved under the dialog.
    const controls = this.controls();
    const index = controls?.findIndex((control) => control.key === t.key) ?? -1;
    if (!controls || index < 0) return;
    if (!this.write(planCommit(this.snapshot().text ?? '', removeControl(controls, index)))) return;

    this.tx.set(null);
    this.notice.set({ text: this.i18n.t('builder.deleted', { name: t.key }), error: false });
    this.focusLater('.add-button');
  }

  // --- Focus --------------------------------------------------------------------

  /**
   * Focus a part of the builder once Angular has rendered it. `visibleOnly`
   * skips the target when its pane is not shown (a wide layout keeps the list
   * in view, and moving focus out of it on every selection would be rude).
   */
  private focusLater(selector: string, narrowOnly = false): void {
    afterNextRender(
      () => {
        const root = this.host.nativeElement;
        if (narrowOnly && root.querySelector<HTMLElement>('.list-pane')?.offsetParent !== null) {
          return;
        }
        root.querySelector<HTMLElement>(selector)?.focus();
      },
      { injector: this.injector },
    );
  }
}
