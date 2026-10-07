import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PUBLICATION_LIMITS, type PublicationSummary } from '@shadergrove/shared/publication';
import { ExploreBrowseState, SNAPSHOT_LIMIT, SNAPSHOT_TTL_MS } from './explore-browse-state';

const card = (id: string) => ({ id, title: id }) as PublicationSummary;
const snapshot = (id: string, scrollTop = 0) => ({
  publications: [card(id)],
  nextCursor: null,
  scrollTop,
});

function create(platform = 'browser'): ExploreBrowseState {
  TestBed.configureTestingModule({ providers: [{ provide: PLATFORM_ID, useValue: platform }] });
  return TestBed.inject(ExploreBrowseState);
}

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
afterEach(() => {
  vi.useRealTimers();
  TestBed.resetTestingModule();
});

describe('ExploreBrowseState', () => {
  it('normalizes a search the way the API takes it', () => {
    const state = create();
    expect(state.normalize('  aurora ')).toBe('aurora');
    expect(state.normalize('   ')).toBe('');
    expect(state.normalize(null)).toBe('');
    const long = state.normalize(
      `${'a'.repeat(PUBLICATION_LIMITS.searchLength - 1)} ${'b'.repeat(9)}`,
    );
    expect(long).toBe('a'.repeat(PUBLICATION_LIMITS.searchLength - 1));
  });

  it('keeps searches apart, with the pages and place each was left at', () => {
    const state = create();
    state.remember('aurora', snapshot('a', 40));
    state.remember('', snapshot('all'));

    expect(state.recall('aurora')).toMatchObject({ publications: [card('a')], scrollTop: 40 });
    expect(state.recall('')?.publications).toEqual([card('all')]);
    expect(state.recall('bloom')).toBeNull();

    state.scrolled('aurora', 90);
    expect(state.recall('aurora')?.scrollTop).toBe(90);
    // Scrolling a search nobody loaded does not conjure it.
    state.scrolled('bloom', 10);
    expect(state.recall('bloom')).toBeNull();
  });

  it('holds three searches and lets go of the one least recently used', () => {
    const state = create();
    for (const query of ['a', 'b', 'c']) state.remember(query, snapshot(query));
    expect(SNAPSHOT_LIMIT).toBe(3);

    // Looking at "a" again makes "b" the oldest.
    expect(state.recall('a')).not.toBeNull();
    state.remember('d', snapshot('d'));

    expect(state.recall('b')).toBeNull();
    expect(['a', 'c', 'd'].map((query) => state.recall(query) !== null)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('expires a search five minutes after it was fetched, whatever happened since', () => {
    const state = create();
    state.remember('aurora', snapshot('a'));

    vi.advanceTimersByTime(SNAPSHOT_TTL_MS - 1);
    state.scrolled('aurora', 300);
    expect(state.recall('aurora')?.scrollTop).toBe(300);

    // Scrolling and recalling are not a fetch: the clock did not restart.
    vi.advanceTimersByTime(2);
    expect(state.recall('aurora')).toBeNull();

    // A new completed fetch starts it over.
    state.remember('aurora', snapshot('a'));
    vi.advanceTimersByTime(SNAPSHOT_TTL_MS - 1);
    expect(state.recall('aurora')).not.toBeNull();
  });

  it('forgets a search on request', () => {
    const state = create();
    state.remember('aurora', snapshot('a'));
    state.forget('aurora');
    expect(state.recall('aurora')).toBeNull();
  });

  it('keeps nothing on the server, where one instance could be seen by the next request', () => {
    const state = create('server');
    state.remember('aurora', snapshot('a'));
    expect(state.recall('aurora')).toBeNull();
  });
});
