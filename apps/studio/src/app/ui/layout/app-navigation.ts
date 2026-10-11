import { Component, Injectable, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { NavigationEnd, Router, RouterLink, type UrlTree } from '@angular/router';
import { filter, map } from 'rxjs';

import { TranslatePipe } from '../../i18n/translate.pipe';
import { ExploreAccess } from '../../publications/explore-access';
import { ExploreBrowseState, addressOf } from '../../publications/explore-browse-state';
import { ShaderStore } from '../../workspace/shader-store';

/** What a URL puts on screen: the editor, or one of the pages laid over it. */
export type AppSection = 'editor' | 'explore' | 'plugins' | 'admin' | 'connect';

/** The same pages `RoutingCoordinator` leaves alone as standalone; everything else is the editor. */
export function sectionOf(url: string): AppSection {
  const path = url.split(/[?#]/, 1)[0];
  if (/^\/desktop\/connect(?:\/|$)/.test(path)) return 'connect';
  const first = /^\/(explore|plugins|admin)(?:\/|$)/.exec(path)?.[1];
  return (first as AppSection | undefined) ?? 'editor';
}

/**
 * The top bar's Editor / Explore / Plugins links, derived from the route.
 *
 * Read-only over the router: it never navigates, so it cannot fight
 * `RoutingCoordinator`. A section changes only once a navigation has finished,
 * so a lazy page still loading is not yet "here" and the editor stays shown.
 */
@Injectable({ providedIn: 'root' })
export class AppNavigation {
  private readonly router = inject(Router);
  private readonly store = inject(ShaderStore);
  private readonly browse = inject(ExploreBrowseState);

  private readonly arrivals = this.router.events.pipe(
    filter((event) => event instanceof NavigationEnd),
    map(() => this.router.url),
  );
  private readonly url = toSignal(this.arrivals, { initialValue: this.router.url });

  readonly section = computed(() => sectionOf(this.url()));
  /** Whether a page is over the editor, which is then hidden but kept. */
  readonly away = computed(() => this.section() !== 'editor');

  /** The Plugins tab last shown, so coming back reopens it. Followed even while unread. */
  private readonly pluginsTab = toSignal(
    this.arrivals.pipe(
      filter((url) => sectionOf(url) === 'plugins'),
      map((url) => (this.router.parseUrl(url).queryParams['tab'] as string | undefined) ?? null),
    ),
    { initialValue: null },
  );

  /** The selection's canonical address: the same one the coordinator keeps the editor on. */
  readonly editorLink = computed(() => {
    const id = this.store.selectedId();
    return this.router.parseUrl(id ? `/shaders/${encodeURIComponent(id)}` : '/');
  });

  /** The search last browsed; on the listing itself, where it is (a click there is a no-op). */
  readonly exploreLink = computed<UrlTree>(() =>
    /^\/explore(?:[?#]|$)/.test(this.url())
      ? this.router.parseUrl(this.url())
      : this.router.createUrlTree(['/explore'], { queryParams: addressOf(this.browse.returnTo()) }),
  );

  readonly pluginsLink = computed<UrlTree>(() =>
    this.section() === 'plugins'
      ? this.router.parseUrl(this.url())
      : this.router.createUrlTree(['/plugins'], { queryParams: { tab: this.pluginsTab() } }),
  );
}

/**
 * The links themselves, in the toolbar: routed links drawn as tabs rather than
 * an ARIA tablist, since each leads to a page with its own address. Explore is
 * offered only where the server says it exists, which is never on the desktop.
 */
@Component({
  selector: 'app-navigation',
  imports: [MatIconModule, RouterLink, TranslatePipe],
  template: `
    <nav [attr.aria-label]="'toolbar.sections' | translate">
      <a
        data-testid="open-editor"
        [routerLink]="nav.editorLink()"
        [attr.aria-current]="nav.section() === 'editor' ? 'page' : null"
      >
        <mat-icon aria-hidden="true">code</mat-icon>
        <span class="label">{{ 'toolbar.editor' | translate }}</span>
      </a>
      @if (explore().publicExplore) {
        <a
          data-testid="open-explore"
          [routerLink]="nav.exploreLink()"
          [attr.aria-current]="nav.section() === 'explore' ? 'page' : null"
        >
          <mat-icon aria-hidden="true">explore</mat-icon>
          <span class="label">{{ 'explore.title' | translate }}</span>
        </a>
      }
      <a
        data-testid="open-plugins"
        [routerLink]="nav.pluginsLink()"
        [attr.aria-current]="nav.section() === 'plugins' ? 'page' : null"
      >
        <mat-icon aria-hidden="true">extension</mat-icon>
        <span class="label">{{ 'plugins.title' | translate }}</span>
      </a>
    </nav>
  `,
  styles: `
    :host,
    nav {
      display: flex;
      align-self: stretch;
    }

    :host {
      margin-left: 4px;
    }

    a {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding-inline: 10px;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-large);
      text-decoration: none;
      white-space: nowrap;

      &:hover {
        background: color-mix(in srgb, var(--mat-sys-on-surface) 8%, transparent);
        color: var(--mat-sys-on-surface);
      }

      &:focus-visible {
        outline: 2px solid var(--mat-sys-primary);
        outline-offset: -2px;
      }

      &[aria-current='page'] {
        box-shadow: inset 0 -2px 0 var(--mat-sys-primary);
        color: var(--mat-sys-primary);
      }
    }

    mat-icon {
      width: 18px;
      height: 18px;
      font-size: 18px;
    }

    /* The toolbar's own width, as for its other controls: icons alone, the label still the name. */
    @container toolbar (max-width: 900px) {
      a {
        padding-inline: 8px;
      }

      .label {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
      }
    }
  `,
})
export class AppNavigationLinks {
  protected readonly nav = inject(AppNavigation);
  protected readonly explore = inject(ExploreAccess).capabilities;
}
