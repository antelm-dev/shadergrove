import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injectable,
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

import { TOOL_LIMITS, sourceFingerprint, type AssetToolOutput } from '@shadergrove/shared/plugin';
import type { ChannelIndex } from '@shadergrove/shared/project';
import { I18n } from '../../i18n/i18n';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { ShaderStore } from '../../workspace/shader-store';
import {
  PluginTools,
  type AssetToolAdapter,
  type ToolDelivery,
  type ToolSession,
  type ToolSource,
} from '../plugin-tools';
import {
  CHANNEL_NAMES,
  NORMAL_STRENGTH,
  OUTPUT_DIMENSION,
  SelectionError,
  buildTextureRequest,
  edgeDifferences,
  textureKey,
  textureSidecarDetails,
  validateTextureSettings,
  type ChannelName,
  type ChannelSource,
  type NormalSettings,
  type TextureOperation,
  type TextureSelection,
} from './textures';
import {
  ImageBridgeError,
  assignPngToChannel,
  channelTarget,
  decodeImageFile,
  downloadBlob,
  drawImage,
  encodePng,
  fitWithin,
  fromToolImage,
  imageSidecar,
  safeFileName,
  type ChannelView,
  type DecodedImage,
  type ResampleFilter,
} from './textures-image-bridge';

interface Slot {
  /** Unique per pick: a result is tied to the picks it was made from. */
  id: number;
  image: DecodedImage;
}

type Notice = { text: string; error: boolean };

const DEFAULT_CHANNELS: ChannelSource[] = [
  { plane: 0, channel: 'r' },
  { plane: 0, channel: 'g' },
  { plane: 0, channel: 'b' },
  { constant: 255 },
];

/**
 * The Texture Utilities panel: pick up to four images, pack their channels or
 * turn a height map into a normal map, look at the result (one channel at a
 * time, or tiled 3×3 with its edge differences), then download it as PNG plus
 * a metadata sidecar or assign it to a texture slot of the open shader.
 *
 * It runs two sessions of its own, both tied to the selection (picked images,
 * operation and settings): small previews, coalesced as the settings change,
 * and the full-size job, which a preview never cancels. Changing the selection
 * makes either result out of date at once; switching the plugin off, updating
 * or removing it, or changing profile does too (the sessions end with the card).
 * Nothing it makes replaces an input: results are new images.
 */
@Component({
  selector: 'app-textures-panel',
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
    .slot {
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
    canvas {
      background: repeating-conic-gradient(#8884 0 25%, transparent 0 50%) 0 0 / 16px 16px;
      image-rendering: pixelated;
      max-height: 320px;
      max-width: 100%;
    }
    .actions {
      align-items: center;
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }
  `,
  template: `
    <fieldset>
      <legend>{{ k('operation') | translate }}</legend>
      @for (option of operations; track option.value) {
        <label>
          <input
            type="radio"
            [attr.data-testid]="'textures-op-' + option.value"
            [checked]="operation() === option.value"
            (change)="operation.set(option.value)"
          />
          {{ k(option.label) | translate }}
        </label>
      }
    </fieldset>

    <fieldset>
      <legend>{{ k(operation() === 'pack' ? 'images' : 'heightMap') | translate }}</legend>
      @for (slot of visibleSlots(); track slot) {
        <div class="slot">
          <button
            matButton="tonal"
            type="button"
            [attr.data-testid]="'textures-pick-' + slot"
            (click)="picker.click()"
          >
            {{ k('choose') | translate }}
            @if (operation() === 'pack') {
              {{ slot + 1 }}
            }
          </button>
          <input
            #picker
            hidden
            type="file"
            accept="image/png,image/jpeg,image/webp"
            [attr.data-testid]="'textures-file-' + slot"
            (change)="pick(slot, picker)"
          />
          @if (slots()[slot]; as current) {
            <span [attr.data-testid]="'textures-image-' + slot">
              {{
                k('imageInfo')
                  | translate
                    : {
                        n: slot + 1,
                        name: current.image.name,
                        width: current.image.width,
                        height: current.image.height,
                      }
              }}
            </span>
            <button matButton type="button" (click)="clearSlot(slot)">
              {{ k('remove') | translate }}
            </button>
          }
        </div>
      }
      <p class="muted">{{ k('resampleNote') | translate }}</p>
    </fieldset>

    <fieldset>
      <legend>{{ k('outputSize') | translate }}</legend>
      <label>
        {{ k('width') | translate }}
        <input
          type="number"
          min="1"
          [max]="maxSide"
          data-testid="textures-width"
          [ngModel]="width()"
          (ngModelChange)="setSide('width', $event)"
        />
      </label>
      <label>
        {{ k('height') | translate }}
        <input
          type="number"
          min="1"
          [max]="maxSide"
          data-testid="textures-height"
          [ngModel]="height()"
          (ngModelChange)="setSide('height', $event)"
        />
      </label>
      <label>
        {{ k('filter') | translate }}
        <select data-testid="textures-filter" [ngModel]="filter()" (ngModelChange)="filter.set($event)">
          <option value="nearest">{{ k('filterNearest') | translate }}</option>
          <option value="linear">{{ k('filterLinear') | translate }}</option>
        </select>
      </label>
    </fieldset>

    @if (operation() === 'pack') {
      <fieldset>
        <legend>{{ k('output') | translate }}</legend>
        <label>
          {{ k('usage') | translate }}
          <select data-testid="textures-usage" [ngModel]="usage()" (ngModelChange)="usage.set($event)">
            <option value="data">{{ k('usageData') | translate }}</option>
            <option value="color">{{ k('usageColor') | translate }}</option>
          </select>
        </label>
        @for (source of channels(); track $index) {
          @let target = $index;
          <div class="slot">
            <strong>{{ letters[target] }}</strong>
            <label>
              {{ k('source') | translate }}
              <select
                [attr.data-testid]="'textures-source-' + target"
                [ngModel]="sourceValue(source)"
                (ngModelChange)="setSource(target, $event)"
              >
                @for (slot of allSlots; track slot) {
                  <option [value]="'' + slot">{{ k('image') | translate: { n: slot + 1 } }}</option>
                }
                <option value="constant">{{ k('constant') | translate }}</option>
              </select>
            </label>
            @if (isConstant(source)) {
              <input
                type="number"
                min="0"
                max="255"
                [attr.aria-label]="k('constant') | translate"
                [attr.data-testid]="'textures-constant-' + target"
                [ngModel]="source.constant"
                (ngModelChange)="setConstant(target, $event)"
              />
            } @else {
              <label>
                {{ k('channel') | translate }}
                <select
                  [attr.data-testid]="'textures-channel-' + target"
                  [ngModel]="source.channel"
                  (ngModelChange)="setChannel(target, $event)"
                >
                  @for (name of channelNames; track name; let i = $index) {
                    <option [value]="name">{{ letters[i] }}</option>
                  }
                </select>
              </label>
            }
          </div>
        }
      </fieldset>
    } @else {
      <fieldset>
        <legend>{{ k('opNormal') | translate }}</legend>
        <label>
          {{ k('heightChannel') | translate }}
          <select
            data-testid="textures-height-channel"
            [ngModel]="normal().channel"
            (ngModelChange)="setNormal({ channel: $event })"
          >
            @for (name of channelNames; track name; let i = $index) {
              <option [value]="name">{{ letters[i] }}</option>
            }
          </select>
        </label>
        <label>
          {{ k('strength') | translate }}
          <input
            type="number"
            step="0.5"
            [min]="strength.min"
            [max]="strength.max"
            data-testid="textures-strength"
            [ngModel]="normal().strength"
            (ngModelChange)="setStrength($event)"
          />
        </label>
        <label>
          {{ k('green') | translate }}
          <select
            data-testid="textures-green"
            [ngModel]="normal().green"
            (ngModelChange)="setNormal({ green: $event })"
          >
            <option value="up">{{ k('greenUp') | translate }}</option>
            <option value="down">{{ k('greenDown') | translate }}</option>
          </select>
        </label>
        <label>
          {{ k('edges') | translate }}
          <select
            data-testid="textures-edges"
            [ngModel]="normal().edges"
            (ngModelChange)="setNormal({ edges: $event })"
          >
            <option value="wrap">{{ k('edgesWrap') | translate }}</option>
            <option value="clamp">{{ k('edgesClamp') | translate }}</option>
          </select>
        </label>
      </fieldset>
    }

    <fieldset>
      <legend>{{ k('preview') | translate }}</legend>
      <label>
        {{ k('view') | translate }}
        <select data-testid="textures-view" [ngModel]="view()" (ngModelChange)="view.set($event)">
          <option value="rgba">RGBA</option>
          <option value="rgb">RGB</option>
          <option value="r">R</option>
          <option value="g">G</option>
          <option value="b">B</option>
          <option value="a">A</option>
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          data-testid="textures-tile"
          [ngModel]="tile()"
          (ngModelChange)="tile.set($event)"
        />
        {{ k('tile') | translate }}
      </label>
      <div class="slot">
        <canvas #preview data-testid="textures-preview" [hidden]="!previewImage()"></canvas>
      </div>
      @if (seams(); as edges) {
        <p class="muted" data-testid="textures-seams">
          {{
            k('seams')
              | translate
                : {
                    lrMean: edges.leftRight.mean,
                    lrMax: edges.leftRight.max,
                    tbMean: edges.topBottom.mean,
                    tbMax: edges.topBottom.max,
                  }
          }}
        </p>
        <p class="muted">{{ k('seamsHint') | translate }}</p>
      }
      <p
        role="status"
        data-testid="textures-preview-status"
        [class.error]="previewProblem() !== null"
        [class.muted]="previewProblem() === null"
      >
        @if (previewProblem(); as problem) {
          {{ problem }}
        } @else if (sessions()?.preview?.running()) {
          {{ k('working') | translate }}
        }
      </p>
    </fieldset>

    <fieldset>
      <legend>{{ k('result') | translate }}</legend>
      <label>
        {{ k('name') | translate }}
        <input
          type="text"
          maxlength="64"
          data-testid="textures-name"
          [ngModel]="name()"
          (ngModelChange)="name.set($event)"
        />
      </label>
      <div class="actions">
        <button
          matButton="filled"
          type="button"
          data-testid="textures-generate"
          [disabled]="!sessions() || sessions()!.full.running()"
          (click)="generate()"
        >
          {{ k('generate') | translate }}
        </button>
        @if (sessions()?.full?.running()) {
          <span class="muted" role="status">{{ k('working') | translate }}</span>
          <button matButton type="button" data-testid="textures-cancel" (click)="sessions()!.full.cancel()">
            {{ 'action.cancel' | translate }}
          </button>
        }
      </div>
      @if (fullImage(); as result) {
        <p data-testid="textures-result">
          {{ result.width }}×{{ result.height }} · {{ result.usage }} · {{ result.alpha }}
        </p>
        <div class="actions">
          <button
            matButton="tonal"
            type="button"
            data-testid="textures-download-png"
            (click)="download('png')"
          >
            {{ k('downloadPng') | translate }}
          </button>
          <button
            matButton="tonal"
            type="button"
            data-testid="textures-download-sidecar"
            (click)="download('sidecar')"
          >
            {{ k('downloadSidecar') | translate }}
          </button>
        </div>
        @if (store.record()) {
          <div class="actions">
            <label>
              {{ k('slot') | translate }}
              <select data-testid="textures-slot" [ngModel]="slot()" (ngModelChange)="setSlot($event)">
                @for (index of allSlots; track index) {
                  <option [value]="index">iChannel{{ index }}</option>
                }
              </select>
            </label>
            <button
              matButton="tonal"
              type="button"
              data-testid="textures-assign"
              (click)="assign()"
            >
              {{ k('assign') | translate: { channel: slot() } }}
            </button>
          </div>
        } @else {
          <p class="muted">{{ k('assignNeedsShader') | translate }}</p>
        }
      } @else if (sessions()?.full?.stale()) {
        <p class="muted" data-testid="textures-stale">{{ k('stale') | translate }}</p>
      }
      @if (notice(); as current) {
        <p
          data-testid="textures-notice"
          [attr.role]="current.error ? 'alert' : 'status'"
          [class.error]="current.error"
        >
          {{ current.text }}
        </p>
      }
    </fieldset>
  `,
})
export class TexturesPanel {
  readonly session = input.required<ToolSession>();

  protected readonly store = inject(ShaderStore);
  private readonly tools = inject(PluginTools);
  private readonly i18n = inject(I18n);

  protected readonly k = textureKey;
  protected readonly letters = ['R', 'G', 'B', 'A'];
  protected readonly channelNames = CHANNEL_NAMES;
  protected readonly allSlots = [0, 1, 2, 3] as const;
  protected readonly maxSide = OUTPUT_DIMENSION;
  protected readonly strength = NORMAL_STRENGTH;
  protected readonly operations = [
    { value: 'pack', label: 'opPack' },
    { value: 'normal', label: 'opNormal' },
  ] as const;

  protected readonly operation = signal<TextureOperation>('pack');
  protected readonly slots = signal<readonly (Slot | null)[]>([null, null, null, null]);
  protected readonly width = signal(256);
  protected readonly height = signal(256);
  /** Whether the user set the size; until then it follows the first image. */
  private sizeChosen = false;
  protected readonly filter = signal<ResampleFilter>('linear');
  protected readonly usage = signal<'color' | 'data'>('data');
  protected readonly channels = signal<readonly ChannelSource[]>(DEFAULT_CHANNELS);
  protected readonly normal = signal<Omit<NormalSettings, 'name'>>({
    channel: 'r',
    strength: 2,
    green: 'up',
    edges: 'wrap',
  });
  protected readonly name = signal('texture');
  protected readonly view = signal<ChannelView>('rgba');
  protected readonly tile = signal(false);
  protected readonly slot = signal<ChannelIndex>(0);
  protected readonly notice = signal<Notice | null>(null);
  private readonly selectionProblem = signal<string | null>(null);
  private nextId = 1;

  protected readonly visibleSlots = computed(() =>
    this.operation() === 'pack' ? [0, 1, 2, 3] : [0],
  );

  private readonly selection = computed<TextureSelection>(() => ({
    operation: this.operation(),
    images: this.slots().map((slot) => slot?.image ?? null),
    width: this.width(),
    height: this.height(),
    filter: this.filter(),
    usage: this.usage(),
    channels: this.channels(),
    normal: this.normal(),
    name: this.name().trim() || 'texture',
  }));

  /** What results are tied to: the picks (by id), operation and settings. */
  private readonly selectionSource = computed<ToolSource>(() => {
    const { images: _images, ...settings } = this.selection();
    const picks = this.slots().map((slot) => slot?.id ?? 0);
    return { shaderId: 'texture-utilities', fingerprint: sourceFingerprint({ picks, settings }) };
  });

  /** A preview session and a full-size one, opened for the session the card gave this panel. */
  protected readonly sessions = signal<{ preview: ToolSession; full: ToolSession } | null>(null);

  protected readonly previewImage = computed(() =>
    imageOf(this.sessions()?.preview.result()?.value),
  );
  protected readonly fullImage = computed(() => imageOf(this.sessions()?.full.result()?.value));
  protected readonly seams = computed(() => {
    const image = this.previewImage();
    return image ? edgeDifferences(fromToolImage(image)) : null;
  });
  protected readonly previewProblem = computed(
    () => this.selectionProblem() ?? this.sessions()?.preview.error() ?? null,
  );

  private readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('preview');

  constructor() {
    effect((onCleanup) => {
      const given = this.session();
      const opened = untracked(() => {
        const open = () =>
          this.tools.openSession(given.packageId, given.contributionId, {
            source: this.selectionSource,
          });
        return { preview: open(), full: open() };
      });
      const { preview, full } = opened;
      if (!preview || !full) {
        preview?.close();
        full?.close();
        this.sessions.set(null);
        return;
      }
      this.sessions.set({ preview, full });
      onCleanup(() => {
        preview.close();
        full.close();
      });
    });

    // Previews follow the selection, coalesced: each one supersedes the one before.
    effect((onCleanup) => {
      const sessions = this.sessions();
      const selection = this.selection();
      if (!sessions) return;
      const timer = setTimeout(() => void this.runPreview(sessions.preview, selection), 120);
      onCleanup(() => clearTimeout(timer));
    });

    effect(() => {
      const canvas = this.canvas()?.nativeElement;
      const image = this.previewImage();
      if (canvas && image)
        drawImage(canvas, fromToolImage(image), this.view(), this.tile() ? 3 : 1);
    });
  }

  // --- Selection --------------------------------------------------------------------

  protected async pick(slot: number, picker: HTMLInputElement): Promise<void> {
    const file = picker.files?.[0];
    picker.value = '';
    if (!file) return;
    try {
      const image = await decodeImageFile(file, 'data');
      this.slots.update((slots) =>
        slots.map((entry, index) => (index === slot ? { id: this.nextId++, image } : entry)),
      );
      if (!this.sizeChosen && slot === this.firstFilled()) {
        const size = fitWithin(image.width, image.height, OUTPUT_DIMENSION);
        this.width.set(size.width);
        this.height.set(size.height);
      }
      this.notice.set(null);
    } catch (error) {
      this.say(error instanceof ImageBridgeError ? error.message : String(error), true);
    }
  }

  protected clearSlot(slot: number): void {
    this.slots.update((slots) => slots.map((entry, index) => (index === slot ? null : entry)));
  }

  private firstFilled(): number {
    return this.slots().findIndex((slot) => slot !== null);
  }

  protected setSide(side: 'width' | 'height', value: unknown): void {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number)) return;
    this.sizeChosen = true;
    this[side].set(Math.min(OUTPUT_DIMENSION, Math.max(1, number)));
  }

  protected setSlot(value: unknown): void {
    const slot = Number(value);
    if (slot === 0 || slot === 1 || slot === 2 || slot === 3) this.slot.set(slot);
  }

  protected sourceValue(source: ChannelSource): string {
    return 'constant' in source ? 'constant' : String(source.plane);
  }

  protected isConstant(source: ChannelSource): source is { constant: number } {
    return 'constant' in source;
  }

  protected setSource(target: number, value: string): void {
    this.updateChannel(target, (source) =>
      value === 'constant'
        ? { constant: 'constant' in source ? source.constant : 255 }
        : { plane: Number(value), channel: 'channel' in source ? source.channel : 'r' },
    );
  }

  protected setChannel(target: number, channel: ChannelName): void {
    this.updateChannel(target, (source) => ('plane' in source ? { ...source, channel } : source));
  }

  protected setConstant(target: number, value: unknown): void {
    const constant = Math.min(255, Math.max(0, Math.round(Number(value) || 0)));
    this.updateChannel(target, () => ({ constant }));
  }

  private updateChannel(target: number, change: (source: ChannelSource) => ChannelSource): void {
    this.channels.update((channels) =>
      channels.map((source, index) => (index === target ? change(source) : source)),
    );
  }

  protected setNormal(patch: Partial<Omit<NormalSettings, 'name'>>): void {
    this.normal.update((normal) => ({ ...normal, ...patch }));
  }

  protected setStrength(value: unknown): void {
    const strength = Number(value);
    if (Number.isFinite(strength)) {
      this.setNormal({
        strength: Math.min(NORMAL_STRENGTH.max, Math.max(NORMAL_STRENGTH.min, strength)),
      });
    }
  }

  // --- Jobs ------------------------------------------------------------------------

  private request(selection: TextureSelection, preview: boolean) {
    try {
      const request = buildTextureRequest(selection, preview);
      this.selectionProblem.set(null);
      return request;
    } catch (error) {
      const text =
        error instanceof SelectionError
          ? this.i18n.t(error.key, error.params)
          : error instanceof Error
            ? error.message
            : String(error);
      this.selectionProblem.set(text);
      return null;
    }
  }

  private async runPreview(session: ToolSession, selection: TextureSelection): Promise<void> {
    const needsImage =
      selection.operation === 'normal' || selection.channels.some((source) => 'plane' in source);
    if (needsImage && selection.images.every((image) => image === null)) {
      this.selectionProblem.set(this.i18n.t(textureKey('needImages')));
      return;
    }
    const request = this.request(selection, true);
    if (request) await session.runAsset(request);
  }

  protected async generate(): Promise<void> {
    const sessions = this.sessions();
    if (!sessions) return;
    this.notice.set(null);
    const request = this.request(this.selection(), false);
    if (!request) return;
    const outcome = await sessions.full.runAsset(request);
    if (outcome.status === 'failed') this.say(outcome.message, true);
    else if (outcome.status === 'cancelled') this.say(this.i18n.t(textureKey('cancelled')), false);
    else if (outcome.status === 'stale') this.say(this.i18n.t(textureKey('staleDelivery')), true);
  }

  /** The PNG or its sidecar, from the full result — only while it still holds. */
  protected async download(what: 'png' | 'sidecar'): Promise<void> {
    const sessions = this.sessions();
    if (!sessions) return;
    const selection = this.selection();
    const outcome = await sessions.full.deliver(async (value, check) => {
      const image = imageOf(value);
      if (!image) throw new Error('This result has no image');
      // A Worker's image name is a label: the file name is made safe here.
      const stem = safeFileName(image.name, 'texture');
      if (what === 'png') {
        const png = await encodePng(fromToolImage(image));
        check();
        downloadBlob(png, `${stem}.png`);
        return `${stem}.png`;
      }
      const sidecar = imageSidecar(image, `${stem}.png`, {
        name: image.name,
        ...textureSidecarDetails(selection),
        limits: {
          outputDimension: OUTPUT_DIMENSION,
          previewDimension: TOOL_LIMITS.previewDimension,
        },
      });
      check();
      downloadBlob(
        new Blob([`${JSON.stringify(sidecar, null, 2)}\n`], { type: 'application/json' }),
        `${stem}.json`,
      );
      return `${stem}.json`;
    });
    this.report(outcome, (file) => this.i18n.t(textureKey('downloaded'), { file }));
  }

  /** Assign the full result to the chosen slot of the open shader, if neither changed meanwhile. */
  protected async assign(): Promise<void> {
    const sessions = this.sessions();
    const channel = this.slot();
    const expected = channelTarget(this.store, channel);
    if (!sessions || !expected) {
      this.say(this.i18n.t(textureKey('assignNeedsShader')), true);
      return;
    }
    const shader = this.store.record()?.name ?? '';
    const outcome = await sessions.full.deliver(
      async (value, check) => {
        const image = imageOf(value);
        if (!image) throw new Error('This result has no image');
        const png = await encodePng(fromToolImage(image));
        await assignPngToChannel(
          this.store,
          channel,
          png,
          `${safeFileName(image.name, 'texture')}.png`,
          check,
        );
      },
      { expected, current: () => channelTarget(this.store, channel) },
    );
    this.report(outcome, () => this.i18n.t(textureKey('assigned'), { channel, shader }));
  }

  private report<R>(outcome: ToolDelivery<R>, done: (value: R) => string): void {
    if (outcome.status === 'delivered') this.say(done(outcome.value), false);
    else if (outcome.status === 'stale') this.say(this.i18n.t(textureKey('staleDelivery')), true);
    else this.say(outcome.message, true);
  }

  private say(text: string, error: boolean): void {
    this.notice.set({ text, error });
  }
}

function imageOf(value: unknown) {
  const output = value as AssetToolOutput | undefined;
  return output?.kind === 'image' ? (output.images[0] ?? null) : null;
}

/** Registers the panel for every `texture-utilities/v1` tool (`provideToolAdapters`). */
@Injectable()
export class TextureUtilitiesAdapter implements AssetToolAdapter {
  readonly kind = 'assetTool' as const;
  readonly workflow = 'texture-utilities/v1' as const;
  readonly command = { label: textureKey('command'), icon: 'texture' };
  readonly panel = TexturesPanel;
  readonly needsProject = false;

  validateSettings(operation: string, settings: unknown) {
    return validateTextureSettings(operation, settings);
  }
}
