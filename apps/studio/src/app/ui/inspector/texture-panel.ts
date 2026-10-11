import { Component, effect, inject, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';

import type { TextureFilterMode, TextureWrapMode } from '@shadergrove/shared/model';
import { InspectorSession } from './inspector-session';
import { TextureAssets } from '../../assets/texture-assets';
import { TranslatePipe } from '../../i18n/translate.pipe';
import type { TranslationKey } from '../../i18n/keys';

const CHANNEL_INDICES = [0, 1, 2, 3] as const;
type ChannelIndex = (typeof CHANNEL_INDICES)[number];

const WRAP_OPTIONS: readonly { value: TextureWrapMode; labelKey: TranslationKey }[] = [
  { value: 'repeat', labelKey: 'texture.wrapRepeat' },
  { value: 'clamp', labelKey: 'texture.wrapClamp' },
  { value: 'mirror', labelKey: 'texture.wrapMirror' },
];

const FILTER_OPTIONS: readonly { value: TextureFilterMode; labelKey: TranslationKey }[] = [
  { value: 'linear', labelKey: 'texture.filterLinear' },
  { value: 'nearest', labelKey: 'texture.filterNearest' },
];

@Component({
  selector: 'app-texture-panel',
  imports: [MatIconModule, MatProgressSpinnerModule, MatTooltipModule, TranslatePipe],
  template: `
    <div class="grid">
      @for (index of indices; track index) {
        @let channel = session.channels()[index];
        @let thumb = thumbnail(index);
        <div class="slot" [class.filled]="channel.ext !== null">
          <button
            type="button"
            class="thumb"
            [disabled]="!session.shader() || busy()[index]"
            [matTooltip]="(channel.ext !== null ? 'texture.replace' : 'texture.assign') | translate"
            [attr.aria-label]="'iChannel' + index"
            (click)="fileInput.click()"
          >
            @if (busy()[index]) {
              <mat-progress-spinner mode="indeterminate" diameter="20" />
            } @else if (thumb) {
              <img [src]="thumb" alt="" />
            } @else {
              <mat-icon>add_photo_alternate</mat-icon>
            }
            <span class="label">iChannel{{ index }}</span>
          </button>

          @if (channel.ext !== null) {
            <button
              type="button"
              class="clear"
              [matTooltip]="'texture.clear' | translate"
              [attr.aria-label]="'texture.clearChannel' | translate: { index }"
              [disabled]="busy()[index]"
              (click)="clear(index, $event)"
            >
              <mat-icon>close</mat-icon>
            </button>

            <div class="settings">
              <select
                class="mini-select"
                [attr.aria-label]="'texture.wrap' | translate"
                [value]="channel.wrap"
                (change)="setWrap(index, $event)"
              >
                @for (option of wrapOptions; track option.value) {
                  <option [value]="option.value">{{ option.labelKey | translate }}</option>
                }
              </select>
              <select
                class="mini-select"
                [attr.aria-label]="'texture.filter' | translate"
                [value]="channel.filter"
                (change)="setFilter(index, $event)"
              >
                @for (option of filterOptions; track option.value) {
                  <option [value]="option.value">{{ option.labelKey | translate }}</option>
                }
              </select>
            </div>
          }

          <input
            #fileInput
            type="file"
            hidden
            accept="image/png,image/jpeg,image/webp"
            (change)="pick(index, fileInput)"
          />
        </div>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      padding: 0 12px;
    }

    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }

    .slot {
      position: relative;
    }

    .thumb {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 4px;
      width: 100%;
      height: 84px;
      padding: 0;
      border: 1px dashed var(--mat-sys-outline-variant);
      border-radius: var(--mat-sys-corner-small);
      background:
        linear-gradient(
            45deg,
            color-mix(in srgb, var(--mat-sys-surface) 92%, transparent) 25%,
            transparent 25%
          )
          0 0 / 12px 12px,
        linear-gradient(
            45deg,
            transparent 75%,
            color-mix(in srgb, var(--mat-sys-surface) 92%, transparent) 75%
          )
          0 0 / 12px 12px,
        var(--mat-sys-surface-container-low);
      color: var(--mat-sys-on-surface-variant);
      cursor: pointer;
    }

    .slot.filled .thumb {
      border-style: solid;
    }

    .thumb:disabled {
      cursor: default;
      opacity: 0.6;
    }

    .thumb img {
      max-width: 100%;
      max-height: 52px;
      object-fit: contain;
      border-radius: 2px;
    }

    .label {
      font: var(--mat-sys-label-small);
      opacity: 0.85;
    }

    .clear {
      position: absolute;
      top: 2px;
      right: 2px;
      width: 22px;
      height: 22px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      border: none;
      border-radius: 50%;
      background: color-mix(in srgb, var(--mat-sys-surface) 70%, transparent);
      color: var(--mat-sys-on-surface);
      cursor: pointer;

      mat-icon {
        font-size: 14px;
        width: 14px;
        height: 14px;
      }
    }

    .settings {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-top: 4px;
    }

    .mini-select {
      width: 100%;
      font: var(--mat-sys-label-small);
      padding: 2px 4px;
      border-radius: 4px;
      border: 1px solid var(--mat-sys-outline-variant);
      background: var(--mat-sys-surface-container-low);
      color: var(--mat-sys-on-surface);
    }
  `,
})
export class TexturePanel {
  protected readonly session = inject(InspectorSession);
  private readonly textures = inject(TextureAssets);

  protected readonly indices = CHANNEL_INDICES;
  protected readonly wrapOptions = WRAP_OPTIONS;
  protected readonly filterOptions = FILTER_OPTIONS;

  protected readonly busy = signal<readonly boolean[]>([false, false, false, false]);
  private readonly thumbnails = signal<readonly (string | null)[]>([null, null, null, null]);

  constructor() {
    effect((onCleanup) => {
      const shader = this.session.shader();
      const channels = this.session.channels();
      if (!shader) {
        this.thumbnails.set([null, null, null, null]);
        return;
      }

      let cancelled = false;
      onCleanup(() => {
        cancelled = true;
      });

      void Promise.all(
        channels.map((channel, index) =>
          this.textures
            .resolve(shader.id, index, channel, shader.updatedAt)
            .then((resolved) => resolved?.url ?? null),
        ),
      ).then((urls) => {
        if (!cancelled) this.thumbnails.set(urls);
      });
    });
  }

  protected thumbnail(index: ChannelIndex): string | null {
    return this.thumbnails()[index] ?? null;
  }

  protected async pick(index: ChannelIndex, input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    this.setBusy(index, true);
    try {
      await this.session.setTextureImage(index, file);
    } finally {
      this.setBusy(index, false);
    }
  }

  protected async clear(index: ChannelIndex, event: Event): Promise<void> {
    event.stopPropagation();
    this.setBusy(index, true);
    try {
      await this.session.clearTextureImage(index);
    } finally {
      this.setBusy(index, false);
    }
  }

  protected setWrap(index: ChannelIndex, event: Event): void {
    void this.session.setChannelSettings(index, {
      wrap: (event.target as HTMLSelectElement).value as TextureWrapMode,
    });
  }

  protected setFilter(index: ChannelIndex, event: Event): void {
    void this.session.setChannelSettings(index, {
      filter: (event.target as HTMLSelectElement).value as TextureFilterMode,
    });
  }

  private setBusy(index: ChannelIndex, value: boolean): void {
    this.busy.update((current) => current.map((entry, i) => (i === index ? value : entry)));
  }
}
