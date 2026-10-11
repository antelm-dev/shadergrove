import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';

import {
  findPostProcessingEffect,
  updatePostProcessingEffect,
  type CustomEffect,
  type CustomEffectDefinition,
  type RenderSettings,
  type ShaderParams,
} from '@shadergrove/shared/model';
import { LIMITS, sanitizeParams, validateControls } from '@shadergrove/shared/validate';
import { CodeEditor, type EditorDoc } from '../../editor/code-editor';
import { EditorSettings } from '../../editor/editor-settings';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { effectDocId } from '../../rendering/engine/custom-effect-pass';
import { InspectorSession } from './inspector-session';

export interface CustomEffectEditorData {
  instanceId: string;
}

/**
 * Edits one custom effect of the open shader: its name, its GLSL and its
 * controls. Every change goes straight into the draft through
 * `ShaderStore.setRender` — the same draft/save cycle as any other edit — so
 * the preview follows, and a version that does not compile leaves the last one
 * that did on screen while the error points at the line. Revert puts back the
 * definition the dialog opened with.
 */
@Component({
  selector: 'app-custom-effect-editor',
  imports: [FormsModule, MatButtonModule, MatDialogModule, CodeEditor, TranslatePipe],
  template: `
    <h2 mat-dialog-title>{{ 'effectEditor.title' | translate }}</h2>

    <mat-dialog-content class="content">
      @if (effect(); as current) {
        <label class="field">
          <span>{{ 'effectEditor.name' | translate }}</span>
          <input
            data-testid="effect-name"
            type="text"
            [maxLength]="nameLength"
            [ngModel]="current.definition.name"
            (ngModelChange)="setName($event)"
            (blur)="trimName()"
          />
        </label>

        <p class="signature">{{ 'effectEditor.signature' | translate }}</p>

        <app-code-editor
          class="code"
          [doc]="doc()!"
          [diagnostics]="diagnostics()"
          [appearance]="settings.effective()"
          (valueChange)="setSource($event.value)"
        />

        @if (sourceError()) {
          <p class="errors" role="alert" data-testid="effect-source-too-long">
            {{ 'effectEditor.sourceTooLong' | translate: { max: sourceLength } }}
          </p>
        }

        @if (diagnostics().length) {
          <ul class="errors" data-testid="effect-errors">
            @for (diagnostic of diagnostics(); track $index) {
              <li>
                @if (diagnostic.line > 0) {
                  {{
                    'rack.errorLine'
                      | translate: { line: diagnostic.line, message: diagnostic.message }
                  }}
                } @else {
                  {{ diagnostic.message }}
                }
              </li>
            }
          </ul>
        }

        <label class="field controls">
          <span>{{ 'effectEditor.controls' | translate }}</span>
          <textarea
            data-testid="effect-controls"
            rows="6"
            spellcheck="false"
            [ngModel]="controlsText()"
            (ngModelChange)="setControls($event)"
          ></textarea>
        </label>
        @if (controlsError(); as error) {
          <p class="errors" role="alert">
            {{ 'effectEditor.controlsInvalid' | translate: { error } }}
          </p>
        }
      } @else {
        <p>{{ 'effectEditor.gone' | translate }}</p>
      }
    </mat-dialog-content>

    <mat-dialog-actions class="actions">
      <button matButton type="button" data-testid="effect-revert" (click)="revert()">
        {{ 'effectEditor.revert' | translate }}
      </button>
      <button
        matButton="filled"
        type="button"
        cdkFocusInitial
        data-testid="effect-done"
        [disabled]="unapplied()"
        (click)="close()"
      >
        {{ 'effectEditor.done' | translate }}
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    .content {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font: var(--mat-sys-label-medium);
      color: var(--mat-sys-on-surface-variant);
    }

    .field input,
    .field textarea {
      font: 13px / 1.4 var(--studio-font-mono);
      color: var(--mat-sys-on-surface);
      background: color-mix(in srgb, var(--mat-sys-on-surface) 5%, transparent);
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 4px;
      padding: 6px 8px;
    }

    .signature {
      margin: 0;
      font: var(--mat-sys-body-small);
      color: var(--mat-sys-on-surface-variant);
    }

    .code {
      height: min(360px, 45dvh);
    }

    .errors {
      margin: 0;
      padding-left: 18px;
      color: var(--mat-sys-error);
      font: var(--mat-sys-body-small);
    }

    .actions {
      justify-content: flex-end;
    }
  `,
})
export class CustomEffectEditor {
  private readonly data = inject<CustomEffectEditorData>(MAT_DIALOG_DATA);
  private readonly dialogRef = inject<MatDialogRef<CustomEffectEditor>>(MatDialogRef);
  private readonly session = inject(InspectorSession);
  protected readonly settings = inject(EditorSettings);

  protected readonly nameLength = LIMITS.nameLength;

  protected readonly effect = computed<CustomEffect | null>(() => {
    const render = this.session.render();
    const effect = render && findPostProcessingEffect(render, this.data.instanceId);
    return effect?.type === 'custom' ? effect : null;
  });

  /** One model per effect id, so typing never lands in another document. */
  protected readonly doc = computed<EditorDoc | null>(() => {
    const effect = this.effect();
    return effect
      ? {
          id: effectDocId(effect.instanceId),
          language: 'glsl',
          value: this.pendingSource() ?? effect.definition.source,
        }
      : null;
  });

  protected readonly diagnostics = computed(() =>
    this.session
      .diagnostics()
      .filter((diagnostic) => diagnostic.docId === effectDocId(this.data.instanceId)),
  );

  /** What the textarea shows: the last text typed, which may not parse yet. */
  private readonly controlsDraft = signal<string | null>(null);
  protected readonly controlsText = computed(
    () => this.controlsDraft() ?? JSON.stringify(this.effect()?.definition.controls ?? [], null, 2),
  );
  protected readonly controlsError = signal<string | null>(null);
  protected readonly sourceError = signal(false);
  protected readonly sourceLength = LIMITS.customEffectSourceLength;

  /**
   * Something typed here is not in the draft: code over the size limit, or
   * controls that do not validate. Closing would throw it away, so while this
   * holds Done is disabled and so are Escape and the backdrop.
   */
  protected readonly unapplied = computed(
    () => this.sourceError() || this.controlsError() !== null,
  );

  /** Code over the size limit, kept in the editor only; `null` when the draft has what was typed. */
  private readonly pendingSource = signal<string | null>(null);
  /** What Revert puts back: the definition, and the values, the dialog opened with. */
  private readonly original: CustomEffectDefinition | null = structuredClone(
    this.effect()?.definition ?? null,
  );
  private readonly originalValues: ShaderParams = structuredClone(this.effect()?.values ?? {});

  constructor() {
    effect(() => (this.dialogRef.disableClose = this.unapplied()));
  }

  /** On blur. Reads the name from the draft, never from a template snapshot a keystroke may have outrun. */
  protected trimName(): void {
    const name = this.effect()?.definition.name;
    if (name && name !== name.trim()) this.setName(name.trim());
  }

  /** Kept as typed — trimming every keystroke would eat the space before the next word. */
  protected setName(name: string): void {
    if (name.trim()) this.updateDefinition((definition) => ({ ...definition, name }));
  }

  /**
   * Every keystroke goes into the draft at once, so a save (Ctrl+S works inside
   * the dialog) always has the latest code; the renderer is what waits for the
   * typing to pause before compiling. Code over the size limit stays only in
   * the editor, flagged, and the dialog refuses to close over it.
   */
  protected setSource(source: string): void {
    const tooLong = source.length > LIMITS.customEffectSourceLength;
    this.sourceError.set(tooLong);
    if (tooLong) {
      this.pendingSource.set(source);
      return;
    }
    this.pendingSource.set(null);
    this.updateDefinition((definition) => ({ ...definition, source }));
  }

  /** Applies controls only once the text is a valid set of them; until then it says why not. */
  protected setControls(text: string): void {
    this.controlsDraft.set(text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.controlsError.set('not valid JSON');
      return;
    }
    if (Array.isArray(parsed) && parsed.length > LIMITS.customEffectControlCount) {
      this.controlsError.set(`at most ${LIMITS.customEffectControlCount} controls`);
      return;
    }
    const result = validateControls(parsed);
    if (!result.ok) {
      this.controlsError.set(result.errors.join('; '));
      return;
    }
    this.controlsError.set(null);
    this.mutate((effect) => ({
      ...effect,
      definition: { ...effect.definition, controls: result.value },
      values: sanitizeParams(result.value, effect.values),
    }));
  }

  protected revert(): void {
    const original = this.original;
    if (!original) return;
    this.pendingSource.set(null);
    this.controlsDraft.set(null);
    this.controlsError.set(null);
    this.sourceError.set(false);
    this.mutate((effect) => ({
      ...effect,
      definition: structuredClone(original),
      // From the values it opened with: an edit that dropped a control already pruned its value.
      values: sanitizeParams(original.controls, this.originalValues),
    }));
  }

  protected close(): void {
    if (!this.unapplied()) this.dialogRef.close();
  }

  private updateDefinition(
    update: (definition: CustomEffectDefinition) => CustomEffectDefinition,
  ): void {
    this.mutate((effect) => ({ ...effect, definition: update(effect.definition) }));
  }

  private mutate(update: (effect: CustomEffect) => CustomEffect): void {
    const render: RenderSettings | null = this.session.render();
    if (!render) return;
    this.session.setRender(updatePostProcessingEffect(render, this.data.instanceId, update));
  }
}
