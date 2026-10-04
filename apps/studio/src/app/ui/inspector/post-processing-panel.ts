import { Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatSliderModule } from '@angular/material/slider';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';

import type { CompileDiagnostic } from '@shadergrove/shared/diagnostic';
import {
  POST_PROCESSING_EFFECT_TYPES,
  addPostProcessingEffect,
  canAddPostProcessingEffect,
  duplicatePostProcessingEffect,
  isCustomEffectRunnable,
  movePostProcessingEffect,
  removePostProcessingEffect,
  reorderPostProcessingEffect,
  resetPostProcessingEffect,
  setPostProcessingEffectEnabled,
  updatePostProcessingEffect,
  withPostProcessingEnabled,
  type BloomEffect,
  type BloomSettings,
  type CustomEffect,
  type NumberControl,
  type ParamValue,
  type PostProcessingEffect,
  type PostProcessingEffectType,
  type RenderSettings,
  type SelectControl,
  type VignetteEffect,
  type VignetteSettings,
} from '@shadergrove/shared/model';
import { LIMITS } from '@shadergrove/shared/validate';
import { I18n } from '../../i18n/i18n';
import type { TranslationKey } from '../../i18n/keys';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { effectDocId } from '../../rendering/engine/custom-effect-pass';
import { ShaderStore } from '../../workspace/shader-store';
import { CustomEffectEditor, type CustomEffectEditorData } from './custom-effect-editor';

const EFFECT_LABEL_KEY: Record<PostProcessingEffectType, TranslationKey> = {
  bloom: 'rack.bloom',
  vignette: 'rack.vignette',
  custom: 'rack.custom',
};

/**
 * The Effects Rack: the post-processing chain's only UI. It lives above the
 * shader's own parameter controls, next to the params it renders alongside.
 *
 * Every row is one instance, addressed by its `instanceId` — two Vignettes, or
 * two custom effects, are two rows set, moved, toggled and removed on their
 * own. A custom effect's values are set here; its code, name and controls in
 * `CustomEffectEditor`.
 *
 * Every mutation reads the draft's `render`, runs it through one of the pure
 * chain helpers from `@shadergrove/shared/model`, and writes the whole result
 * back through `ShaderStore.setRender` — exactly like a parameter edit: one
 * immutable value, the draft marked dirty, surviving save/reload and recovery
 * the same way.
 */
@Component({
  selector: 'app-post-processing-panel',
  imports: [
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatMenuModule,
    MatSliderModule,
    MatSlideToggleModule,
    MatTooltipModule,
    TranslatePipe,
  ],
  template: `
    <section class="rack" [attr.aria-label]="'rack.title' | translate">
      <header class="rack-header">
        <h3 class="rack-heading">{{ 'rack.title' | translate }}</h3>

        <mat-slide-toggle
          data-testid="pp-master-toggle"
          [attr.aria-label]="'rack.masterAria' | translate"
          [ngModel]="chainEnabled()"
          (ngModelChange)="setChainEnabled($event)"
        />

        <button
          matIconButton
          type="button"
          data-testid="pp-add"
          [disabled]="!canAdd()"
          [matTooltip]="'rack.addAria' | translate"
          [attr.aria-label]="'rack.addAria' | translate"
          [matMenuTriggerFor]="addMenu"
        >
          <mat-icon>add</mat-icon>
        </button>
      </header>

      <mat-menu #addMenu="matMenu">
        @for (type of types; track type) {
          <button
            mat-menu-item
            type="button"
            [attr.data-testid]="'pp-add-' + type"
            (click)="add(type)"
          >
            <span>{{ typeLabel(type) }}</span>
          </button>
        }
      </mat-menu>

      @if (!canAdd()) {
        <p class="empty" data-testid="pp-full">
          {{ 'rack.full' | translate: { max: maxEffects } }}
        </p>
      }

      @if (effects().length === 0) {
        <p class="empty">{{ 'rack.empty' | translate }}</p>
      }

      @for (effect of effects(); track effect.instanceId; let first = $first; let last = $last) {
        <section
          class="effect"
          [class.effect-disabled]="!effect.enabled"
          [attr.data-testid]="'pp-effect-' + effect.instanceId"
          [attr.aria-label]="name(effect)"
          draggable="true"
          (dragstart)="onDragStart($event, effect.instanceId)"
          (dragover)="onDragOver($event, effect.instanceId)"
          (drop)="onDrop($event, effect.instanceId)"
          (dragend)="onDragEnd()"
        >
          <header class="effect-header">
            <mat-icon class="drag-handle" aria-hidden="true">drag_indicator</mat-icon>

            <mat-slide-toggle
              class="effect-toggle"
              [attr.data-testid]="'pp-enable-' + effect.instanceId"
              [attr.aria-label]="ariaFor('rack.enabledAria', effect)"
              [ngModel]="effect.enabled"
              (ngModelChange)="setEnabled(effect.instanceId, $event)"
            >
              {{ name(effect) }}
            </mat-slide-toggle>


            @if (effect.type === 'custom') {
              <button
                matIconButton
                type="button"
                [attr.data-testid]="'pp-edit-' + effect.instanceId"
                [matTooltip]="ariaFor('rack.editAria', effect)"
                [attr.aria-label]="ariaFor('rack.editAria', effect)"
                (click)="edit(effect.instanceId)"
              >
                <mat-icon>code</mat-icon>
              </button>
            }
            <button
              matIconButton
              type="button"
              [attr.data-testid]="'pp-move-up-' + effect.instanceId"
              [disabled]="first"
              [matTooltip]="ariaFor('rack.moveUpAria', effect)"
              [attr.aria-label]="ariaFor('rack.moveUpAria', effect)"
              (click)="move(effect.instanceId, 'up')"
            >
              <mat-icon>arrow_upward</mat-icon>
            </button>
            <button
              matIconButton
              type="button"
              [attr.data-testid]="'pp-move-down-' + effect.instanceId"
              [disabled]="last"
              [matTooltip]="ariaFor('rack.moveDownAria', effect)"
              [attr.aria-label]="ariaFor('rack.moveDownAria', effect)"
              (click)="move(effect.instanceId, 'down')"
            >
              <mat-icon>arrow_downward</mat-icon>
            </button>
            <!-- The rarer actions, so the effect's name keeps the room it needs. -->
            <button
              matIconButton
              type="button"
              [attr.data-testid]="'pp-more-' + effect.instanceId"
              [matTooltip]="ariaFor('rack.moreAria', effect)"
              [attr.aria-label]="ariaFor('rack.moreAria', effect)"
              [matMenuTriggerFor]="moreMenu"
            >
              <mat-icon>more_vert</mat-icon>
            </button>
            <mat-menu #moreMenu="matMenu">
              <button
                mat-menu-item
                type="button"
                [attr.data-testid]="'pp-duplicate-' + effect.instanceId"
                [disabled]="!canAdd()"
                (click)="duplicate(effect.instanceId)"
              >
                <mat-icon>content_copy</mat-icon>
                <span>{{ ariaFor('rack.duplicateAria', effect) }}</span>
              </button>
              <button
                mat-menu-item
                type="button"
                [attr.data-testid]="'pp-reset-' + effect.instanceId"
                (click)="reset(effect.instanceId)"
              >
                <mat-icon>restart_alt</mat-icon>
                <span>{{ ariaFor('rack.resetAria', effect) }}</span>
              </button>
              <button
                mat-menu-item
                type="button"
                [attr.data-testid]="'pp-remove-' + effect.instanceId"
                (click)="remove(effect.instanceId)"
              >
                <mat-icon>close</mat-icon>
                <span>{{ ariaFor('rack.removeAria', effect) }}</span>
              </button>
            </mat-menu>
          </header>

          @switch (effect.type) {
            @case ('bloom') {
              <div class="sliders">
                <label class="field">
                  <span class="field-label">
                    {{ 'rack.strength' | translate }}
                    <span class="value">{{ i18n.formatNumber(effect.settings.strength, twoDecimals) }}</span>
                  </span>
                  <mat-slider [min]="0" [max]="2" [step]="0.01">
                    <input
                      matSliderThumb
                      [ngModel]="effect.settings.strength"
                      (ngModelChange)="setBloomSetting(effect.instanceId, { strength: $event })"
                    />
                  </mat-slider>
                </label>
                <label class="field">
                  <span class="field-label">
                    {{ 'rack.radius' | translate }}
                    <span class="value">{{ i18n.formatNumber(effect.settings.radius, twoDecimals) }}</span>
                  </span>
                  <mat-slider [min]="0" [max]="1" [step]="0.01">
                    <input
                      matSliderThumb
                      [ngModel]="effect.settings.radius"
                      (ngModelChange)="setBloomSetting(effect.instanceId, { radius: $event })"
                    />
                  </mat-slider>
                </label>
                <label class="field">
                  <span class="field-label">
                    {{ 'rack.threshold' | translate }}
                    <span class="value">{{ i18n.formatNumber(effect.settings.threshold, twoDecimals) }}</span>
                  </span>
                  <mat-slider [min]="0" [max]="1" [step]="0.01">
                    <input
                      matSliderThumb
                      [ngModel]="effect.settings.threshold"
                      (ngModelChange)="setBloomSetting(effect.instanceId, { threshold: $event })"
                    />
                  </mat-slider>
                </label>
              </div>
            }
            @case ('vignette') {
              <div class="sliders">
                <label class="field">
                  <span class="field-label">
                    {{ 'rack.intensity' | translate }}
                    <span class="value">{{ i18n.formatNumber(effect.settings.intensity, twoDecimals) }}</span>
                  </span>
                  <mat-slider [min]="0" [max]="1" [step]="0.01">
                    <input
                      matSliderThumb
                      [ngModel]="effect.settings.intensity"
                      (ngModelChange)="setVignetteSetting(effect.instanceId, { intensity: $event })"
                    />
                  </mat-slider>
                </label>
                <label class="field">
                  <span class="field-label">
                    {{ 'rack.softness' | translate }}
                    <span class="value">{{ i18n.formatNumber(effect.settings.softness, twoDecimals) }}</span>
                  </span>
                  <mat-slider [min]="0" [max]="1" [step]="0.01">
                    <input
                      matSliderThumb
                      [ngModel]="effect.settings.softness"
                      (ngModelChange)="setVignetteSetting(effect.instanceId, { softness: $event })"
                    />
                  </mat-slider>
                </label>
                <label class="field">
                  <span class="field-label">
                    {{ 'rack.roundness' | translate }}
                    <span class="value">{{ i18n.formatNumber(effect.settings.roundness, twoDecimals) }}</span>
                  </span>
                  <mat-slider [min]="0" [max]="1" [step]="0.01">
                    <input
                      matSliderThumb
                      [ngModel]="effect.settings.roundness"
                      (ngModelChange)="setVignetteSetting(effect.instanceId, { roundness: $event })"
                    />
                  </mat-slider>
                </label>
              </div>
            }
            @case ('custom') {
              @if (!runnable(effect)) {
                <p class="status" [attr.data-testid]="'pp-unsupported-' + effect.instanceId">
                  {{ 'rack.unsupported' | translate: { version: effect.definition.apiVersion } }}
                </p>
              }
              @for (diagnostic of diagnosticsFor(effect); track $index) {
                @if (diagnostic.severity === 'error') {
                  <p class="status error" role="status" [attr.data-testid]="'pp-error-' + effect.instanceId">
                    @if (diagnostic.line > 0) {
                      {{ 'rack.errorLine' | translate: { line: diagnostic.line, message: diagnostic.message } }}
                    } @else {
                      {{ diagnostic.message }}
                    }
                  </p>
                } @else if (runnable(effect)) {
                  <p class="status">{{ diagnostic.message }}</p>
                }
              }
              <div class="sliders">
                @for (control of effect.definition.controls; track control.key) {
                  @switch (control.type) {
                    @case ('number') {
                      <label class="field">
                        <span class="field-label">
                          {{ control.label ?? control.key }}
                          <span class="value">{{ i18n.formatNumber(+effect.values[control.key]) }}</span>
                        </span>
                        <mat-slider [min]="control.min" [max]="control.max" [step]="step(control)">
                          <input
                            matSliderThumb
                            [attr.data-testid]="'pp-value-' + effect.instanceId + '-' + control.key"
                            [ngModel]="effect.values[control.key]"
                            (ngModelChange)="setValue(effect.instanceId, control.key, $event)"
                          />
                        </mat-slider>
                      </label>
                    }
                    @case ('boolean') {
                      <mat-slide-toggle
                        class="field-toggle"
                        [attr.data-testid]="'pp-value-' + effect.instanceId + '-' + control.key"
                        [ngModel]="effect.values[control.key]"
                        (ngModelChange)="setValue(effect.instanceId, control.key, $event)"
                      >
                        {{ control.label ?? control.key }}
                      </mat-slide-toggle>
                    }
                    @case ('color') {
                      <label class="field">
                        <span class="field-label">{{ control.label ?? control.key }}</span>
                        <input
                          class="native"
                          type="color"
                          [attr.data-testid]="'pp-value-' + effect.instanceId + '-' + control.key"
                          [ngModel]="effect.values[control.key]"
                          (ngModelChange)="setValue(effect.instanceId, control.key, $event)"
                        />
                      </label>
                    }
                    @case ('select') {
                      <label class="field">
                        <span class="field-label">{{ control.label ?? control.key }}</span>
                        <select
                          class="native"
                          [attr.data-testid]="'pp-value-' + effect.instanceId + '-' + control.key"
                          [ngModel]="effect.values[control.key]"
                          (ngModelChange)="setValue(effect.instanceId, control.key, +$event)"
                        >
                          @for (option of options(control); track option[0]) {
                            <option [ngValue]="option[1]">{{ option[0] }}</option>
                          }
                        </select>
                      </label>
                    }
                  }
                }
              </div>
            }
          }
        </section>
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
      padding: 0 12px;
      margin-bottom: 8px;
      border-bottom: 1px solid color-mix(in srgb, var(--mat-sys-outline-variant) 55%, transparent);
    }

    .rack {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding-bottom: 10px;
    }

    .rack-header {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .rack-heading {
      flex: 1;
      margin: 0;
      font: var(--mat-sys-title-small);
      color: var(--mat-sys-on-surface-variant);
    }

    .empty {
      margin: 0;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }

    .effect {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 8px;
      border-radius: var(--mat-sys-corner-small, 6px);
      background: color-mix(in srgb, var(--mat-sys-on-surface) 4%, transparent);
    }

    .effect-disabled {
      opacity: 0.7;
    }

    .effect-header {
      display: flex;
      align-items: center;
      gap: 2px;
    }

    .effect-toggle {
      flex: 1;
      min-width: 0;
    }

    /* A long name is cut rather than wrapped into the buttons beside it. */
    .effect-toggle ::ng-deep label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .drag-handle {
      flex: 0 0 auto;
      color: var(--mat-sys-on-surface-variant);
      cursor: grab;
    }

    .spacer {
      flex: 1;
    }

    .sliders {
      display: flex;
      flex-direction: column;
    }

    .status {
      margin: 0;
      font: var(--mat-sys-body-small);
      color: var(--mat-sys-on-surface-variant);
    }

    .status.error {
      color: var(--mat-sys-error);
    }

    /* One row per setting, laid out like the parameter panel's: name, track,
       value. The label's text and its value are siblings in the markup, so the
       label dissolves into the grid and the value is ordered after the slider. */
    .field {
      display: grid;
      grid-template-columns: 38% minmax(0, 1fr) 40px;
      align-items: center;
      column-gap: 8px;
      min-height: 26px;
    }

    .field-label {
      display: contents;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-medium);
    }

    .value {
      order: 3;
      color: var(--mat-sys-on-surface);
      font: 11.5px / 1 var(--studio-font-mono);
      font-variant-numeric: tabular-nums;
      text-align: right;
    }

    .native {
      order: 2;
      min-width: 0;
    }

    .field-toggle {
      min-height: 26px;
    }

    /* Material lays its thumb out against a 48px host, so the row is tightened
       with negative margins rather than by shrinking the slider itself. */
    mat-slider {
      order: 2;
      width: auto;
      min-width: 0;
      margin: -11px 4px;
    }
  `,
})
export class PostProcessingPanel {
  protected readonly store = inject(ShaderStore);
  protected readonly i18n = inject(I18n);
  protected readonly twoDecimals: Intl.NumberFormatOptions = {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  };
  private readonly dialog = inject(MatDialog);

  protected readonly types = POST_PROCESSING_EFFECT_TYPES;

  private readonly render = computed<RenderSettings | null>(
    () => this.store.draft()?.render ?? null,
  );
  protected readonly effects = computed<PostProcessingEffect[]>(
    () => this.render()?.postProcessing.effects ?? [],
  );
  protected readonly chainEnabled = computed(() => this.render()?.postProcessing.enabled ?? true);
  protected readonly maxEffects = LIMITS.postProcessingEffectCount;
  protected readonly canAdd = computed(() => {
    const render = this.render();
    return !!render && canAddPostProcessingEffect(render);
  });

  /** Each instance's display name: a custom effect's own, or its type's — numbered when there are several. */
  private readonly names = computed(() => {
    const names = new Map<string, string>();
    const seen = new Map<PostProcessingEffectType, number>();
    const effects = this.effects();
    for (const effect of effects) {
      if (effect.type === 'custom') {
        names.set(effect.instanceId, effect.definition.name);
        continue;
      }
      const n = (seen.get(effect.type) ?? 0) + 1;
      seen.set(effect.type, n);
      const several = effects.filter((other) => other.type === effect.type).length > 1;
      const label = this.typeLabel(effect.type);
      names.set(
        effect.instanceId,
        several ? this.i18n.t('rack.instanceName', { name: label, n }) : label,
      );
    }
    return names;
  });

  private dragging: string | null = null;

  protected typeLabel(type: PostProcessingEffectType): string {
    return this.i18n.t(EFFECT_LABEL_KEY[type]);
  }

  protected name(effect: PostProcessingEffect): string {
    return this.names().get(effect.instanceId) ?? this.typeLabel(effect.type);
  }

  protected ariaFor(key: TranslationKey, effect: PostProcessingEffect): string {
    return this.i18n.t(key, { name: this.name(effect) });
  }

  protected runnable(effect: CustomEffect): boolean {
    return isCustomEffectRunnable(effect);
  }

  /** The renderer's diagnostics for one custom effect: compile errors, a skipped API, a suspension. */
  protected diagnosticsFor(effect: PostProcessingEffect): CompileDiagnostic[] {
    const docId = effectDocId(effect.instanceId);
    return this.store.allDiagnostics().filter((diagnostic) => diagnostic.docId === docId);
  }

  protected step(control: NumberControl): number {
    return control.step ?? (control.max - control.min) / 100;
  }

  protected options(control: SelectControl): [string, number][] {
    return Object.entries(control.options);
  }

  protected setChainEnabled(enabled: boolean): void {
    this.mutate((render) => withPostProcessingEnabled(render, enabled));
  }

  protected add(type: PostProcessingEffectType): void {
    const before = new Set(this.effects().map((effect) => effect.instanceId));
    this.mutate((render) => addPostProcessingEffect(render, type));
    if (type !== 'custom') return;
    const added = this.effects().find((effect) => !before.has(effect.instanceId));
    if (added) this.edit(added.instanceId);
  }

  protected duplicate(instanceId: string): void {
    this.mutate((render) => duplicatePostProcessingEffect(render, instanceId));
  }

  protected remove(instanceId: string): void {
    this.mutate((render) => removePostProcessingEffect(render, instanceId));
  }

  protected reset(instanceId: string): void {
    this.mutate((render) => resetPostProcessingEffect(render, instanceId));
  }

  protected setEnabled(instanceId: string, enabled: boolean): void {
    this.mutate((render) => setPostProcessingEffectEnabled(render, instanceId, enabled));
  }

  protected move(instanceId: string, direction: 'up' | 'down'): void {
    this.mutate((render) => movePostProcessingEffect(render, instanceId, direction));
  }

  protected edit(instanceId: string): void {
    this.dialog.open<CustomEffectEditor, CustomEffectEditorData>(CustomEffectEditor, {
      data: { instanceId },
      autoFocus: 'dialog',
      // Wide enough for GLSL; Material's default panel width would clip it.
      width: '800px',
      maxWidth: '94vw',
    });
  }

  /**
   * Each setter re-reads the instance from the render passed into `mutate` —
   * never from a template-bound closure — so a rapid string of edits (or a
   * change made elsewhere in the chain between renders) is never clobbered by
   * a stale snapshot of the effect's other fields.
   */
  protected setBloomSetting(instanceId: string, patch: Partial<BloomSettings>): void {
    this.mutate((render) =>
      updatePostProcessingEffect<BloomEffect>(render, instanceId, (effect) => ({
        ...effect,
        settings: { ...effect.settings, ...patch },
      })),
    );
  }

  protected setVignetteSetting(instanceId: string, patch: Partial<VignetteSettings>): void {
    this.mutate((render) =>
      updatePostProcessingEffect<VignetteEffect>(render, instanceId, (effect) => ({
        ...effect,
        settings: { ...effect.settings, ...patch },
      })),
    );
  }

  protected setValue(instanceId: string, key: string, value: ParamValue): void {
    this.mutate((render) =>
      updatePostProcessingEffect<CustomEffect>(render, instanceId, (effect) => ({
        ...effect,
        values: { ...effect.values, [key]: value },
      })),
    );
  }

  // --- Drag reorder ---------------------------------------------------------
  // Mouse convenience only — the move-up/down buttons are the keyboard-operable
  // path required for accessibility. Dropping onto a row puts the dragged
  // effect where that row is: after it when moving down, before it when moving up.

  protected onDragStart(event: DragEvent, instanceId: string): void {
    this.dragging = instanceId;
    event.dataTransfer?.setData('text/plain', instanceId);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  protected onDragOver(event: DragEvent, instanceId: string): void {
    if (!this.dragging || this.dragging === instanceId) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  }

  protected onDrop(event: DragEvent, instanceId: string): void {
    event.preventDefault();
    const source = this.dragging;
    this.dragging = null;
    if (!source || source === instanceId) return;

    const ids = this.effects().map((effect) => effect.instanceId);
    const from = ids.indexOf(source);
    const to = ids.indexOf(instanceId);
    if (from < 0 || to < 0) return;
    const before = from < to ? (ids[to + 1] ?? null) : instanceId;
    this.mutate((render) => reorderPostProcessingEffect(render, source, before));
  }

  protected onDragEnd(): void {
    this.dragging = null;
  }

  private mutate(fn: (render: RenderSettings) => RenderSettings): void {
    const current = this.render();
    if (!current) return;
    this.store.setRender(fn(current));
  }
}
