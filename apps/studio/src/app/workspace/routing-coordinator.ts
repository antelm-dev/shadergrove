import { Location } from '@angular/common';
import { Injectable, afterNextRender, computed, effect, inject, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';

import { AuthService } from '../auth/auth.service';
import { isOutputWindow } from '../output-mode';
import { I18n } from '../i18n/i18n';
import { WorkspaceActions } from '../ui/workspace-actions';
import { ShaderStore } from './shader-store';

/**
 * Keeps the URL and the selected shader in sync: `/shaders/:id` for whatever
 * is selected, `/` otherwise, in both directions — following a link updates
 * the selection, and picking a shader in the browser updates the URL.
 *
 * Self-starting, the same way `ShaderStore` is: nothing outside this class
 * needs to call anything for routing to come alive, except reading
 * `routeShaderId()` once, before hydration, for the SSR snapshot.
 */
const STANDALONE_PAGE = /^\/(?:desktop\/connect|explore|admin|plugins)(?:[/?#]|$)/;

@Injectable({ providedIn: 'root' })
export class RoutingCoordinator {
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly store = inject(ShaderStore);
  private readonly workspace = inject(WorkspaceActions);
  private readonly i18n = inject(I18n);
  private readonly auth = inject(AuthService);

  private routingReady = false;

  /** Whose library is on screen; `undefined` until the session first resolves. */
  private owner: string | null | undefined;

  constructor() {
    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => {
        if (this.routingReady) void this.applyRoute();
      });

    effect(() => {
      const id = this.store.selectedId();
      if (!this.routingReady || this.onStandalonePage()) return;
      const canonical = id ? `/shaders/${encodeURIComponent(id)}` : '/';
      if (this.router.url !== canonical) void this.router.navigateByUrl(canonical);
    });

    // `undefined` while the session is being resolved, so the effect only ever
    // sees an answer. The desktop never resolves one and stays out of this.
    const identity = computed(() =>
      this.auth.status() === 'loading' ? undefined : (this.auth.user()?.id ?? null),
    );
    effect(() => {
      const user = identity();
      if (user !== undefined) untracked(() => void this.followIdentity(user));
    });

    if (!isOutputWindow()) afterNextRender(() => void this.initializeRouting());
  }

  /**
   * The library was loaded once, with whatever cookie the page started with.
   * Signing in changes that answer without a reload, so the library follows:
   * the same account coming back after an expiry keeps its open document and
   * draft, a different one never sees the previous account's shaders.
   *
   * Losing the session is deliberately not acted on here — a `401` must not
   * cost unsaved work. An explicit sign-out closes the library itself, behind
   * the unsaved-changes guard (`WorkspaceActions.signOut`).
   */
  private async followIdentity(user: string | null): Promise<void> {
    const owner = this.owner;
    if (owner === undefined) {
      // The first answer: `initializeRouting` is already loading for it.
      this.owner = user;
      return;
    }
    if (user === null) return;

    this.owner = user;
    if (owner !== null && owner !== user) this.store.closeLibrary();
    await this.store.reloadLibrary();
    await this.workspace.resolveStaleRecovery();
  }

  routeShaderId(): string | null {
    // Startup reads this before the router's initial navigation has even begun, while
    // `router.url` is still `/`: until then, the address the app was opened at is the route.
    const url = this.router.navigated ? this.router.url : this.location.path();
    const match = /^\/shaders\/([^/?#]+)\/?(?:[?#].*)?$/.exec(url);
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return null;
    }
  }

  private async initializeRouting(): Promise<void> {
    const requested = this.routeShaderId();
    await this.store.initializeClient(requested);
    this.routingReady = true;
    await this.normalizeRoute(requested);
    await this.workspace.resolveStaleRecovery();
    await this.workspace.resolveFirstRunMigration();
  }

  private async applyRoute(): Promise<void> {
    if (this.onStandalonePage()) return;
    const requested = this.routeShaderId();
    if (!requested) {
      await this.normalizeRoute(null);
      return;
    }
    if (!this.store.shaders().some((shader) => shader.id === requested)) {
      this.store.notice.set({
        text: this.i18n.t('notice.shaderNotFound', { name: requested }),
        error: true,
      });
      await this.normalizeRoute(requested);
      return;
    }
    const changed = await this.workspace.selectShader(requested);
    if (!changed) await this.router.navigateByUrl(this.canonicalUrl(), { replaceUrl: true });
    else await this.workspace.resolveStaleRecovery();
  }

  private async normalizeRoute(requested: string | null): Promise<void> {
    if (this.onStandalonePage()) return;
    const canonical = this.canonicalUrl();
    if (this.router.url !== canonical || requested !== this.store.selectedId()) {
      await this.router.navigateByUrl(canonical, { replaceUrl: true });
    }
  }

  /**
   * Pages of their own, not views of the selection, so they must not be
   * normalized to `/`: `/desktop/connect`, where the desktop's sign-in handoff
   * runs, and the public Explore and moderation pages. The selection carries
   * on underneath them untouched — which is what keeps an unsaved shader safe
   * while its author is off browsing.
   */
  private onStandalonePage(): boolean {
    // A lazily loaded page is not `router.url` until its chunk has arrived, but the
    // navigation in flight already names it — and must not be normalized away meanwhile.
    // Read the navigation as a snapshot: tracking this signal would retrigger the
    // selection effect on its own navigations and keep redirecting indefinitely.
    const target = untracked(() => this.router.currentNavigation())?.extractedUrl.toString();
    return (
      STANDALONE_PAGE.test(this.router.url) ||
      (target !== undefined && STANDALONE_PAGE.test(target))
    );
  }

  private canonicalUrl(): string {
    const id = this.store.selectedId();
    return id ? `/shaders/${encodeURIComponent(id)}` : '/';
  }
}
