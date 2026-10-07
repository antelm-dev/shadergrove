import { isPlatformServer } from '@angular/common';
import {
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  PLATFORM_ID,
  afterNextRender,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import {
  PUBLICATION_LIMITS,
  type PublicationPage,
  type PublicationSummary,
} from '@shadergrove/shared/publication';
import { ApiError } from '../api/shader-api';
import { TranslatePipe } from '../i18n/translate.pipe';
import { ExploreBrowseState } from './explore-browse-state';
import { PAGE_STYLES, serverState } from './page';
import { PublicationApi } from './publication-api';

type State = 'loading' | 'ready' | 'error' | 'unavailable';

/** What the server rendered, and for which search: a page for any other `q` is not this page's. */
interface RenderedSearch {
  query: string;
  page: PublicationPage;
}

/**
 * `/explore`: every public shader, newest first, for anyone — no session, no
 * sign-in prompt. The cards are static thumbnails; nothing is compiled or
 * rendered until a visitor opens one and asks for its preview.
 *
 * The address is the search: `?q=` decides what is listed, so a search can be
 * shared, reloaded and walked back through. Opening a publication and returning
 * brings back the search, every page loaded so far and the scroll position
 * (`ExploreBrowseState`) without asking the server again.
 */
@Component({
  selector: 'app-explore-page',
  imports: [MatButtonModule, MatIconModule, MatProgressBarModule, RouterLink, TranslatePipe],
  template: `
    <header class="page-bar">
      <a matButton routerLink="/">
        <mat-icon>arrow_back</mat-icon>
        {{ 'explore.backToEditor' | translate }}
      </a>
      <h1>{{ 'explore.title' | translate }}</h1>
      <form class="search" role="search" (submit)="search($event, input)">
        <mat-icon aria-hidden="true">search</mat-icon>
        <input
          #input
          type="search"
          autocomplete="off"
          [maxLength]="searchLength"
          [placeholder]="'explore.search' | translate"
          [attr.aria-label]="'explore.search' | translate"
          [value]="query()"
        />
      </form>
    </header>

    <main [attr.aria-busy]="state() === 'loading'">
      @switch (state()) {
        @case ('unavailable') {
          <p class="status">{{ 'explore.unavailable' | translate }}</p>
        }
        @case ('error') {
          <p class="status" role="alert">
            {{ 'explore.loadError' | translate }}
            <button matButton="tonal" type="button" (click)="load(null)">
              {{ 'explore.retry' | translate }}
            </button>
          </p>
        }
        @default {
          @if (state() === 'ready' && publications().length === 0) {
            <p class="status">{{ (query() ? 'explore.noMatch' : 'explore.empty') | translate }}</p>
          }
          <ul class="cards" [attr.aria-label]="'explore.title' | translate" (click)="scrolled()">
            @for (item of publications(); track item.id) {
              <li>
                <a class="card" [routerLink]="['/explore', item.id]">
                  @if (item.hasThumbnail) {
                    <img class="thumb" loading="lazy" alt="" [src]="api.thumbnailUrl(item)" />
                  } @else {
                    <span class="thumb thumb-empty" aria-hidden="true">
                      <mat-icon>blur_on</mat-icon>
                    </span>
                  }
                  <span class="card-title">{{ item.title }}</span>
                  <span class="card-meta">
                    {{ 'explore.by' | translate: { author: item.authorLabel } }} ·
                    {{ item.license }}
                  </span>
                </a>
              </li>
            }
          </ul>
          @if (state() === 'loading') {
            <mat-progress-bar
              mode="indeterminate"
              [attr.aria-label]="'explore.loading' | translate"
            />
          } @else if (nextCursor(); as cursor) {
            <button matButton="tonal" type="button" class="more" (click)="load(cursor)">
              {{ 'explore.loadMore' | translate }}
            </button>
          }
        }
      }
    </main>
  `,
  host: { '(scroll)': 'scrolled()' },
  styles: [
    PAGE_STYLES,
    `
      .search {
        display: flex;
        flex: 1 1 220px;
        align-items: center;
        gap: 6px;
        max-width: 420px;
        height: 36px;
        margin-inline-start: auto;
        padding: 0 10px;
        border-radius: var(--mat-sys-corner-full);
        background: color-mix(in srgb, var(--mat-sys-on-surface) 8%, transparent);
      }

      .search:focus-within {
        box-shadow: inset 0 0 0 1px var(--mat-sys-primary);
      }

      .search input {
        flex: 1;
        min-width: 0;
        border: 0;
        outline: none;
        background: transparent;
        color: inherit;
        font: var(--mat-sys-body-medium);
      }

      .cards {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: 16px;
        margin: 0 0 20px;
        padding: 0;
        list-style: none;
      }

      .card {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 8px;
        border-radius: var(--mat-sys-corner-medium);
        color: inherit;
        text-decoration: none;
      }

      .card:hover {
        background: color-mix(in srgb, var(--mat-sys-on-surface) 7%, transparent);
      }

      .card:focus-visible {
        outline: 2px solid var(--mat-sys-primary);
      }

      .thumb {
        width: 100%;
        aspect-ratio: 16 / 9;
        margin-bottom: 4px;
        border-radius: var(--mat-sys-corner-small);
        object-fit: cover;
        background: color-mix(in srgb, var(--mat-sys-on-surface) 8%, transparent);
      }

      .thumb-empty {
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--mat-sys-on-surface-variant);
      }

      .card-title {
        overflow: hidden;
        font: var(--mat-sys-title-small);
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .card-meta {
        color: var(--mat-sys-on-surface-variant);
        font: var(--mat-sys-body-small);
      }
    `,
  ],
})
export class ExplorePage {
  protected readonly api = inject(PublicationApi);
  private readonly browse = inject(ExploreBrowseState);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly injector = inject(Injector);
  private readonly onServer = isPlatformServer(inject(PLATFORM_ID));
  /** The scrolling element: this page's host, which the window and the router know nothing about. */
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly firstPage = serverState<RenderedSearch>('explore');

  protected readonly searchLength = PUBLICATION_LIMITS.searchLength;
  protected readonly state = signal<State>('loading');
  protected readonly query = signal('');
  protected readonly publications = signal<readonly PublicationSummary[]>([]);
  protected readonly nextCursor = signal<string | null>(null);

  /** The latest request wins: a slow page for an old search must not land on a new one. */
  private generation = 0;
  private opened = false;
  /**
   * Whether `scrollTop` is the visitor's own position in the listing. Off while the list is
   * empty or being put back, when the browser clamps the scroll to the top and reports it.
   */
  private tracking = false;

  constructor() {
    // One component serves every search: Back, Forward and a typed address change `q`, not the page.
    this.route.queryParamMap
      .pipe(takeUntilDestroyed())
      .subscribe((params) => this.follow(params.get('q')));
    inject(DestroyRef).onDestroy(() => {
      this.generation += 1;
      this.tracking = false;
    });
  }

  protected search(event: Event, input: HTMLInputElement): void {
    event.preventDefault();
    const query = this.browse.normalize(input.value);
    input.value = query;
    if (query === this.query()) {
      // The same search again is a refresh, not a new place in the history.
      this.browse.forget(query);
      void this.load(null);
      return;
    }
    // One history entry per submitted search; `follow` loads it once the address has changed.
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { q: query || null },
      queryParamsHandling: 'merge',
    });
  }

  /** Notes where the listing is scrolled to, for the next time this search is shown. */
  protected scrolled(): void {
    if (this.tracking) this.browse.scrolled(this.query(), this.host.scrollTop);
  }

  /** Loads the page after `cursor`, or starts over from the top when there is none. */
  protected async load(cursor: string | null): Promise<void> {
    const generation = ++this.generation;
    const query = this.query();
    const shown = cursor ? this.publications() : [];
    if (!cursor) this.tracking = false;
    this.publications.set(shown);
    this.state.set('loading');
    try {
      const page = await this.api.list(query, cursor);
      if (generation !== this.generation) return;
      this.show(page, shown);
      this.tracking = true;
      this.keep(cursor ? this.host.scrollTop : 0);
    } catch (error) {
      if (generation !== this.generation) return;
      // The routes do not exist on a server with Explore turned off.
      const off = error instanceof ApiError && error.status === 404;
      this.state.set(off ? 'unavailable' : 'error');
    }
  }

  private follow(raw: string | null): void {
    const query = this.browse.normalize(raw);
    // `?q=%20x%20`, `?q=`: tidy the address in place rather than add an entry for it.
    if (!this.onServer && raw !== null && (query === '' || query !== raw)) {
      void this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { q: query || null },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      });
    }
    if (this.opened && query === this.query()) return;

    const first = !this.opened;
    this.opened = true;
    // Before anything changes: where the search being left is scrolled to.
    if (!first) this.scrolled();
    this.generation += 1;
    this.tracking = false;
    this.query.set(query);
    if (!this.onServer) this.browse.returnQuery.set(query);

    const rendered = first ? this.firstPage.take() : null;
    const kept = this.browse.recall(query);
    if (rendered?.query === query) {
      this.show(rendered.page, []);
      this.tracking = true;
      this.keep(0);
    } else if (kept) {
      this.publications.set(kept.publications);
      this.nextCursor.set(kept.nextCursor);
      this.state.set('ready');
      this.restore(kept.scrollTop);
    } else {
      void this.load(null).then(() => (first ? this.publishFirstPage(query) : undefined));
    }
  }

  /** Scrolls to where the visitor was, once the kept cards are on screen. */
  private restore(scrollTop: number): void {
    const generation = this.generation;
    afterNextRender(
      {
        write: () => {
          // A newer search owns the list now.
          if (generation !== this.generation) return;
          this.host.scrollTop = scrollTop;
          this.tracking = true;
        },
      },
      { injector: this.injector },
    );
  }

  private show(page: PublicationPage, before: readonly PublicationSummary[]): void {
    this.publications.set([...before, ...page.publications]);
    this.nextCursor.set(page.nextCursor);
    this.state.set('ready');
  }

  /** A completed listing only: never a loading or failed one. */
  private keep(scrollTop: number): void {
    this.browse.remember(this.query(), {
      publications: this.publications(),
      nextCursor: this.nextCursor(),
      scrollTop,
    });
  }

  private publishFirstPage(query: string): void {
    if (this.state() !== 'ready' || this.query() !== query) return;
    this.firstPage.put({
      query,
      page: { publications: [...this.publications()], nextCursor: this.nextCursor() },
    });
  }
}
