import { isPlatformBrowser } from '@angular/common';
import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';

import { PUBLICATION_LIMITS, type PublicationSummary } from '@shadergrove/shared/publication';

/** At most this many searches are kept, least recently used out first. */
export const SNAPSHOT_LIMIT = 3;
/** How long after its fetch completed a search is still shown instead of fetched again. */
export const SNAPSHOT_TTL_MS = 5 * 60 * 1000;

/**
 * The one ordering the listing has today (`updatedAt`, newest first). It is part of the
 * cache key so a future sort selector cannot be served another ordering's pages.
 */
const ORDER = 'updated';

/** A finished Explore search: what was loaded, where the next page starts, and how far it was scrolled. */
export interface ExploreSnapshot {
  readonly publications: readonly PublicationSummary[];
  readonly nextCursor: string | null;
  readonly scrollTop: number;
}

interface Entry extends ExploreSnapshot {
  readonly fetchedAt: number;
}

/**
 * What the browser remembers of Explore between visits to a publication.
 *
 * Public summaries only, in memory only: nothing here outlives the tab, reaches
 * `localStorage` or crosses from the server into the page. Opening a publication
 * and coming back restores the same search, every page loaded so far and the
 * scroll position, while an old or evicted search simply loads again.
 *
 * Inert on the server. A root service is per-request there already; refusing to
 * hold anything makes that a guarantee rather than an accident.
 */
@Injectable({ providedIn: 'root' })
export class ExploreBrowseState {
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  /** Oldest first: the first key is the next to go. */
  private readonly entries = new Map<string, Entry>();

  /** The search last browsed, so a publication page can link back to it. Empty: the unfiltered list. */
  readonly returnQuery = signal('');

  /** The URL's `q` as Explore searches with it: trimmed, no longer than the API accepts. */
  normalize(raw: string | null | undefined): string {
    return (raw ?? '').trim().slice(0, PUBLICATION_LIMITS.searchLength).trim();
  }

  /** The completed search for `query`, or `null` when there is none or it has expired. */
  recall(query: string): ExploreSnapshot | null {
    const key = keyOf(query);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > SNAPSHOT_TTL_MS) {
      this.entries.delete(key);
      return null;
    }
    // Used: it is now the last to be evicted.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  /** Keeps a search whose fetch has just completed; its five minutes start now. */
  remember(query: string, snapshot: ExploreSnapshot): void {
    if (!this.browser) return;
    const key = keyOf(query);
    this.entries.delete(key);
    this.entries.set(key, { ...snapshot, fetchedAt: Date.now() });
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= SNAPSHOT_LIMIT) break;
      this.entries.delete(oldest);
    }
  }

  /** Records where a kept search is scrolled to. Neither extends its life nor adds a search. */
  scrolled(query: string, scrollTop: number): void {
    const key = keyOf(query);
    const entry = this.entries.get(key);
    if (entry) this.entries.set(key, { ...entry, scrollTop });
  }

  forget(query: string): void {
    this.entries.delete(keyOf(query));
  }
}

const keyOf = (query: string) => `${ORDER}\n${query}`;
