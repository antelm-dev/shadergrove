import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';

import { createCustomEffect } from '@shadergrove/shared/model';
import { fail } from '@shadergrove/shared/validate';
import {
  PALETTE_FORMAT,
  sourceFingerprint,
  type GradientInterpolation,
  type GradientStop,
  type PaletteData,
} from '@shadergrove/shared/plugin';
import { I18n } from '../../i18n/i18n';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { RendererHandle } from '../../rendering/renderer-handle';
import { ShaderStore } from '../../workspace/shader-store';
import { EffectAdoption, adoptionMessage } from '../effect-adoption';
import { PluginTools, type ToolSession, type ToolSource } from '../plugin-tools';
import {
  ALPHA_THRESHOLD,
  DEFAULT_PALETTE,
  EXTRACT_COUNT,
  INTERPOLATIONS,
  PALETTE_ADJUSTMENTS,
  PALETTE_FILE_BYTES,
  addStop,
  applyPaletteEffect,
  effectRequest,
  evenStops,
  extractRequest,
  gradientCss,
  gradientSamples,
  moveStop,
  paletteJson,
  paletteKey,
  parsePaletteJson,
  removeStop,
  setStopColor,
  setStopPosition,
  visiblePixels,
  type PaletteAdjustment,
} from './palette';
import {
  ImageBridgeError,
  decodeImageFile,
  downloadBlob,
  drawImage,
  previewImage,
  safeFileName,
  type BridgeImage,
} from './textures-image-bridge';

interface Pick {
  /** Unique per pick: an extraction is tied to the pick it was made from. */
  id: number;
  name: string;
  width: number;
  height: number;
  /** The bounded sample (≤ 256×256, alpha-weighted) every extraction uses. */
  sample: BridgeImage;
}

type Notice = { text: string; error: boolean };

const INTERPOLATION_LABEL = {
  oklab: 'interpOklab',
  linear: 'interpLinear',
  srgb: 'interpSrgb',
} as const;
const ADJUSTMENT_LABEL = { contrast: 'adjustContrast', shift: 'adjustShift' } as const;

/**
 * The Palette Studio panel: extract a palette from an image (or start from a
 * manual one), edit its gradient, save and load it as palette JSON, preview
 * the luminance-mapping effect it makes and apply that effect to the open
 * shader.
 *
 * Two sessions of its own: extraction, tied to the pick and its settings, and
 * the effect, tied to the palette and the effect settings. Each runs coalesced
 * previews, so a newer change supersedes the request before it and an answer
 * for an older palette is never shown or applied. Switching the plugin off,
 * updating or removing it, or changing profile ends both (the sessions close
 * with the card). The JSON and the editor work without a shader; the effect
 * preview — compiled by the renderer, never added to the draft — and Apply
 * need an open shader whose preview is running.
 */
@Component({
  selector: 'app-palette-panel',
  imports: [FormsModule, MatButtonModule, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: grid;
      gap: 0.75rem;
    }
    fieldset {
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 8px;
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem 1rem;
      margin: 0;
      padding: 0.5rem 0.75rem;
    }
    legend {
      font-weight: 500;
    }
    label {
      align-items: center;
      display: inline-flex;
      gap: 0.35rem;
    }
    input[type='number'] {
      width: 5.5rem;
    }
    .row {
      align-items: center;
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      width: 100%;
    }
    .muted {
      color: var(--mat-sys-on-surface-variant);
      margin: 0;
    }
    .error {
      color: var(--mat-sys-error);
      margin: 0;
    }
    .swatch {
      align-items: center;
      display: inline-flex;
      flex-direction: column;
      font-size: 0.75rem;
      gap: 0.25rem;
    }
    .chip {
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 4px;
      height: 2rem;
      width: 2rem;
    }
    .strip {
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 4px;
      height: 1.5rem;
      width: 100%;
    }
    canvas {
      image-rendering: pixelated;
      max-height: 160px;
      max-width: 100%;
    }
    canvas.samples {
      height: 1.5rem;
      width: 100%;
    }
  `,
  template: `
    <fieldset>
      <legend>{{ k('image') | translate }}</legend>
      <div class="row">
        <button matButton="tonal" type="button" data-testid="palette-pick" (click)="picker.click()">
          {{ k('choose') | translate }}
        </button>
        <input
          #picker
          hidden
          type="file"
          accept="image/png,image/jpeg,image/webp"
          data-testid="palette-file"
          (change)="pick(picker)"
        />
        @if (picked(); as current) {
          <span data-testid="palette-image">
            {{
              k('imageInfo')
                | translate: { name: current.name, width: current.width, height: current.height }
            }}
          </span>
          <button matButton type="button" (click)="picked.set(null)">
            {{ k('remove') | translate }}
          </button>
        }
      </div>
      <canvas #thumb data-testid="palette-thumb" [hidden]="!picked()"></canvas>
      <label>
        {{ k('count') | translate }}
        <select
          data-testid="palette-count"
          [ngModel]="count()"
          (ngModelChange)="count.set(+$event)"
        >
          @for (n of counts; track n) {
            <option [value]="n">{{ n }}</option>
          }
        </select>
      </label>
      <label>
        {{ k('alphaThreshold') | translate }}
        <input
          type="number"
          [min]="alpha.min"
          [max]="alpha.max"
          data-testid="palette-alpha"
          [ngModel]="threshold()"
          (ngModelChange)="setThreshold($event)"
        />
      </label>
      <p
        role="status"
        data-testid="palette-status"
        [class.error]="extractProblem() !== null"
        [class.muted]="extractProblem() === null"
      >
        @if (extractProblem(); as problem) {
          {{ problem }}
        } @else if (sessions()?.extract?.running()) {
          {{ k('extracting') | translate }}
        }
      </p>
    </fieldset>

    <fieldset>
      <legend>{{ k('swatches') | translate }}</legend>
      <div class="row">
        @for (color of colors(); track $index) {
          <span
            class="swatch"
            [attr.data-testid]="'palette-swatch-' + $index"
            [attr.data-color]="color"
          >
            <span class="chip" [style.background]="color"></span>
            {{ color }}
            @if (weights()?.[$index]; as weight) {
              · {{ percent(weight) }}%
            }
          </span>
        }
      </div>
      <p class="muted">{{ k('unordered') | translate }}</p>
      <button
        matButton
        type="button"
        data-testid="palette-from-swatches"
        [disabled]="colors().length === 0"
        (click)="stops.set(evenStops(colors()))"
      >
        {{ k('fromSwatches') | translate }}
      </button>
    </fieldset>

    <fieldset>
      <legend>{{ k('gradient') | translate }}</legend>
      <label>
        {{ k('interpolation') | translate }}
        <select
          data-testid="palette-interpolation"
          [ngModel]="interpolation()"
          (ngModelChange)="interpolation.set($event)"
        >
          @for (option of interpolations; track option) {
            <option [value]="option">{{ k(interpolationLabel[option]) | translate }}</option>
          }
        </select>
      </label>
      <div class="strip" data-testid="palette-strip" [style.background]="stripCss()"></div>
      @for (stop of stops(); track $index; let i = $index, first = $first, last = $last) {
        <div class="row" [attr.data-testid]="'palette-stop-' + i">
          <strong>{{ k('stop') | translate: { n: i + 1 } }}</strong>
          <label>
            {{ k('color') | translate }}
            <input
              type="color"
              [attr.data-testid]="'palette-stop-color-' + i"
              [ngModel]="stop.color"
              (ngModelChange)="stops.set(setStopColor(stops(), i, $event))"
            />
          </label>
          <label>
            {{ k('position') | translate }}
            <input
              type="number"
              min="0"
              max="1"
              step="0.01"
              [attr.data-testid]="'palette-stop-position-' + i"
              [ngModel]="stop.position"
              (ngModelChange)="stops.set(setStopPosition(stops(), i, +$event))"
            />
          </label>
          <button
            matButton
            type="button"
            [attr.data-testid]="'palette-stop-up-' + i"
            [disabled]="first"
            (click)="stops.set(moveStop(stops(), i, -1))"
          >
            {{ k('moveUp') | translate }}
          </button>
          <button
            matButton
            type="button"
            [attr.data-testid]="'palette-stop-down-' + i"
            [disabled]="last"
            (click)="stops.set(moveStop(stops(), i, 1))"
          >
            {{ k('moveDown') | translate }}
          </button>
          <button
            matButton
            type="button"
            [attr.data-testid]="'palette-stop-remove-' + i"
            [disabled]="stops().length <= 2"
            (click)="stops.set(removeStop(stops(), i))"
          >
            {{ k('removeStop') | translate }}
          </button>
        </div>
      }
      <button
        matButton="tonal"
        type="button"
        data-testid="palette-add-stop"
        [disabled]="stops().length >= 8"
        (click)="stops.set(addStop(stops()))"
      >
        {{ k('addStop') | translate }}
      </button>
      <p class="muted">{{ k('stopsNote') | translate }}</p>
    </fieldset>

    <fieldset>
      <legend>{{ k('file') | translate }}</legend>
      <label>
        {{ k('name') | translate }}
        <input
          type="text"
          maxlength="64"
          data-testid="palette-name"
          [ngModel]="name()"
          (ngModelChange)="name.set($event)"
        />
      </label>
      <div class="row">
        <button matButton="tonal" type="button" data-testid="palette-export" (click)="exportJson()">
          {{ k('exportJson') | translate }}
        </button>
        <button matButton type="button" (click)="importer.click()">
          {{ k('importJson') | translate }}
        </button>
        <input
          #importer
          hidden
          type="file"
          accept="application/json,.json"
          data-testid="palette-import"
          (change)="importJson(importer)"
        />
      </div>
    </fieldset>

    <fieldset>
      <legend>{{ k('effect') | translate }}</legend>
      <label>
        {{ k('strength') | translate }}
        <input
          type="number"
          min="0"
          max="1"
          step="0.05"
          data-testid="palette-strength"
          [ngModel]="strength()"
          (ngModelChange)="setStrength($event)"
        />
      </label>
      @for (adjustment of adjustmentNames; track adjustment) {
        <label>
          <input
            type="checkbox"
            [attr.data-testid]="'palette-adjust-' + adjustment"
            [ngModel]="adjustments().includes(adjustment)"
            (ngModelChange)="toggleAdjustment(adjustment, $event)"
          />
          {{ k(adjustmentLabel[adjustment]) | translate }}
        </label>
      }
      @if (canPreview()) {
        <div class="row">
          <span class="muted">{{ k('samples') | translate }}</span>
          <canvas
            #samples
            class="samples"
            data-testid="palette-samples"
            [hidden]="!samplesShown()"
          ></canvas>
        </div>
        <p
          role="status"
          data-testid="palette-compile"
          [class.error]="effectProblem() !== null"
          [class.muted]="effectProblem() === null"
        >
          @if (effectProblem(); as problem) {
            {{ problem }}
          } @else if (sessions()?.effect?.running()) {
            {{ k('previewing') | translate }}
          } @else if (effectResult()) {
            {{ k('compiles') | translate }}
          }
        </p>
        <div class="row">
          <button
            matButton="filled"
            type="button"
            data-testid="palette-apply"
            [disabled]="!effectResult() || effectProblem() !== null"
            (click)="apply()"
          >
            {{ k('apply') | translate }}
          </button>
          @if (sessions()?.effect?.stale() && !sessions()?.effect?.running()) {
            <span class="muted" data-testid="palette-stale">{{ k('stale') | translate }}</span>
          }
        </div>
      } @else {
        <p class="muted" data-testid="palette-needs-shader">{{ k('needsShader') | translate }}</p>
      }
    </fieldset>

    @if (notice(); as current) {
      <p
        data-testid="palette-notice"
        [attr.role]="current.error ? 'alert' : 'status'"
        [class.error]="current.error"
      >
        {{ current.text }}
      </p>
    }
  `,
})
export class PalettePanel {
  readonly session = input.required<ToolSession>();

  private readonly store = inject(ShaderStore);
  private readonly renderer = inject(RendererHandle);
  private readonly adoption = inject(EffectAdoption);
  private readonly tools = inject(PluginTools);
  private readonly i18n = inject(I18n);

  protected readonly k = paletteKey;
  protected readonly counts = Array.from(
    { length: EXTRACT_COUNT.max - EXTRACT_COUNT.min + 1 },
    (_, index) => EXTRACT_COUNT.min + index,
  );
  protected readonly alpha = ALPHA_THRESHOLD;
  protected readonly interpolations = INTERPOLATIONS;
  protected readonly interpolationLabel = INTERPOLATION_LABEL;
  protected readonly adjustmentNames = PALETTE_ADJUSTMENTS;
  protected readonly adjustmentLabel = ADJUSTMENT_LABEL;
  protected readonly evenStops = evenStops;
  protected readonly setStopColor = setStopColor;
  protected readonly setStopPosition = setStopPosition;
  protected readonly moveStop = moveStop;
  protected readonly removeStop = removeStop;
  protected readonly addStop = addStop;

  protected readonly picked = signal<Pick | null>(null);
  protected readonly count = signal(6);
  protected readonly threshold = signal(128);
  protected readonly name = signal(DEFAULT_PALETTE.name);
  protected readonly colors = signal<readonly string[]>([]);
  /** Each swatch's share of the visible pixels, from the extraction; none for a manual palette. */
  protected readonly weights = signal<readonly number[] | null>(null);
  protected readonly interpolation = signal<GradientInterpolation>('oklab');
  protected readonly stops = signal<readonly GradientStop[]>(DEFAULT_PALETTE.gradient!.stops);
  protected readonly strength = signal(1);
  protected readonly adjustments = signal<readonly PaletteAdjustment[]>([]);
  protected readonly notice = signal<Notice | null>(null);
  private readonly pickProblem = signal<string | null>(null);
  private readonly probeProblem = signal<string | null>(null);
  private nextId = 1;

  /** The palette as the editor holds it: what is exported, and what an effect is made from. */
  protected readonly palette = computed<PaletteData>(() => ({
    format: PALETTE_FORMAT,
    name: this.name().trim() || DEFAULT_PALETTE.name,
    colors: [...this.colors()],
    gradient: { interpolation: this.interpolation(), stops: [...this.stops()] },
  }));
  protected readonly stripCss = computed(() => gradientCss(this.palette().gradient!));

  private readonly extractSource = computed<ToolSource>(() => ({
    shaderId: 'palette-studio',
    fingerprint: sourceFingerprint({
      pick: this.picked()?.id ?? 0,
      count: this.count(),
      threshold: this.threshold(),
    }),
  }));
  private readonly effectSource = computed<ToolSource>(() => ({
    shaderId: 'palette-studio',
    fingerprint: sourceFingerprint({
      palette: this.palette(),
      strength: this.strength(),
      adjustments: this.adjustments(),
    }),
  }));

  protected readonly sessions = signal<{ extract: ToolSession; effect: ToolSession } | null>(null);

  /** The effect preview and Apply need an open shader and a running renderer. */
  protected readonly canPreview = computed(
    () => this.store.draft() !== null && this.renderer.engine() !== null,
  );
  protected readonly effectResult = computed(() => {
    const value = this.sessions()?.effect.result()?.value;
    return value && 'kind' in value && value.kind === 'effect' ? value : null;
  });
  private readonly samples = computed(() => gradientSamples(this.effectResult() ?? undefined));
  protected readonly samplesShown = computed(() => this.samples() !== null);
  protected readonly extractProblem = computed(
    () => this.pickProblem() ?? this.sessions()?.extract.error() ?? null,
  );
  protected readonly effectProblem = computed(
    () => this.probeProblem() ?? this.sessions()?.effect.error() ?? null,
  );

  private readonly thumb = viewChild<ElementRef<HTMLCanvasElement>>('thumb');
  private readonly samplesCanvas = viewChild<ElementRef<HTMLCanvasElement>>('samples');

  constructor() {
    effect((onCleanup) => {
      const given = this.session();
      const opened = untracked(() => ({
        extract: this.tools.openSession(given.packageId, given.contributionId, {
          source: this.extractSource,
        }),
        effect: this.tools.openSession(given.packageId, given.contributionId, {
          source: this.effectSource,
        }),
      }));
      if (!opened.extract || !opened.effect) {
        opened.extract?.close();
        opened.effect?.close();
        this.sessions.set(null);
        return;
      }
      const { extract, effect: effectSession } = opened;
      this.sessions.set({ extract, effect: effectSession });
      onCleanup(() => {
        extract.close();
        effectSession.close();
      });
    });

    // Extraction follows the pick and its settings, coalesced.
    effect((onCleanup) => {
      const sessions = this.sessions();
      const pick = this.picked();
      const settings = { count: this.count(), alphaThreshold: this.threshold() };
      if (!sessions || !pick) return;
      const timer = setTimeout(() => void this.extract(sessions.extract, pick, settings), 120);
      onCleanup(() => clearTimeout(timer));
    });

    // The effect preview follows the palette and the effect settings, coalesced.
    effect((onCleanup) => {
      const sessions = this.sessions();
      const palette = this.palette();
      const settings = { strength: this.strength(), adjustments: this.adjustments() };
      if (!sessions || !this.canPreview()) return;
      const timer = setTimeout(
        () => void sessions.effect.runAsset(effectRequest(palette, settings)),
        120,
      );
      onCleanup(() => clearTimeout(timer));
    });

    // The renderer compiles the effect off screen; nothing is added to the draft.
    effect(() => {
      const result = this.effectResult();
      const engine = this.renderer.engine();
      if (!result || !engine) {
        this.probeProblem.set(null);
        return;
      }
      const { name, source, controls, values } = result.effect;
      const errors = engine
        .probeCustomEffect(
          createCustomEffect({
            instanceId: 'palette-preview',
            enabled: true,
            name,
            source,
            controls,
            values,
          }),
        )
        .filter((diagnostic) => diagnostic.severity === 'error');
      this.probeProblem.set(errors[0] ? errors[0].message : null);
    });

    effect(() => {
      const canvas = this.thumb()?.nativeElement;
      const pick = this.picked();
      if (canvas && pick) drawImage(canvas, pick.sample);
    });

    effect(() => {
      const canvas = this.samplesCanvas()?.nativeElement;
      const samples = this.samples();
      if (!canvas || !samples) return;
      const rgba = new Uint8Array(samples.length * 4);
      samples.forEach((hex, index) => {
        for (let channel = 0; channel < 3; channel++) {
          rgba[index * 4 + channel] = parseInt(hex.slice(1 + channel * 2, 3 + channel * 2), 16);
        }
        rgba[index * 4 + 3] = 255;
      });
      drawImage(canvas, {
        width: samples.length,
        height: 1,
        orientation: 'top-left',
        alpha: 'opaque',
        usage: 'color',
        rgba,
      });
    });
  }

  // --- Source -----------------------------------------------------------------------

  protected async pick(picker: HTMLInputElement): Promise<void> {
    const file = picker.files?.[0];
    picker.value = '';
    if (!file) return;
    try {
      const image = await decodeImageFile(file, 'color');
      this.picked.set({
        id: this.nextId++,
        name: image.name,
        width: image.width,
        height: image.height,
        sample: previewImage(image, 'linear'),
      });
      this.notice.set(null);
    } catch (error) {
      this.say(error instanceof ImageBridgeError ? error.message : String(error), true);
    }
  }

  protected setThreshold(value: unknown): void {
    const number = Math.round(Number(value));
    if (Number.isFinite(number)) {
      this.threshold.set(Math.min(ALPHA_THRESHOLD.max, Math.max(ALPHA_THRESHOLD.min, number)));
    }
  }

  private async extract(
    session: ToolSession,
    pick: Pick,
    settings: { count: number; alphaThreshold: number },
  ): Promise<void> {
    if (visiblePixels(pick.sample, settings.alphaThreshold) === 0) {
      this.pickProblem.set(this.i18n.t(paletteKey('noVisible')));
      return;
    }
    this.pickProblem.set(null);
    const outcome = await session.runAsset(extractRequest(pick.sample, settings));
    if (outcome.status !== 'ok' || outcome.value.kind !== 'palette') return;
    // An extraction replaces the editor's palette; the name stays the user's.
    const { colors, gradient } = outcome.value.palette;
    const weights = outcome.value.metadata['weights'];
    this.colors.set(colors);
    this.weights.set(
      Array.isArray(weights) && weights.length === colors.length && weights.every(Number.isFinite)
        ? (weights as number[])
        : null,
    );
    if (gradient) {
      this.interpolation.set(gradient.interpolation);
      this.stops.set(gradient.stops);
    }
  }

  // --- Editing ----------------------------------------------------------------------

  protected percent(weight: number): string {
    return (weight * 100).toFixed(1);
  }

  protected setStrength(value: unknown): void {
    const number = Number(value);
    if (Number.isFinite(number)) this.strength.set(Math.min(1, Math.max(0, number)));
  }

  protected toggleAdjustment(adjustment: PaletteAdjustment, on: boolean): void {
    this.adjustments.update((list) =>
      PALETTE_ADJUSTMENTS.filter((item) => (item === adjustment ? on : list.includes(item))),
    );
  }

  // --- Files ------------------------------------------------------------------------

  protected exportJson(): void {
    const text = paletteJson(this.palette());
    if (!text.ok) {
      this.say(text.errors[0] ?? 'Invalid palette', true);
      return;
    }
    // The palette's name is the user's text: the file name is made safe here.
    const file = `${safeFileName(this.palette().name, 'palette')}.json`;
    downloadBlob(new Blob([text.value], { type: 'application/json' }), file);
    this.say(this.i18n.t(paletteKey('exported'), { file }), false);
  }

  protected async importJson(picker: HTMLInputElement): Promise<void> {
    const file = picker.files?.[0];
    picker.value = '';
    if (!file) return;
    const parsed =
      file.size > PALETTE_FILE_BYTES
        ? fail<PaletteData>('The file is too large to be a palette.')
        : parsePaletteJson(await file.text());
    if (!parsed.ok) {
      this.say(parsed.errors[0] ?? 'Invalid palette', true);
      return;
    }
    const palette = parsed.value;
    this.name.set(palette.name);
    this.colors.set(palette.colors);
    this.weights.set(null);
    this.interpolation.set(palette.gradient!.interpolation);
    this.stops.set(palette.gradient!.stops);
    this.say(this.i18n.t(paletteKey('imported'), { name: palette.name }), false);
  }

  // --- Apply ------------------------------------------------------------------------

  protected async apply(): Promise<void> {
    const sessions = this.sessions();
    if (!sessions) return;
    const outcome = await applyPaletteEffect(sessions.effect, (candidate) =>
      this.adoption.adopt(candidate),
    );
    if (outcome.status === 'delivered') {
      const { key, params, error } = adoptionMessage(outcome.value.result, outcome.value.name);
      this.say(this.i18n.t(key, params), error);
    } else if (outcome.status === 'stale') {
      this.say(this.i18n.t(paletteKey('staleDelivery')), true);
    } else {
      this.say(outcome.message, true);
    }
  }

  private say(text: string, error: boolean): void {
    this.notice.set({ text, error });
  }
}
