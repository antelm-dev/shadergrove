import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PUBLICATION_LIMITS, type PublicationSummary } from '@shadergrove/shared/publication';
import {
  ExploreBrowseState,
  SNAPSHOT_LIMIT,
  SNAPSHOT_TTL_MS,
  addressOf,
  type ExploreSearch,
} from './explore-browse-state';

const updated = (query: string): ExploreSearch => ({ query, sort: 'updated' });
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
    state.remember(updated('aurora'), snapshot('a', 40));
    state.remember(updated(''), snapshot('all'));

    expect(state.recall(updated('aurora'))).toMatchObject({
      publications: [card('a')],
      scrollTop: 40,
    });
    expect(state.recall(updated(''))?.publications).toEqual([card('all')]);
    expect(state.recall(updated('bloom'))).toBeNull();

    state.scrolled(updated('aurora'), 90);
    expect(state.recall(updated('aurora'))?.scrollTop).toBe(90);
    // Scrolling a search nobody loaded does not conjure it.
    state.scrolled(updated('bloom'), 10);
    expect(state.recall(updated('bloom'))).toBeNull();
  });

  it('takes only the orders the API knows, and anything else as recently updated', () => {
    const state = create();
    expect(state.normalizeSort('published')).toBe('published');
    expect(state.normalizeSort('updated')).toBe('updated');
    expect(state.normalizeSort('Published')).toBe('updated');
    expect(state.normalizeSort('')).toBe('updated');
    expect(state.normalizeSort(null)).toBe('updated');
  });

  it('writes the default order and an empty search as a plain address', () => {
    expect(addressOf(updated(''))).toEqual({ q: null, sort: null });
    expect(addressOf({ query: 'aurora', sort: 'published' })).toEqual({
      q: 'aurora',
      sort: 'published',
    });
  });

  it('keeps the two orders of one search apart, cursors included', () => {
    const state = create();
    const published: ExploreSearch = { query: 'aurora', sort: 'published' };
    state.remember(updated('aurora'), { ...snapshot('u', 40), nextCursor: 'cu' });
    expect(state.recall(published)).toBeNull();

    state.remember(published, { ...snapshot('p', 10), nextCursor: 'cp' });
    expect(state.recall(updated('aurora'))).toMatchObject({
      publications: [card('u')],
      nextCursor: 'cu',
      scrollTop: 40,
    });
    expect(state.recall(published)).toMatchObject({
      publications: [card('p')],
      nextCursor: 'cp',
      scrollTop: 10,
    });

    state.scrolled(published, 70);
    state.forget(updated('aurora'));
    expect(state.recall(updated('aurora'))).toBeNull();
    expect(state.recall(published)?.scrollTop).toBe(70);
  });

  it('holds three searches and lets go of the one least recently used', () => {
    const state = create();
    for (const query of ['a', 'b', 'c']) state.remember(updated(query), snapshot(query));
    expect(SNAPSHOT_LIMIT).toBe(3);

    // Looking at "a" again makes "b" the oldest.
    expect(state.recall(updated('a'))).not.toBeNull();
    state.remember(updated('d'), snapshot('d'));

    expect(state.recall(updated('b'))).toBeNull();
    expect(['a', 'c', 'd'].map((query) => state.recall(updated(query)) !== null)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('expires a search five minutes after it was fetched, whatever happened since', () => {
    const state = create();
    state.remember(updated('aurora'), snapshot('a'));

    vi.advanceTimersByTime(SNAPSHOT_TTL_MS - 1);
    state.scrolled(updated('aurora'), 300);
    expect(state.recall(updated('aurora'))?.scrollTop).toBe(300);

    // Scrolling and recalling are not a fetch: the clock did not restart.
    vi.advanceTimersByTime(2);
    expect(state.recall(updated('aurora'))).toBeNull();

    // A new completed fetch starts it over.
    state.remember(updated('aurora'), snapshot('a'));
    vi.advanceTimersByTime(SNAPSHOT_TTL_MS - 1);
    expect(state.recall(updated('aurora'))).not.toBeNull();
  });

  it('forgets a search on request', () => {
    const state = create();
    state.remember(updated('aurora'), snapshot('a'));
    state.forget(updated('aurora'));
    expect(state.recall(updated('aurora'))).toBeNull();
  });

  it('keeps nothing on the server, where one instance could be seen by the next request', () => {
    const state = create('server');
    state.remember(updated('aurora'), snapshot('a'));
    expect(state.recall(updated('aurora'))).toBeNull();
  });
});
