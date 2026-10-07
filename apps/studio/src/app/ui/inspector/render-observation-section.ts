import {
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';

import type { ObservationCatalogue } from '@shadergrove/glsl-analysis';
import { MAX_OBSERVATION_VISITS } from '@shadergrove/glsl-analysis';
import { ObservationCatalogues } from '../../editor/observation-catalogue';
import { buildObservation, mapCatalogue, type MappedPoint } from '../../editor/observation-source';
import { I18n } from '../../i18n/i18n';
import type { TranslationKey } from '../../i18n/keys';
import { TranslatePipe } from '../../i18n/translate.pipe';
import {
  FrameCaptureError,
  type CapturedPass,
  type FrameSnapshot,
} from '../../rendering/render-inspection';
import type { ObservationResult } from '../../rendering/render-observation';
import { RendererHandle } from '../../rendering/renderer-handle';
import { classifyComponent, formatRaw, parseVisit, type Texel } from './render-inspection-model';

const SILENT: ReadonlySet<string> = new Set(['aborted', 'released', 'invalidated', 'disposed']);

const CLASS_KEYS = {
  nan: 'inspection.classNan',
  posInf: 'inspection.classPosInf',
  negInf: 'inspection.classNegInf',
  negative: 'inspection.classNegative',
  hdr: 'inspection.classHdr',
} as const satisfies Record<string, TranslationKey>;

/**
 * One frozen GPU variable measurement, inside the frame inspector.
 *
 * Variables are looked up only when asked for, in the *captured accepted*
 * source of the selected pass. A measurement draws a modified copy of that
 * program from the frozen inputs, so the result is always labelled as such, and
 * carries its fidelity verdict, its availability (never confused with zero) and
 * the exact source place. It owns one abort controller and one pending token; it
 * cancels when hidden, when the capture or pass changes, and when destroyed.
 */
@Component({
  selector: 'app-render-observation',
  imports: [MatButtonModule, TranslatePipe],
  template: `
    <section class="observation" [attr.aria-label]="'observation.title' | translate">
      <h3>{{ 'observation.title' | translate }}</h3>

      <div class="actions">
        @if (finding()) {
          <button matButton="outlined" type="button" class="cancel-find" (click)="cancel()">
            {{ 'observation.cancel' | translate }}
          </button>
        } @else {
          <button matButton="outlined" type="button" class="find" (click)="find()">
            {{ 'observation.find' | translate }}
          </button>
        }
      </div>
      <p class="status" role="status" aria-live="polite">{{ statusText() }}</p>

      @if (points().length > 0) {
        <div class="controls">
          <label>
            <span>{{ 'observation.point' | translate }}</span>
            <select class="point-select" (change)="selectPoint($event)">
              @for (item of points(); track item.point.id) {
                <option [value]="item.point.id" [selected]="item.point.id === pointId()">
                  {{
                    'observation.pointOption'
                      | translate
                        : {
                            name: item.point.name,
                            type: item.point.type,
                            precision: item.point.precision,
                            doc: item.location.docName,
                            line: item.location.line,
                            column: item.location.column,
                            function: item.point.function,
                          }
                  }}
                </option>
              }
            </select>
          </label>
          <label>
            <span>{{ 'observation.visit' | translate }}</span>
            <input
              class="visit"
              type="number"
              step="1"
              min="1"
              [attr.max]="maxVisits"
              [value]="visitText()"
              (input)="setVisit($event)"
            />
          </label>
          @if (measuring()) {
            <button matButton="outlined" type="button" class="cancel-measure" (click)="cancel()">
              {{ 'observation.cancel' | translate }}
            </button>
          } @else {
            <button matButton="filled" type="button" class="measure" (click)="measure()">
              {{ 'observation.measure' | translate }}
            </button>
          }
        </div>
        @if (visitInvalid()) {
          <p class="warning" role="alert">{{ 'observation.visitInvalid' | translate }}</p>
        }
        @if (!pixel()) {
          <p class="state">{{ 'observation.pixelNeeded' | translate }}</p>
        }
        <p class="legend">{{ 'observation.boundary' | translate }}</p>
      }

      @if (result(); as measured) {
        <div class="result" [class.distrusted]="!measured.trusted">
          <p class="label">
            <strong class="badge">{{ 'observation.label' | translate }}</strong>
            <strong class="badge" [class.warn]="!measured.trusted">{{
              (measured.trusted ? 'observation.trusted' : 'observation.distrusted') | translate
            }}</strong>
          </p>
          <p class="legend">{{ 'observation.labelNote' | translate }}</p>
          <dl class="facts">
            <div>
              <dt>{{ 'observation.availability' | translate }}</dt>
              <dd class="availability">{{ availabilityText() }}</dd>
            </div>
            @if (measured.components; as components) {
              <div>
                <dt>{{ 'observation.value' | translate }}</dt>
                <dd>
                  @for (item of components; track $index) {
                    <code class="raw-value">{{ format(item) }}</code>
                    @if (flagKey(item); as flag) {
                      <span class="flag">{{ flag | translate }}</span>
                    }
                    {{ ' ' }}
                  }
                </dd>
              </div>
            }
            <div>
              <dt>{{ 'observation.type' | translate }}</dt>
              <dd>
                <code>{{ measured.type }}</code> (visit {{ measured.visit }}, pixel
                {{ measured.pixel.x }}, {{ measured.pixel.y }})
              </dd>
            </div>
            <div>
              <dt>{{ 'observation.declaredPrecision' | translate }}</dt>
              <dd>
                <code>{{ measured.declaredPrecision }}</code>
              </dd>
            </div>
            <div>
              <dt>{{ 'observation.effectivePrecision' | translate }}</dt>
              <dd>
                {{
                  'observation.precisionValue'
                    | translate
                      : {
                          bits: measured.effectivePrecision.bits,
                          min: measured.effectivePrecision.rangeMin,
                          max: measured.effectivePrecision.rangeMax,
                        }
                }}
              </dd>
            </div>
            @if (source(); as place) {
              <div>
                <dt>{{ 'observation.location' | translate }}</dt>
                <dd>
                  <code class="source-identity">{{
                    'observation.sourceValue'
                      | translate: { doc: place.docName, line: place.line, column: place.column }
                  }}</code>
                  · <code>{{ place.fingerprint }}</code> · r{{ place.revision ?? '—' }}
                </dd>
              </div>
            }
          </dl>
          <p class="fidelity" [class.warning]="!measured.trusted" role="status">
            {{ fidelityText() }}
          </p>
          @if (measured.fidelity.skippedNonFinite > 0) {
            <p class="legend">
              {{ 'observation.skipped' | translate: { count: measured.fidelity.skippedNonFinite } }}
            </p>
          }
          <p class="legend">{{ 'observation.fidelityNote' | translate }}</p>
        </div>
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
    }
    .controls,
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 12px;
      align-items: end;
      margin-block: 6px;
    }
    label {
      display: grid;
      gap: 2px;
      font: var(--mat-sys-label-small);
    }
    select,
    input {
      font: inherit;
      color: inherit;
      background: var(--mat-sys-surface-container);
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 4px;
      padding: 2px 6px;
    }
    input[type='number'] {
      width: 88px;
    }
    h3 {
      margin: 8px 0 4px;
      font: var(--mat-sys-title-small);
    }
    .state,
    .legend {
      color: var(--mat-sys-on-surface-variant);
    }
    .status:empty {
      display: none;
    }
    .warning {
      color: var(--mat-sys-error);
    }
    .badge {
      padding: 1px 6px;
      border-radius: 4px;
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
    }
    .badge.warn {
      background: var(--mat-sys-error-container);
      color: var(--mat-sys-on-error-container);
    }
    .result.distrusted {
      border-left: 3px solid var(--mat-sys-error);
      padding-left: 8px;
    }
    dl {
      display: grid;
      gap: 2px;
      margin: 0;
    }
    dl > div {
      display: flex;
      gap: 8px;
    }
    dt {
      flex: 0 0 140px;
      color: var(--mat-sys-on-surface-variant);
    }
    dd {
      margin: 0;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .flag {
      margin-left: 6px;
      padding: 0 5px;
      border-radius: 4px;
      background: var(--mat-sys-tertiary-container);
      color: var(--mat-sys-on-tertiary-container);
    }
  `,
})
export class RenderObservationSection {
  readonly frame = input.required<FrameSnapshot>();
  readonly pass = input.required<CapturedPass>();
  /** A texel of this pass's own image (bottom-left origin), or null when none applies. */
  readonly pixel = input<Texel | null>(null);
  /** Whether the user can see the inspector; when it stops being visible, everything cancels. */
  readonly active = input(true);

  protected readonly maxVisits = MAX_OBSERVATION_VISITS;

  private readonly handle = inject(RendererHandle);
  private readonly catalogues = inject(ObservationCatalogues);
  private readonly i18n = inject(I18n);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly finding = signal(false);
  protected readonly measuring = signal(false);
  protected readonly points = signal<readonly MappedPoint[]>([]);
  protected readonly pointId = signal<string | null>(null);
  protected readonly visitText = signal('1');
  protected readonly visitInvalid = signal(false);
  protected readonly result = signal<ObservationResult | null>(null);
  private readonly note = signal<string>('');

  private catalogue: ObservationCatalogue | null = null;
  private refused = 0;
  /** Every request takes a token; an answer for any token but the newest is dropped. */
  private seq = 0;
  private abort: AbortController | null = null;

  protected readonly statusText = computed(() => this.note());

  /** Where the measured point sits, from the accepted program the result was measured on. */
  protected readonly source = computed(() => {
    const measured = this.result();
    const chosen = this.points().find((item) => item.point.id === this.pointId());
    const pass = this.pass();
    if (!measured || !chosen) return null;
    return {
      ...chosen.location,
      fingerprint: pass.accepted.fingerprint,
      revision: pass.accepted.revision,
    };
  });

  protected readonly availabilityText = computed(() => {
    const measured = this.result();
    if (!measured) return '';
    const key: TranslationKey =
      measured.availability === 'available'
        ? 'observation.available'
        : measured.availability === 'unvisited'
          ? 'observation.unvisited'
          : 'observation.discarded';
    return this.i18n.t(key);
  });

  protected readonly fidelityText = computed(() => {
    const fidelity = this.result()?.fidelity;
    if (!fidelity) return '';
    if (fidelity.status === 'match') {
      return this.i18n.t('observation.fidelityMatch', { delta: fidelity.maxDelta });
    }
    if (fidelity.status === 'mismatch') {
      return this.i18n.t('observation.fidelityMismatch', {
        count: fidelity.mismatchedTexels,
        delta: fidelity.maxDelta,
      });
    }
    return this.i18n.t('observation.fidelityUnverified', { reason: fidelity.reason ?? '' });
  });

  constructor() {
    this.destroyRef.onDestroy(() => this.cancel());

    // A different capture or pass owns a different source: nothing carries over.
    effect(() => {
      this.frame();
      this.pass();
      untracked(() => this.reset());
    });

    // A mounted but hidden panel must cancel explicitly: nothing runs for a view no one sees.
    effect(() => {
      if (!this.active()) untracked(() => this.cancel());
    });

    // The result describes a pixel, not just a point: moving it makes the result stale.
    effect(() => {
      this.pixel();
      untracked(() => {
        if (!this.measuring()) this.result.set(null);
      });
    });
  }

  protected format(value: number): string {
    return formatRaw(value);
  }

  protected flagKey(value: number): TranslationKey | null {
    const flag = classifyComponent(value, 'rgba32f');
    return flag === 'normal' ? null : CLASS_KEYS[flag];
  }

  protected selectPoint(event: Event): void {
    this.pointId.set((event.target as HTMLSelectElement).value);
    this.result.set(null);
  }

  protected setVisit(event: Event): void {
    const text = (event.target as HTMLInputElement).value;
    this.visitText.set(text);
    this.visitInvalid.set(parseVisit(text, MAX_OBSERVATION_VISITS) === null);
    this.result.set(null);
  }

  /** Cancels whatever is pending (the catalogue lookup or the measurement). Idempotent. */
  protected cancel(): void {
    this.seq++;
    this.abort?.abort();
    this.abort = null;
    this.finding.set(false);
    this.measuring.set(false);
  }

  private reset(): void {
    this.cancel();
    this.points.set([]);
    this.pointId.set(null);
    this.result.set(null);
    this.note.set('');
    this.catalogue = null;
    this.refused = 0;
  }

  protected async find(): Promise<void> {
    if (!this.active() || this.finding() || this.measuring()) return;
    const frame = this.frame();
    const pass = this.pass();
    this.cancel();
    const seq = ++this.seq;
    const controller = new AbortController();
    this.abort = controller;
    this.points.set([]);
    this.result.set(null);
    this.finding.set(true);
    this.note.set(this.i18n.t('observation.finding'));
    try {
      const found = await this.catalogues.find(
        frame.identity.projectId ?? '',
        pass.id,
        pass.accepted,
        controller.signal,
      );
      if (seq !== this.seq || frame.released) return;
      if (!found.ok) {
        const key: Record<string, TranslationKey> = {
          unavailable: 'observation.catalogueUnavailable',
          source: 'observation.catalogueSource',
          invalid: 'observation.catalogueInvalid',
        };
        this.note.set(found.reason === 'cancelled' ? '' : this.i18n.t(key[found.reason]));
        return;
      }
      const { mapped, refused } = mapCatalogue(pass.accepted, found.catalogue);
      this.catalogue = found.catalogue;
      this.refused = refused.length + found.catalogue.refusals.length;
      this.points.set(mapped);
      this.pointId.set(mapped[0]?.point.id ?? null);
      this.note.set(
        mapped.length === 0
          ? this.i18n.t('observation.none')
          : this.refused > 0
            ? this.i18n.t('observation.refused', { count: this.refused })
            : '',
      );
    } finally {
      if (seq === this.seq) {
        this.finding.set(false);
        this.abort = null;
      }
    }
  }

  protected async measure(): Promise<void> {
    if (!this.active() || this.measuring() || this.finding()) return;
    const frame = this.frame();
    const pass = this.pass();
    const chosen = this.points().find((item) => item.point.id === this.pointId());
    const catalogue = this.catalogue;
    const pixel = this.pixel();
    const visit = parseVisit(this.visitText(), MAX_OBSERVATION_VISITS);
    if (!chosen || !catalogue) return;
    if (visit === null) {
      this.visitInvalid.set(true);
      return;
    }
    if (!pixel) {
      this.note.set(this.i18n.t('observation.pixelNeeded'));
      return;
    }
    const build = buildObservation(pass.accepted, catalogue, chosen.point);
    if (!build.ok) {
      this.note.set(this.i18n.t('observation.error', { detail: build.message }));
      return;
    }

    const seq = ++this.seq;
    const controller = new AbortController();
    this.abort = controller;
    this.result.set(null);
    this.measuring.set(true);
    this.note.set(this.i18n.t('observation.measuring'));
    try {
      const result = await this.handle.observePoint(
        {
          passIndex: pass.index,
          pixel: { x: pixel.x, y: pixel.y },
          visit,
          type: chosen.point.type,
          precision: chosen.point.precision,
          visitTarget: build.visitTarget,
          prefix: build.prefix,
          programs: build.programs,
        },
        { signal: controller.signal },
      );
      // Never publish for a newer request, a released capture or another pass.
      if (seq !== this.seq || frame.released || this.frame() !== frame) return;
      this.result.set(result);
      this.note.set('');
    } catch (error) {
      if (seq !== this.seq) return;
      this.result.set(null);
      if (error instanceof FrameCaptureError) {
        this.note.set(
          SILENT.has(error.code) ? '' : this.i18n.t('observation.error', { detail: error.message }),
        );
      } else {
        this.note.set(this.i18n.t('observation.error', { detail: String(error) }));
      }
    } finally {
      if (seq === this.seq) {
        this.measuring.set(false);
        this.abort = null;
      }
    }
  }
}
