import { isPlatformBrowser } from '@angular/common';
import {
  Component,
  ElementRef,
  PLATFORM_ID,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

import { I18n } from '../../i18n/i18n';
import type { TranslationKey } from '../../i18n/keys';
import { TranslatePipe } from '../../i18n/translate.pipe';
import {
  OutputLog,
  type OutputLogEntry,
  type OutputLogLevel,
  type OutputLogSource,
} from './output-log';

const SOURCE_KEYS: Record<OutputLogSource, TranslationKey> = {
  compiler: 'output.source.compiler',
  renderer: 'output.source.renderer',
  workspace: 'output.source.workspace',
  mcp: 'output.source.mcp',
};

const LEVEL_KEYS: Record<OutputLogLevel, TranslationKey> = {
  info: 'output.level.info',
  warning: 'output.level.warning',
  error: 'output.level.error',
};

/** How close to the bottom the user has to be for a new entry to auto-scroll. */
const AUTOSCROLL_THRESHOLD = 24;

/**
 * Structured application output — shader compiler and renderer messages
 * today, `OutputLog`'s other sources as they arrive.
 *
 * Auto-scrolls to a new entry only while the user is already at (or near) the
 * bottom. Scrolling up to read an earlier message opts out of it until they
 * scroll back down themselves — the same behaviour every log viewer and
 * terminal uses, and the only one that does not fight you for the wheel.
 */
@Component({
  selector: 'app-output-panel',
  imports: [MatButtonModule, MatIconModule, MatTooltipModule, TranslatePipe],
  template: `
    <div class="toolbar">
      <div class="title">
        <mat-icon aria-hidden="true">terminal</mat-icon>
        <span>{{ 'panel.output' | translate }}</span>
        <span class="count" aria-live="polite">{{ entries().length }}</span>
      </div>
      <span class="spacer"></span>
      <button
        matIconButton
        type="button"
        [matTooltip]="'panel.clearOutput' | translate"
        [attr.aria-label]="'panel.clearOutput' | translate"
        [disabled]="entries().length === 0"
        (click)="clear()"
      >
        <mat-icon>delete_sweep</mat-icon>
      </button>
    </div>

    <div
      class="log"
      [class.empty-log]="entries().length === 0"
      #scrollHost
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      (scroll)="onScroll()"
    >
      @if (entries().length === 0) {
        <div class="empty">
          <mat-icon aria-hidden="true">terminal</mat-icon>
          <p>{{ 'panel.noOutput' | translate }}</p>
        </div>
      } @else {
        @for (entry of entries(); track entry.id) {
          <div class="entry" [class]="entry.level">
            <span class="time">{{ formatTime(entry.timestamp) }}</span>
            <mat-icon class="level-icon" [attr.aria-label]="levelLabel(entry.level)">
              {{ levelIcon(entry.level) }}
            </mat-icon>
            <span class="source">{{ sourceLabel(entry.source) }}</span>
            <span class="message">{{ entry.message }}</span>
          </div>
        }
      }
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
      height: 100%;
    }

    .toolbar {
      display: flex;
      align-items: center;
      flex: 0 0 auto;
      gap: 8px;
      min-height: 34px;
      padding: 2px 6px 2px 10px;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
      background: color-mix(in srgb, var(--mat-sys-surface-container-low) 62%, transparent);
    }

    .title {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-medium);
    }

    .title mat-icon {
      width: 16px;
      height: 16px;
      font-size: 16px;
    }

    .count {
      display: inline-grid;
      min-width: 18px;
      height: 18px;
      padding-inline: 5px;
      place-items: center;
      border-radius: 9px;
      background: color-mix(in srgb, var(--mat-sys-on-surface) 10%, transparent);
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-small);
    }

    .spacer {
      flex: 1;
    }

    .log {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      overscroll-behavior: contain;
    }

    .log.empty-log {
      overflow: hidden;
    }

    .empty {
      box-sizing: border-box;
      display: grid;
      place-items: center;
      align-content: center;
      gap: 8px;
      height: 100%;
      margin: 0;
      padding: 16px;
      color: var(--mat-sys-on-surface-variant);
      text-align: center;
    }

    .empty mat-icon {
      width: 28px;
      height: 28px;
      font-size: 28px;
      opacity: 0.65;
    }

    .empty p {
      margin: 0;
    }

    .entry {
      display: grid;
      grid-template-columns: auto 16px minmax(70px, auto) minmax(0, 1fr);
      align-items: start;
      column-gap: 8px;
      padding: 6px 12px;
      font: var(--mat-sys-body-small);
      font-family: 'JetBrains Mono', Consolas, monospace;
      border-bottom: 1px solid color-mix(in srgb, var(--mat-sys-outline-variant) 40%, transparent);
    }

    .entry:hover {
      background: color-mix(in srgb, var(--mat-sys-on-surface) 4%, transparent);
    }

    .time {
      flex: 0 0 auto;
      color: var(--mat-sys-on-surface-variant);
    }

    .source {
      flex: 0 0 auto;
      max-width: 16ch;
      padding: 1px 5px;
      overflow: hidden;
      border-radius: 3px;
      background: color-mix(in srgb, var(--mat-sys-on-surface) 7%, transparent);
      color: var(--mat-sys-on-surface-variant);
      text-overflow: ellipsis;
      text-transform: uppercase;
      white-space: nowrap;
      font-size: 0.85em;
      letter-spacing: 0.04em;
    }

    .level-icon {
      align-self: center;
      flex: 0 0 auto;
      font-size: 15px;
      width: 15px;
      height: 15px;
      color: var(--mat-sys-on-surface-variant);
    }

    .entry.warning .level-icon {
      color: var(--mat-sys-tertiary);
    }

    .entry.error .level-icon {
      color: var(--mat-sys-error);
    }

    .entry.warning .message {
      color: var(--mat-sys-tertiary);
    }

    .entry.error .message {
      color: var(--mat-sys-error);
    }

    .message {
      min-width: 0;
      color: var(--mat-sys-on-surface);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    @media (max-width: 520px) {
      .entry {
        grid-template-columns: auto 16px minmax(0, 1fr);
      }

      .source {
        grid-column: 3;
        width: fit-content;
      }

      .message {
        grid-column: 1 / -1;
        padding-left: 24px;
      }
    }
  `,
})
export class OutputPanel {
  private readonly log = inject(OutputLog);
  private readonly i18n = inject(I18n);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  private readonly scrollHost = viewChild<ElementRef<HTMLDivElement>>('scrollHost');

  protected readonly entries = this.log.entries;

  /** Whether the viewport was at (or near) the bottom before the latest entry arrived. */
  private readonly stickToBottom = signal(true);

  constructor() {
    effect(() => {
      const count = this.entries().length;
      untracked(() => {
        void count;
        if (!this.isBrowser || !this.stickToBottom()) return;
        queueMicrotask(() => this.scrollToBottom());
      });
    });
  }

  protected clear(): void {
    this.log.clear();
    this.stickToBottom.set(true);
  }

  protected onScroll(): void {
    const el = this.scrollHost()?.nativeElement;
    if (!el) return;
    this.stickToBottom.set(
      el.scrollHeight - el.scrollTop - el.clientHeight <= AUTOSCROLL_THRESHOLD,
    );
  }

  private scrollToBottom(): void {
    const el = this.scrollHost()?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
  }

  protected formatTime(timestamp: number): string {
    const date = new Date(timestamp);
    const pad = (value: number): string => String(value).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  protected sourceLabel(source: OutputLogEntry['source']): string {
    return this.i18n.t(SOURCE_KEYS[source]);
  }

  protected levelLabel(level: OutputLogEntry['level']): string {
    return this.i18n.t(LEVEL_KEYS[level]);
  }

  protected levelIcon(level: OutputLogEntry['level']): string {
    switch (level) {
      case 'error':
        return 'error';
      case 'warning':
        return 'warning';
      default:
        return 'info';
    }
  }
}
