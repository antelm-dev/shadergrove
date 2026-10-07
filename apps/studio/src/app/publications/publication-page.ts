import { DOCUMENT } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import {
  PUBLICATION_LIMITS,
  REPORT_REASONS,
  type PublicationDetail,
  type ReportReason,
} from '@shadergrove/shared/publication';
import { ApiError } from '../api/shader-api';
import { AuthPrompt } from '../auth/auth-prompt';
import { AuthService } from '../auth/auth.service';
import { I18n } from '../i18n/i18n';
import type { TranslationKey } from '../i18n/keys';
import { TranslatePipe } from '../i18n/translate.pipe';
import { ShaderStore } from '../workspace/shader-store';
import { ExploreBrowseState } from './explore-browse-state';
import { PAGE_STYLES, serverState } from './page';
import { PublicationApi } from './publication-api';
import { PublicationPreview } from './publication-preview';

type State = 'loading' | 'ready' | 'missing' | 'error';

/**
 * `/explore/:publicationId`: one public shader, at a URL that stays the same
 * for as long as it is published. Readable by anyone; copying and reporting
 * ask for a verified account only when they are actually used.
 *
 * Looking at a shader here does not open it: the library and the editor stay
 * exactly as they were. "Copy to my library" is the one way across, and it
 * produces a new private shader rather than touching an existing one.
 */
@Component({
  selector: 'app-publication-page',
  imports: [
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    PublicationPreview,
    RouterLink,
    TranslatePipe,
  ],
  template: `
    <header class="page-bar">
      <a matButton routerLink="/explore" [queryParams]="back()">
        <mat-icon>arrow_back</mat-icon>
        {{ 'explore.title' | translate }}
      </a>
    </header>

    <main [attr.aria-busy]="state() === 'loading'">
      @switch (state()) {
        @case ('loading') {
          <mat-progress-bar
            mode="indeterminate"
            [attr.aria-label]="'explore.loading' | translate"
          />
        }
        @case ('missing') {
          <p class="status">{{ 'explore.notFound' | translate }}</p>
        }
        @case ('error') {
          <p class="status" role="alert">
            {{ 'explore.loadError' | translate }}
            <button matButton="tonal" type="button" (click)="load()">
              {{ 'explore.retry' | translate }}
            </button>
          </p>
        }
        @case ('ready') {
          @let item = publication()!;
          <article>
            <div class="frame">
              @if (running()) {
                <app-publication-preview class="fill" [publication]="item" />
              } @else if (item.hasThumbnail) {
                <img class="fill" alt="" [src]="api.thumbnailUrl(item)" />
              }
              <button
                matButton="filled"
                type="button"
                class="run"
                [attr.aria-pressed]="running()"
                (click)="running.set(!running())"
              >
                <mat-icon>{{ running() ? 'stop' : 'play_arrow' }}</mat-icon>
                {{ (running() ? 'explore.stopPreview' : 'explore.runPreview') | translate }}
              </button>
            </div>

            <h1>{{ item.title }}</h1>
            <p class="byline">
              {{ 'explore.by' | translate: { author: item.authorLabel } }} ·
              {{ 'explore.license' | translate: { license: item.license } }} ·
              {{ 'explore.updated' | translate: { date: updated() } }}
            </p>
            @if (item.description) {
              <p>{{ item.description }}</p>
            }
            @if (item.attribution) {
              <p class="credits">
                {{ 'explore.credits' | translate: { text: item.attribution } }}
              </p>
            }
            @if (item.derivedFrom; as source) {
              <p class="credits">
                <a [routerLink]="['/explore', source.publicationId]">{{
                  'explore.basedOn'
                    | translate
                      : {
                          title: source.title,
                          author: source.authorLabel,
                          license: source.license,
                        }
                }}</a>
                {{ source.attribution }}
              </p>
            }

            <div class="actions">
              <button matButton="filled" type="button" [disabled]="busy()" (click)="copy()">
                <mat-icon>content_copy</mat-icon>
                {{ 'explore.copy' | translate }}
              </button>
              <button matButton type="button" (click)="copyLink()">
                <mat-icon>link</mat-icon>
                {{ 'explore.copyLink' | translate }}
              </button>
              <a matButton download [href]="api.exportUrl(item.id)">
                <mat-icon>download</mat-icon>
                {{ 'explore.download' | translate }}
              </a>
              <button
                matButton
                type="button"
                [attr.aria-expanded]="reporting()"
                (click)="toggleReport()"
              >
                <mat-icon>flag</mat-icon>
                {{ 'explore.report' | translate }}
              </button>
            </div>
            <p class="hint">{{ 'explore.copyHint' | translate }}</p>

            @if (reporting()) {
              <form class="report" (submit)="report($event, reason.value, body.value)">
                <mat-form-field appearance="outline">
                  <mat-label>{{ 'explore.reportReason' | translate }}</mat-label>
                  <select matNativeControl #reason>
                    @for (option of reasons; track option) {
                      <option [value]="option">{{ reasonLabels[option] | translate }}</option>
                    }
                  </select>
                </mat-form-field>
                <mat-form-field appearance="outline">
                  <mat-label>{{ 'explore.reportBody' | translate }}</mat-label>
                  <textarea matInput #body rows="3" [maxLength]="reportLength"></textarea>
                </mat-form-field>
                <button matButton="tonal" type="submit" [disabled]="busy()">
                  {{ 'explore.reportSend' | translate }}
                </button>
              </form>
            }
            @if (message(); as text) {
              <p class="message" role="status">{{ text }}</p>
            }
          </article>
        }
      }
    </main>
  `,
  styles: [
    PAGE_STYLES,
    `
      /* Bounded on purpose: the preview never renders larger than this frame. */
      .frame {
        position: relative;
        width: min(100%, 960px);
        aspect-ratio: 16 / 9;
        overflow: hidden;
        border-radius: var(--mat-sys-corner-medium);
        background: #0b0b0c;
      }

      .fill {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      .run {
        position: absolute;
        bottom: 12px;
        left: 12px;
      }

      article h1 {
        margin: 20px 0 4px;
        font: var(--mat-sys-headline-small);
      }

      .byline,
      .credits,
      .hint {
        color: var(--mat-sys-on-surface-variant);
        font: var(--mat-sys-body-medium);
      }

      .byline {
        margin: 0 0 12px;
      }

      .credits a {
        color: var(--mat-sys-primary);
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 20px;
      }

      .hint {
        margin: 8px 0 0;
        font: var(--mat-sys-body-small);
      }

      .report {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 4px;
        max-width: 480px;
        margin-top: 16px;
      }

      .report mat-form-field {
        width: 100%;
      }

      .message {
        margin: 16px 0 0;
        font: var(--mat-sys-body-medium);
      }
    `,
  ],
})
export class PublicationPage {
  protected readonly api = inject(PublicationApi);
  private readonly auth = inject(AuthService);
  private readonly prompt = inject(AuthPrompt);
  private readonly store = inject(ShaderStore);
  private readonly router = inject(Router);
  private readonly i18n = inject(I18n);
  private readonly document = inject(DOCUMENT);
  private readonly rendered = serverState<PublicationDetail>('publication');
  private readonly browse = inject(ExploreBrowseState);

  protected readonly reasons = REPORT_REASONS;
  protected readonly reasonLabels: Record<ReportReason, TranslationKey> = {
    copyright: 'explore.reason.copyright',
    inappropriate: 'explore.reason.inappropriate',
    spam: 'explore.reason.spam',
    other: 'explore.reason.other',
  };
  protected readonly reportLength = PUBLICATION_LIMITS.reportBodyLength;

  protected readonly state = signal<State>('loading');
  protected readonly publication = signal<PublicationDetail | null>(null);
  protected readonly running = signal(false);
  protected readonly reporting = signal(false);
  protected readonly busy = signal(false);
  protected readonly message = signal<string | null>(null);
  protected readonly updated = computed(() =>
    new Date(this.publication()?.updatedAt ?? 0).toLocaleDateString(this.i18n.locale()),
  );

  /** The search this visit came from; opened directly there is none, and the link is plain `/explore`. */
  protected readonly back = computed(() => {
    const q = this.browse.returnQuery();
    return q ? { q } : {};
  });

  private id = '';

  constructor() {
    // One component serves every id: following a "based on" link changes the
    // parameter, not the page.
    inject(ActivatedRoute)
      .paramMap.pipe(takeUntilDestroyed())
      .subscribe((params) => {
        this.id = params.get('publicationId') ?? '';
        const rendered = this.rendered.take();
        if (rendered?.id === this.id) this.show(rendered);
        else {
          void this.load().then(() => {
            const loaded = this.publication();
            if (loaded) this.rendered.put(loaded);
          });
        }
      });
  }

  protected async load(): Promise<void> {
    const id = this.id;
    // Whatever was running belonged to the previous shader.
    this.running.set(false);
    this.reporting.set(false);
    this.message.set(null);
    this.state.set('loading');
    try {
      const publication = await this.api.read(id);
      if (id === this.id) this.show(publication);
    } catch (error) {
      if (id !== this.id) return;
      this.publication.set(null);
      this.state.set(error instanceof ApiError && error.status === 404 ? 'missing' : 'error');
    }
  }

  private show(publication: PublicationDetail): void {
    this.publication.set(publication);
    this.state.set('ready');
  }

  protected async copy(): Promise<void> {
    if (!this.signedIn()) return;
    await this.act(async () => {
      const shader = await this.api.copy(this.id);
      await this.store.refreshList();
      this.store.notice.set({
        text: this.i18n.t('explore.copied', { name: shader.name }),
        error: false,
      });
      // The editor's own route: if the open shader has unsaved changes, it
      // asks before switching, and cancelling keeps them.
      await this.router.navigateByUrl(`/shaders/${encodeURIComponent(shader.id)}`);
    });
  }

  protected toggleReport(): void {
    if (!this.reporting() && !this.signedIn()) return;
    this.reporting.update((open) => !open);
  }

  protected async report(event: Event, reason: string, body: string): Promise<void> {
    event.preventDefault();
    await this.act(async () => {
      await this.api.report(this.id, { reason: reason as ReportReason, body });
      this.reporting.set(false);
      this.message.set(this.i18n.t('explore.reported'));
    });
  }

  protected async copyLink(): Promise<void> {
    const link = `${this.document.location.origin}/explore/${this.id}`;
    try {
      await navigator.clipboard.writeText(link);
      this.message.set(this.i18n.t('explore.linkCopied'));
    } catch {
      // No clipboard permission: show the link so it can be copied by hand.
      this.message.set(link);
    }
  }

  /** Opens the right dialog and answers `false` when the visitor cannot write yet. */
  private signedIn(): boolean {
    if (!this.auth.authenticated()) this.prompt.requestSignIn();
    else if (!this.auth.verified()) this.prompt.request({ mode: 'verify-email' });
    else return true;
    return false;
  }

  private async act(work: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.message.set(null);
    try {
      await work();
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      // A session that ended while the page was open: ask for it back, keep the page.
      if (status === 401) this.prompt.requestSignIn();
      else if (status === 404) this.state.set('missing');
      else {
        const known: Record<number, TranslationKey> = {
          409: 'explore.alreadyReported',
          429: 'explore.rateLimited',
        };
        this.message.set(
          known[status]
            ? this.i18n.t(known[status])
            : error instanceof ApiError
              ? error.summary
              : String(error),
        );
      }
    } finally {
      this.busy.set(false);
    }
  }
}
