import { isPlatformBrowser } from '@angular/common';
import {
  Component,
  DestroyRef,
  ElementRef,
  PLATFORM_ID,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';

import type { ChannelBinding } from '@shadergrove/shared';
import { I18n, type TranslationParams } from '../../i18n/i18n';
import type { TranslationKey } from '../../i18n/keys';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { Preferences } from '../../prefs/preferences';
import {
  FrameCaptureError,
  type CaptureErrorCode,
  type CapturedInput,
  type CapturedPass,
  type FrameSnapshot,
  type InvalidationReason,
  type TexelFormat,
} from '../../rendering/render-inspection';
import { RendererHandle } from '../../rendering/renderer-handle';
import {
  DEFAULT_VISUAL,
  classifyComponent,
  clampExposure,
  formatRaw,
  formatUniform,
  fragCoord,
  parseCoordinate,
  pickTexel,
  stepTexel,
  stepZoom,
  visualizeBand,
  visualizeTexel,
  type ComponentClass,
  type Texel,
  type VisualChannel,
  type VisualOptions,
  type VisualTransform,
} from './render-inspection-model';
import { formatMilliseconds } from './profiler-recommendation';
import { RenderObservationSection } from './render-observation-section';

/** Browsers refuse canvases past this on a side; the image is then read by coordinates only. */
const MAX_CANVAS_SIDE = 16_384;
/** Texels read from the capture per step while drawing, so no full-size float copy ever exists. */
const BAND_TEXELS = 262_144;

const SILENT_ERRORS: ReadonlySet<CaptureErrorCode> = new Set([
  'aborted',
  'released',
  'invalidated',
  'disposed',
]);

const ERROR_KEYS: Partial<Record<CaptureErrorCode, TranslationKey>> = {
  timeout: 'inspection.errorTimeout',
  busy: 'inspection.errorBusy',
  retained: 'inspection.errorRetained',
  offline: 'inspection.errorOffline',
  context: 'inspection.errorContext',
  budget: 'inspection.errorBudget',
  unsupported: 'inspection.errorUnsupported',
  readback: 'inspection.errorReadback',
  precision: 'inspection.errorPrecision',
  'replay-mismatch': 'inspection.errorReplayMismatch',
  'no-renderer': 'inspection.errorNoRenderer',
};

const ENDED_KEYS: Record<InvalidationReason, TranslationKey> = {
  resize: 'inspection.endedResize',
  'context-lost': 'inspection.endedContextLost',
  project: 'inspection.endedProject',
  export: 'inspection.endedExport',
  disposed: 'inspection.endedDisposed',
  'active-context': 'inspection.endedActiveContext',
};

const FORMAT_KEYS: Record<TexelFormat, TranslationKey> = {
  rgba8: 'inspection.formatRgba8',
  rgba16f: 'inspection.formatRgba16f',
  rgba32f: 'inspection.formatRgba32f',
};

const CLASS_KEYS: Record<Exclude<ComponentClass, 'normal'>, TranslationKey> = {
  nan: 'inspection.classNan',
  posInf: 'inspection.classPosInf',
  negInf: 'inspection.classNegInf',
  negative: 'inspection.classNegative',
  hdr: 'inspection.classHdr',
};

const CHANNEL_KEYS: Record<VisualChannel, TranslationKey> = {
  rgb: 'inspection.channelRgb',
  r: 'inspection.channelR',
  g: 'inspection.channelG',
  b: 'inspection.channelB',
  a: 'inspection.channelA',
};

const TRANSFORM_KEYS: Record<VisualTransform, TranslationKey> = {
  linear: 'inspection.transformLinear',
  srgb: 'inspection.transformSrgb',
};

const STATE_KEYS: Record<CapturedInput['state'], TranslationKey> = {
  captured: 'inspection.stateCaptured',
  unbound: 'inspection.stateUnbound',
  'empty-slot': 'inspection.stateEmptySlot',
  loading: 'inspection.stateLoading',
  failed: 'inspection.stateFailed',
  'missing-buffer': 'inspection.stateMissingBuffer',
};

const SAMPLED_KEYS: Record<CapturedInput['effective'], TranslationKey> = {
  texels: 'inspection.sampledTexels',
  'placeholder-transparent': 'inspection.sampledPlaceholder',
  'renderer-empty-texture': 'inspection.sampledRendererEmpty',
};

interface ViewOption {
  readonly key: string;
  readonly imageId: string;
  readonly label: TranslationKey;
  readonly params: TranslationParams;
}

interface Readout {
  readonly format: TexelFormat;
  readonly components: readonly { name: string; text: string; flag: TranslationKey | null }[];
  readonly color: string;
  readonly display: string | null;
}

/**
 * The frame inspector: Capture, then read any pass of that one frame.
 *
 * It owns nothing the renderer does not already have. Capture and release go through
 * `RendererHandle`, which owns the retained snapshot; this panel only holds a request
 * token, an abort controller and the one canvas it draws the selected image into.
 * Nothing is read back from the GPU until the button is pressed, and the capture is
 * given up the moment the panel stops being visible, the active preview changes, or
 * the renderer ends it.
 *
 * Raw values and visualization are kept apart on purpose: the readout under
 * "Raw RGBA" is exactly what was stored; the picture and its swatch are a labelled
 * transform of it. Picking works from the rendered rectangle of the canvas, so CSS
 * size, zoom, device pixel ratio and render scale never enter the arithmetic.
 */
@Component({
  selector: 'app-render-inspection-panel',
  imports: [MatButtonModule, RenderObservationSection, TranslatePipe],
  template: `
    <section class="inspection">
      <div class="toolbar">
        @if (!engine()) {
          <p class="state">{{ 'inspection.unavailable' | translate }}</p>
        } @else if (snapshot()) {
          <button matButton="outlined" type="button" class="release" (click)="release()">
            {{ 'inspection.release' | translate }}
          </button>
        } @else if (pending()) {
          <button matButton="outlined" type="button" class="cancel" (click)="cancel()">
            {{ 'inspection.cancel' | translate }}
          </button>
        } @else {
          <button matButton="filled" type="button" class="capture" (click)="capture()">
            {{ 'inspection.capture' | translate }}
          </button>
          <span class="hint">{{ 'inspection.hint' | translate }}</span>
        }
      </div>

      <p class="status" role="status" aria-live="polite">{{ statusText() }}</p>
      @if (errorDetail(); as detail) {
        <p class="detail">{{ 'inspection.errorDetail' | translate: { detail } }}</p>
      }

      @if (snapshot(); as frame) {
        <p class="frozen">
          <strong class="badge">{{
            'inspection.frozen'
              | translate: { frame: frame.frame.index, time: frame.frame.time.toFixed(3) }
          }}</strong>
          {{ 'inspection.frozenNote' | translate }}
        </p>
        @if (frame.mixedRevisions) {
          <p class="warning">
            {{
              'inspection.mixedRevisions'
                | translate: { revision: frame.identity.requestedRevision ?? '—' }
            }}
          </p>
        }

        <div class="layout">
          <div class="column">
            <div class="controls">
              <label>
                <span>{{ 'inspection.pass' | translate }}</span>
                <select class="pass-select" [value]="passIndex()" (change)="selectPass($event)">
                  @for (item of frame.passes; track item.index) {
                    <option [value]="item.index" [selected]="item.index === passIndex()">
                      {{
                        'inspection.passOption'
                          | translate
                            : { index: item.index + 1, name: passName(item), kind: kindLabel(item) }
                      }}
                    </option>
                  }
                </select>
              </label>

              <label>
                <span>{{ 'inspection.view' | translate }}</span>
                <select
                  class="view-select"
                  [value]="view()?.key ?? ''"
                  (change)="selectView($event)"
                >
                  @for (option of views(); track option.key) {
                    <option [value]="option.key" [selected]="option.key === view()?.key">
                      {{ option.label | translate: option.params }}
                    </option>
                  }
                </select>
              </label>

              <label>
                <span>{{ 'inspection.channel' | translate }}</span>
                <select class="channel-select" (change)="setChannel($event)">
                  @for (channel of channels; track channel) {
                    <option [value]="channel" [selected]="channel === visual().channel">
                      {{ channelKey(channel) | translate }}
                    </option>
                  }
                </select>
              </label>

              <label>
                <span>{{ 'inspection.transform' | translate }}</span>
                <select class="transform-select" (change)="setTransform($event)">
                  @for (transform of transforms; track transform) {
                    <option [value]="transform" [selected]="transform === visual().transform">
                      {{ transformKey(transform) | translate }}
                    </option>
                  }
                </select>
              </label>

              <label>
                <span>{{ 'inspection.exposure' | translate }}</span>
                <input
                  class="exposure"
                  type="number"
                  step="0.5"
                  min="-16"
                  max="16"
                  [value]="visual().exposure"
                  (change)="setExposure($event)"
                />
              </label>
            </div>

            @if (view(); as current) {
              <p class="viz-label">
                {{
                  'inspection.vizLabel'
                    | translate
                      : {
                          channel: (channelKey(visual().channel) | translate),
                          transform: (transformKey(visual().transform) | translate),
                          exposure: visual().exposure,
                        }
                }}
              </p>
              <p class="legend">{{ 'inspection.vizLegend' | translate }}</p>

              <div class="zoom-bar">
                <span>{{ 'inspection.zoom' | translate }}</span>
                <button
                  type="button"
                  class="zoom-out"
                  [attr.aria-label]="'inspection.zoomOut' | translate"
                  (click)="zoomBy(-1)"
                >
                  −
                </button>
                <output class="zoom-value">{{ zoomText() }}</output>
                <button
                  type="button"
                  class="zoom-in"
                  [attr.aria-label]="'inspection.zoomIn' | translate"
                  (click)="zoomBy(1)"
                >
                  +
                </button>
                <button type="button" class="zoom-fit" (click)="zoom.set(null)">
                  {{ 'inspection.zoomFit' | translate }}
                </button>
              </div>

              @if (drawable()) {
                <div
                  class="viewer"
                  tabindex="0"
                  role="group"
                  [attr.aria-label]="'inspection.viewerLabel' | translate"
                  (keydown)="onViewerKeydown($event)"
                >
                  <div
                    class="stage"
                    [style.width]="stageWidth()"
                    [style.aspect-ratio]="imageSize().width + ' / ' + imageSize().height"
                  >
                    <canvas
                      #image
                      class="image"
                      [attr.data-image-id]="current.imageId"
                      (pointerdown)="onPointer($event)"
                      (pointermove)="onPointer($event)"
                    ></canvas>
                    @if (picked(); as texel) {
                      <span
                        class="marker"
                        [style.left.%]="(texel.x / imageSize().width) * 100"
                        [style.bottom.%]="(texel.y / imageSize().height) * 100"
                        [style.width.%]="100 / imageSize().width"
                        [style.height.%]="100 / imageSize().height"
                      ></span>
                    }
                  </div>
                </div>
              } @else {
                <p class="state">{{ 'inspection.vizTooLarge' | translate }}</p>
              }

              <div class="pixel-inputs">
                <label>
                  <span>{{ 'inspection.pixelX' | translate }}</span>
                  <input
                    class="pixel-x"
                    type="number"
                    step="1"
                    min="0"
                    [attr.max]="imageSize().width - 1"
                    [value]="picked()?.x ?? ''"
                    (change)="setCoordinate('x', $event)"
                  />
                </label>
                <label>
                  <span>{{ 'inspection.pixelY' | translate }}</span>
                  <input
                    class="pixel-y"
                    type="number"
                    step="1"
                    min="0"
                    [attr.max]="imageSize().height - 1"
                    [value]="picked()?.y ?? ''"
                    (change)="setCoordinate('y', $event)"
                  />
                </label>
              </div>
              @if (coordinateInvalid()) {
                <p class="warning" role="alert">
                  {{
                    'inspection.pixelInvalid'
                      | translate: { width: imageSize().width, height: imageSize().height }
                  }}
                </p>
              }
            }
          </div>

          <div class="column">
            <section class="section readout">
              <h3>{{ 'inspection.pixel' | translate }}</h3>
              @if (picked(); as texel) {
                <p class="position">
                  {{
                    'inspection.pixelPosition'
                      | translate
                        : {
                            x: texel.x,
                            y: texel.y,
                            width: imageSize().width,
                            height: imageSize().height,
                            fx: fragCoordOf(texel)[0],
                            fy: fragCoordOf(texel)[1],
                          }
                  }}
                </p>
              } @else {
                <p class="state">{{ 'inspection.pixelNone' | translate }}</p>
              }
              @if (rawUnavailable(); as reason) {
                <p class="warning">{{ 'inspection.rawUnavailable' | translate }} {{ reason }}</p>
              }
              @if (readout(); as value) {
                <h4>
                  {{
                    'inspection.raw' | translate: { format: (formatKey(value.format) | translate) }
                  }}
                </h4>
                <dl class="raw">
                  @for (item of value.components; track item.name) {
                    <div>
                      <dt>{{ item.name }}</dt>
                      <dd>
                        <code class="raw-value">{{ item.text }}</code>
                        @if (item.flag; as flag) {
                          <span class="flag">{{ flag | translate }}</span>
                        }
                      </dd>
                    </div>
                  }
                </dl>
                <h4>{{ 'inspection.vizPixel' | translate }}</h4>
                <p class="swatch-line">
                  <span class="swatch" [style.background]="value.color"></span>
                  <code class="viz-value">{{ value.color }}</code>
                </p>
                @if (value.display; as display) {
                  <h4>{{ 'inspection.displayPixel' | translate }}</h4>
                  <p>
                    <code class="display-value">{{ display }}</code>
                  </p>
                }
              }
              @if (comparison(); as check) {
                <p class="comparison">
                  {{
                    'inspection.comparison'
                      | translate
                        : {
                            delta: check.maxDelta,
                            reference: (check.referenceKey | translate),
                          }
                  }}
                  @if (check.skipped > 0) {
                    <strong class="skipped">{{
                      'inspection.skipped' | translate: { count: check.skipped }
                    }}</strong>
                  } @else {
                    {{ 'inspection.allVerified' | translate }}
                  }
                </p>
              }
            </section>

            @if (selected(); as pass) {
              <app-render-observation
                class="section"
                [frame]="frame"
                [pass]="pass"
                [pixel]="observationPixel()"
                [active]="active()"
              />
              <section class="section identity">
                <h3>{{ 'inspection.identity' | translate }}</h3>
                <dl class="facts">
                  <div>
                    <dt>{{ 'inspection.context' | translate }}</dt>
                    <dd>
                      {{
                        'inspection.generationValue'
                          | translate
                            : {
                                id: frame.identity.contextId,
                                generation: frame.identity.contextGeneration,
                              }
                      }}
                    </dd>
                  </div>
                  <div>
                    <dt>{{ 'inspection.project' | translate }}</dt>
                    <dd>
                      {{
                        'inspection.generationValue'
                          | translate
                            : {
                                id: frame.identity.projectId ?? ('inspection.none' | translate),
                                generation: frame.identity.projectGeneration,
                              }
                      }}
                    </dd>
                  </div>
                  <div>
                    <dt>{{ 'inspection.fingerprint' | translate }}</dt>
                    <dd>
                      <code>{{ pass.accepted.fingerprint }}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>{{ 'inspection.revision' | translate }}</dt>
                    <dd>
                      {{ pass.accepted.revision ?? '—' }}
                      @if (pass.accepted.stale) {
                        <span class="flag">{{ 'inspection.revisionStale' | translate }}</span>
                      }
                    </dd>
                  </div>
                  <div>
                    <dt>{{ 'inspection.frame' | translate }}</dt>
                    <dd>{{ frame.frame.index }}</dd>
                  </div>
                  <div>
                    <dt>{{ 'inspection.time' | translate }}</dt>
                    <dd>{{ frame.frame.time }} s</dd>
                  </div>
                  <div>
                    <dt>{{ 'inspection.pointer' | translate }}</dt>
                    <dd>{{ frame.frame.pointer.join(', ') }}</dd>
                  </div>
                  <div>
                    <dt>{{ 'inspection.drawingBuffer' | translate }}</dt>
                    <dd>
                      {{ frame.frame.drawingBuffer.width }}×{{ frame.frame.drawingBuffer.height }}
                    </dd>
                  </div>
                  <div>
                    <dt>{{ 'inspection.passTarget' | translate }}</dt>
                    <dd>{{ pass.resolution.width }}×{{ pass.resolution.height }}</dd>
                  </div>
                  <div>
                    <dt>{{ 'inspection.renderScale' | translate }}</dt>
                    <dd>{{ frame.frame.resolutionScale }}</dd>
                  </div>
                  <div>
                    <dt>{{ 'inspection.dpr' | translate }}</dt>
                    <dd>{{ dpr() }}</dd>
                  </div>
                  <div>
                    <dt>{{ 'inspection.postProcessing' | translate }}</dt>
                    <dd>
                      {{
                        (frame.frame.usesPostProcessing ? 'inspection.yes' : 'inspection.no')
                          | translate
                      }}
                    </dd>
                  </div>
                </dl>
                <details>
                  <summary>{{ 'inspection.source' | translate }}</summary>
                  <h4>{{ 'inspection.sourceFragment' | translate }}</h4>
                  <pre class="source">{{ pass.accepted.fragment }}</pre>
                  <h4>{{ 'inspection.sourceVertex' | translate }}</h4>
                  <pre class="source">{{ pass.accepted.vertex }}</pre>
                </details>
              </section>

              <section class="section">
                <h3>{{ 'inspection.uniforms' | translate }}</h3>
                @if (uniforms().length === 0) {
                  <p class="state">{{ 'inspection.noUniforms' | translate }}</p>
                } @else {
                  <dl class="uniforms">
                    @for (uniform of uniforms(); track uniform.name) {
                      <div>
                        <dt>
                          <code>{{ uniform.name }}</code>
                        </dt>
                        <dd>
                          <code>{{ uniform.text }}</code>
                        </dd>
                      </div>
                    }
                  </dl>
                }
              </section>

              <section class="section">
                <h3>{{ 'inspection.inputs' | translate }}</h3>
                <table class="inputs">
                  <thead>
                    <tr>
                      <th scope="col">{{ 'inspection.channel' | translate }}</th>
                      <th scope="col">{{ 'inspection.inputBinding' | translate }}</th>
                      <th scope="col">{{ 'inspection.inputState' | translate }}</th>
                      <th scope="col">{{ 'inspection.inputSampled' | translate }}</th>
                      <th scope="col">{{ 'inspection.inputImage' | translate }}</th>
                      <th scope="col">{{ 'inspection.inputSampling' | translate }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (input of pass.inputs; track input.channel) {
                      <tr>
                        <th scope="row">iChannel{{ input.channel }}</th>
                        <td>
                          {{ bindingKey(input) | translate: bindingParams(input.binding) }}
                        </td>
                        <td>
                          {{ stateKey(input) | translate }}
                          @if (input.reason; as reason) {
                            <small class="reason">{{ reason }}</small>
                          }
                        </td>
                        <td>{{ sampledKey(input) | translate }}</td>
                        <td>
                          @if (input.imageId; as id) {
                            {{ imageLabel(frame, id) }}
                            <button
                              type="button"
                              class="view-input"
                              (click)="viewInput(input.channel)"
                            >
                              {{ 'inspection.viewInputButton' | translate }}
                            </button>
                          } @else {
                            —
                          }
                        </td>
                        <td>{{ samplingText(input) }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </section>

              <p class="profiler-note">
                {{ 'inspection.profilerNote' | translate }}
                @if (liveGpu(); as live) {
                  <strong class="live">{{
                    'inspection.profilerLive' | translate: { value: live }
                  }}</strong>
                }
              </p>
            }
          </div>
        </div>
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
      height: 100%;
      overflow: auto;
      padding: 10px 12px;
      box-sizing: border-box;
      font: var(--mat-sys-body-small);
      color: var(--mat-sys-on-surface);
    }

    .toolbar {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }

    .hint,
    .state,
    .legend,
    .reason {
      color: var(--mat-sys-on-surface-variant);
    }

    .reason {
      display: block;
    }

    .status:empty {
      display: none;
    }

    .badge {
      padding: 1px 6px;
      border-radius: 4px;
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
    }

    .warning,
    .skipped {
      color: var(--mat-sys-error);
    }

    .layout {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      align-items: flex-start;
    }

    .column {
      flex: 1 1 340px;
      min-width: 0;
    }

    .controls,
    .pixel-inputs,
    .zoom-bar {
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
    input,
    button:not([matButton]) {
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

    .viewer {
      overflow: auto;
      max-height: 55vh;
      border: 1px solid var(--mat-sys-outline-variant);
      background: repeating-conic-gradient(#8884 0 25%, transparent 0 50%) 0 0 / 12px 12px;
    }

    .viewer:focus-visible {
      outline: 2px solid var(--mat-sys-primary);
    }

    .stage {
      position: relative;
      min-width: 1px;
    }

    .image {
      display: block;
      width: 100%;
      height: 100%;
      image-rendering: pixelated;
      cursor: crosshair;
      touch-action: none;
    }

    .marker {
      position: absolute;
      min-width: 3px;
      min-height: 3px;
      box-sizing: border-box;
      border: 1px solid #fff;
      outline: 1px solid #000;
      pointer-events: none;
    }

    .section {
      margin-bottom: 12px;
    }

    h3,
    h4 {
      margin: 8px 0 4px;
      font: var(--mat-sys-title-small);
    }

    h4 {
      font: var(--mat-sys-label-medium);
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

    .raw dt {
      flex-basis: 24px;
    }

    .flag {
      margin-left: 6px;
      padding: 0 5px;
      border-radius: 4px;
      background: var(--mat-sys-tertiary-container);
      color: var(--mat-sys-on-tertiary-container);
    }

    .swatch {
      display: inline-block;
      width: 28px;
      height: 16px;
      margin-right: 8px;
      vertical-align: middle;
      border: 1px solid var(--mat-sys-outline);
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    th,
    td {
      padding: 3px 6px;
      text-align: left;
      vertical-align: top;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }

    .source {
      max-height: 200px;
      overflow: auto;
      margin: 0;
      font: 11px / 1.3 var(--studio-font-mono);
    }

    .live {
      display: block;
    }
  `,
})
export class RenderInspectionPanel {
  protected readonly channels: readonly VisualChannel[] = ['rgb', 'r', 'g', 'b', 'a'];
  protected readonly transforms: readonly VisualTransform[] = ['linear', 'srgb'];
  protected readonly fragCoordOf = fragCoord;

  private readonly handle = inject(RendererHandle);
  private readonly preferences = inject(Preferences);
  private readonly i18n = inject(I18n);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly destroyRef = inject(DestroyRef);

  private readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('image');

  protected readonly engine = this.handle.engine;
  protected readonly snapshot = this.handle.capturedFrame;

  protected readonly pending = signal(false);
  private readonly error = signal<{ code: CaptureErrorCode | null; detail: string } | null>(null);
  private readonly externallyReleased = signal(false);

  protected readonly passIndex = signal(0);
  private readonly viewKey = signal('raw');
  protected readonly visual = signal<VisualOptions>(DEFAULT_VISUAL);
  /** CSS pixels per texel, or `null` to fit the width of the panel. */
  protected readonly zoom = signal<number | null>(null);
  protected readonly picked = signal<Texel | null>(null);
  protected readonly coordinateInvalid = signal(false);
  protected readonly dpr = signal(1);

  /** Every request gets a token; an answer for any token but the newest is dropped. */
  private seq = 0;
  private abort: AbortController | null = null;
  /** Set when this panel took the capture, so hiding it never releases someone else's. */
  private owns = false;
  private lastEngine: unknown = null;

  /** Whether the user can currently see this panel. */
  protected readonly active = computed(() => {
    const prefs = this.preferences.value();
    return prefs.bottomPanelOpen && prefs.bottomPanelTab === 'inspection';
  });

  /**
   * The picked texel, but only while the viewed image is the selected pass's own
   * output: a texel of an input or a differently sized image names another place.
   */
  protected readonly observationPixel = computed<Texel | null>(() => {
    const frame = this.snapshot();
    const pass = this.selected();
    const texel = this.picked();
    const view = this.view();
    const rawId = pass?.output.rawImageId;
    if (!frame || !texel || !view || !rawId) return null;
    const raw = this.imageMeta(frame, rawId);
    const shown = this.imageMeta(frame, view.imageId);
    const isOutput = view.imageId === rawId || view.imageId === pass?.output.displayImageId;
    return raw && shown && isOutput && raw.width === shown.width && raw.height === shown.height
      ? texel
      : null;
  });

  protected readonly selected = computed<CapturedPass | null>(() => {
    const frame = this.snapshot();
    return frame ? (frame.passes[this.passIndex()] ?? frame.passes.at(-1) ?? null) : null;
  });

  protected readonly views = computed<readonly ViewOption[]>(() => {
    const frame = this.snapshot();
    const pass = this.selected();
    if (!frame || !pass) return [];
    const options: ViewOption[] = [];
    const add = (key: string, imageId: string | null, label: TranslationKey, extra = {}) => {
      if (!imageId) return;
      const image = this.imageMeta(frame, imageId);
      if (!image) return;
      options.push({
        key,
        imageId,
        label,
        params: { ...extra, format: this.i18n.t(FORMAT_KEYS[image.format]) },
      });
    };
    add(
      'raw',
      pass.output.rawImageId,
      pass.output.rawOrigin === 'frozen-replay' ? 'inspection.viewReplay' : 'inspection.viewRaw',
    );
    add('display', pass.output.displayImageId, 'inspection.viewDisplay');
    for (const input of pass.inputs) {
      add(`input:${input.channel}`, input.imageId, 'inspection.viewInput', {
        channel: input.channel,
      });
    }
    return options;
  });

  protected readonly view = computed<ViewOption | null>(
    () => this.views().find((option) => option.key === this.viewKey()) ?? this.views()[0] ?? null,
  );

  protected readonly imageSize = computed(() => {
    const frame = this.snapshot();
    const view = this.view();
    const image = frame && view ? this.imageMeta(frame, view.imageId) : null;
    return { width: image?.width ?? 1, height: image?.height ?? 1 };
  });

  protected readonly drawable = computed(() => {
    const { width, height } = this.imageSize();
    return width <= MAX_CANVAS_SIDE && height <= MAX_CANVAS_SIDE;
  });

  protected readonly stageWidth = computed(() => {
    const zoom = this.zoom();
    return zoom === null ? '100%' : `${this.imageSize().width * zoom}px`;
  });

  protected readonly zoomText = computed(() => {
    const zoom = this.zoom();
    return zoom === null
      ? this.i18n.t('inspection.zoomFit')
      : this.i18n.t('inspection.zoomValue', { zoom });
  });

  protected readonly rawUnavailable = computed(() => {
    const output = this.selected()?.output;
    return output && output.rawImageId === null ? output.rawUnavailableReason : null;
  });

  protected readonly comparison = computed(() => {
    const check = this.selected()?.output.comparison;
    if (!check) return null;
    return {
      maxDelta: check.maxDelta,
      skipped: check.skippedNonFinite,
      referenceKey: (check.reference === 'canvas'
        ? 'inspection.referenceCanvas'
        : 'inspection.referencePreEffect') as TranslationKey,
    };
  });

  protected readonly uniforms = computed(() =>
    Object.entries(this.selected()?.uniforms ?? {}).map(([name, value]) => ({
      name,
      text: formatUniform(value),
    })),
  );

  protected readonly readout = computed<Readout | null>(() => {
    const frame = this.snapshot();
    const view = this.view();
    const texel = this.picked();
    if (!frame || !view || !texel) return null;
    try {
      const image = this.imageMeta(frame, view.imageId);
      if (!image) return null;
      const { data, format } = frame.read(view.imageId, {
        x: texel.x,
        y: texel.y,
        width: 1,
        height: 1,
      });
      const rgba = Array.from(data);
      const colour = new Uint8ClampedArray(4);
      visualizeTexel(rgba, 0, format, this.visual(), colour, 0);
      const pass = this.selected();
      const displayId = pass?.output.displayImageId;
      let display: string | null = null;
      if (displayId && displayId !== view.imageId) {
        const shown = this.imageMeta(frame, displayId);
        if (shown && shown.width === image.width && shown.height === image.height) {
          const shownTexel = frame.read(displayId, { x: texel.x, y: texel.y, width: 1, height: 1 });
          display = Array.from(shownTexel.data).join(', ');
        }
      }
      return {
        format,
        components: rgba.map((value, index) => {
          const flag = classifyComponent(value, format);
          return {
            name: 'RGBA'[index],
            text: formatRaw(value),
            flag: flag === 'normal' ? null : CLASS_KEYS[flag],
          };
        }),
        color: `rgb(${colour[0]}, ${colour[1]}, ${colour[2]})`,
        display,
      };
    } catch (error) {
      if (error instanceof FrameCaptureError && error.code === 'released') {
        queueMicrotask(() => this.noteExternalRelease());
      }
      return null;
    }
  });

  protected readonly liveGpu = computed(() => {
    void this.handle.profilerEpoch();
    const id = this.selected()?.id;
    const live = id ? this.handle.profilerSnapshot()?.passes.find((pass) => pass.id === id) : null;
    const median = live?.gpu.medianMs ?? null;
    return median === null ? null : formatMilliseconds(median);
  });

  protected readonly statusText = computed(() => {
    if (this.pending()) return this.i18n.t('inspection.pending');
    const error = this.error();
    if (error?.code && ERROR_KEYS[error.code]) return this.i18n.t(ERROR_KEYS[error.code]!);
    if (error) return this.i18n.t('inspection.errorGeneric');
    if (this.externallyReleased()) return this.i18n.t('inspection.releasedExternally');
    const ended = this.handle.captureEnded();
    return ended && !this.snapshot() ? this.i18n.t(ENDED_KEYS[ended]) : '';
  });

  protected readonly errorDetail = computed(() => this.error()?.detail || null);

  constructor() {
    if (this.isBrowser) {
      this.dpr.set(window.devicePixelRatio);
      const onResize = () => this.dpr.set(window.devicePixelRatio);
      window.addEventListener('resize', onResize);
      this.destroyRef.onDestroy(() => window.removeEventListener('resize', onResize));
    }
    this.destroyRef.onDestroy(() => this.cancel());

    // Hidden, closed or pointed at another preview: nothing may stay pending or retained.
    effect(() => {
      const active = this.active();
      const engine = this.engine();
      untracked(() => {
        if (!active || engine !== this.lastEngine) this.cancel();
        this.lastEngine = engine;
      });
    });

    // A different capture (or none) starts from a clean selection.
    effect(() => {
      this.snapshot();
      untracked(() => {
        this.passIndex.set(Math.max((this.snapshot()?.passes.length ?? 1) - 1, 0));
        this.viewKey.set('raw');
        this.picked.set(null);
        this.coordinateInvalid.set(false);
        this.zoom.set(null);
        if (!this.snapshot()) this.owns = false;
      });
    });

    effect(() => this.paint());
  }

  // --- Capture lifecycle --------------------------------------------------

  protected async capture(): Promise<void> {
    if (!this.active() || this.pending() || this.snapshot()) return;
    const seq = ++this.seq;
    const controller = new AbortController();
    this.abort = controller;
    this.owns = true;
    this.error.set(null);
    this.externallyReleased.set(false);
    this.pending.set(true);
    try {
      await this.handle.captureFrame({ signal: controller.signal });
    } catch (error) {
      // Only the newest request may report: a late failure of an older one is silent.
      if (seq !== this.seq) return;
      this.owns = false;
      if (error instanceof FrameCaptureError) {
        if (!SILENT_ERRORS.has(error.code))
          this.error.set({ code: error.code, detail: error.message });
      } else {
        this.error.set({ code: null, detail: String(error) });
      }
    } finally {
      if (seq === this.seq) {
        this.pending.set(false);
        this.abort = null;
      }
    }
  }

  /** Cancels a pending request and releases what this panel captured. Idempotent. */
  protected cancel(): void {
    this.seq++;
    this.abort?.abort();
    this.abort = null;
    this.pending.set(false);
    this.error.set(null);
    this.externallyReleased.set(false);
    if (this.owns) this.handle.releaseCapture();
    this.owns = false;
    this.clearCanvas();
  }

  protected release(): void {
    this.cancel();
  }

  private noteExternalRelease(): void {
    if (!this.snapshot()?.released) return;
    this.handle.releaseCapture();
    this.externallyReleased.set(true);
  }

  // --- Selection ----------------------------------------------------------

  protected selectPass(event: Event): void {
    this.passIndex.set(Number((event.target as HTMLSelectElement).value));
    this.viewKey.set('raw');
    this.picked.set(null);
    this.coordinateInvalid.set(false);
  }

  protected selectView(event: Event): void {
    this.viewKey.set((event.target as HTMLSelectElement).value);
    this.clampPicked();
  }

  protected viewInput(channel: number): void {
    this.viewKey.set(`input:${channel}`);
    this.clampPicked();
  }

  protected setChannel(event: Event): void {
    const channel = (event.target as HTMLSelectElement).value as VisualChannel;
    this.visual.update((visual) => ({ ...visual, channel }));
  }

  protected setTransform(event: Event): void {
    const transform = (event.target as HTMLSelectElement).value as VisualTransform;
    this.visual.update((visual) => ({ ...visual, transform }));
  }

  protected setExposure(event: Event): void {
    const exposure = clampExposure(Number((event.target as HTMLInputElement).value));
    this.visual.update((visual) => ({ ...visual, exposure }));
  }

  /** A picked texel from another image may not exist in this one: it is dropped, never reinterpreted. */
  private clampPicked(): void {
    const texel = this.picked();
    const { width, height } = this.imageSize();
    if (texel && (texel.x >= width || texel.y >= height)) this.picked.set(null);
  }

  // --- Zoom and picking ---------------------------------------------------

  protected zoomBy(direction: 1 | -1): void {
    this.zoom.set(stepZoom(this.zoom(), direction));
  }

  protected onPointer(event: PointerEvent): void {
    if (event.type === 'pointermove' && event.buttons !== 1) return;
    const canvas = this.canvas()?.nativeElement;
    if (!canvas) return;
    const texel = pickTexel(
      canvas.getBoundingClientRect(),
      event.clientX,
      event.clientY,
      this.imageSize(),
    );
    if (!texel) return;
    this.coordinateInvalid.set(false);
    this.picked.set(texel);
  }

  protected setCoordinate(axis: 'x' | 'y', event: Event): void {
    const size = this.imageSize();
    const value = parseCoordinate(
      (event.target as HTMLInputElement).value,
      axis === 'x' ? size.width : size.height,
    );
    if (value === null) {
      this.coordinateInvalid.set(true);
      // The box must keep showing the texel that is actually picked, not the rejected text.
      (event.target as HTMLInputElement).value = String(this.picked()?.[axis] ?? '');
      return;
    }
    this.coordinateInvalid.set(false);
    const current = this.picked() ?? { x: 0, y: 0 };
    this.picked.set({ ...current, [axis]: value });
  }

  protected onViewerKeydown(event: KeyboardEvent): void {
    const size = this.imageSize();
    const step = event.shiftKey ? 10 : 1;
    const arrows: Record<string, readonly [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const move = arrows[event.key];
    if (move) {
      const from = this.picked() ?? {
        x: Math.floor(size.width / 2),
        y: Math.floor(size.height / 2),
      };
      this.picked.set(this.picked() ? stepTexel(from, move[0], move[1], size) : from);
    } else if (event.key === '+' || event.key === '=') {
      this.zoomBy(1);
    } else if (event.key === '-') {
      this.zoomBy(-1);
    } else if (event.key === '0') {
      this.zoom.set(null);
    } else {
      return;
    }
    event.preventDefault();
  }

  // --- Drawing ------------------------------------------------------------

  /**
   * Draws the selected image into the one canvas, a band of rows at a time, so the
   * most that is ever held beyond the canvas itself is one band of texels. The
   * canvas is the image's own size: nothing is downsampled.
   */
  private paint(): void {
    const frame = this.snapshot();
    const view = this.view();
    const element = this.canvas()?.nativeElement;
    const options = this.visual();
    if (!frame || !view || !element || !this.drawable()) return;
    untracked(() => {
      const image = this.imageMeta(frame, view.imageId);
      if (!image) return;
      const context = element.getContext('2d');
      if (!context) return;
      try {
        element.width = image.width;
        element.height = image.height;
        const rows = Math.max(1, Math.floor(BAND_TEXELS / image.width));
        for (let first = 0; first < image.height; first += rows) {
          const count = Math.min(rows, image.height - first);
          const { data, format } = frame.read(view.imageId, {
            x: 0,
            y: first,
            width: image.width,
            height: count,
          });
          const pixels = new Uint8ClampedArray(image.width * count * 4);
          const top = visualizeBand(
            data,
            image.width,
            count,
            first,
            image.height,
            format,
            options,
            pixels,
          );
          context.putImageData(new ImageData(pixels, image.width, count), 0, top);
        }
      } catch (error) {
        this.clearCanvas();
        if (error instanceof FrameCaptureError && error.code === 'released') {
          queueMicrotask(() => this.noteExternalRelease());
        }
      }
    });
  }

  /** A zero-sized canvas holds no backing store. */
  private clearCanvas(): void {
    const element = this.canvas()?.nativeElement;
    if (element) {
      element.width = 0;
      element.height = 0;
    }
  }

  // --- Presentation helpers -------------------------------------------------

  private imageMeta(frame: FrameSnapshot, id: string) {
    return frame.images.find((image) => image.id === id) ?? null;
  }

  protected imageLabel(frame: FrameSnapshot, id: string): string {
    const image = this.imageMeta(frame, id);
    return image ? `${image.width}×${image.height} ${this.i18n.t(FORMAT_KEYS[image.format])}` : id;
  }

  protected passName(pass: CapturedPass): string {
    return pass.kind === 'image' ? this.i18n.t('inspection.kindImage') : pass.id;
  }

  protected kindLabel(pass: CapturedPass): string {
    return this.i18n.t(pass.kind === 'image' ? 'inspection.kindImage' : 'inspection.kindBuffer');
  }

  protected channelKey(channel: VisualChannel): TranslationKey {
    return CHANNEL_KEYS[channel];
  }

  protected transformKey(transform: VisualTransform): TranslationKey {
    return TRANSFORM_KEYS[transform];
  }

  protected formatKey(format: TexelFormat): TranslationKey {
    return FORMAT_KEYS[format];
  }

  protected stateKey(input: CapturedInput): TranslationKey {
    return STATE_KEYS[input.state];
  }

  protected sampledKey(input: CapturedInput): TranslationKey {
    return SAMPLED_KEYS[input.effective];
  }

  protected bindingKey(input: CapturedInput): TranslationKey {
    switch (input.binding.kind) {
      case 'buffer':
        return input.binding.feedback ? 'inspection.bindBufferFeedback' : 'inspection.bindBuffer';
      case 'texture':
        return 'inspection.bindTexture';
      default:
        return 'inspection.bindNone';
    }
  }

  protected bindingParams(binding: ChannelBinding): TranslationParams {
    if (binding.kind === 'buffer') return { pass: binding.passId };
    if (binding.kind === 'texture') return { slot: binding.slot };
    return {};
  }

  protected samplingText(input: CapturedInput): string {
    return this.i18n.t('inspection.samplingValue', {
      wrap: input.sampling.wrap,
      filter: input.sampling.filter,
      flip: String(input.sampling.flipY),
      colorSpace: input.sampling.colorSpace || 'none',
    });
  }
}
