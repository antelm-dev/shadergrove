import { Location } from '@angular/common';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import {
  Component,
  PLATFORM_ID,
  TransferState,
  makeStateKey,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import type {
  PublicationPage as PublicationPageDto,
  PublicationSummary,
} from '@shadergrove/shared/publication';
import { authInterceptor } from '../auth/auth.interceptor';
import { AuthService } from '../auth/auth.service';
import { DesktopPlatform } from '../desktop/desktop-platform';
import { I18n } from '../i18n/i18n';
import { ShaderStore } from '../workspace/shader-store';
import { ExploreBrowseState, SNAPSHOT_TTL_MS } from './explore-browse-state';
import { ExplorePage } from './explore-page';
import { PublicationPage } from './publication-page';

const summary = (id: string, title = id): PublicationSummary => ({
  id,
  title,
  description: '',
  authorLabel: 'Alice A.',
  license: 'CC-BY-4.0',
  revision: 1,
  publishedAt: '2026-09-30T10:00:00.000Z',
  updatedAt: '2026-09-30T10:00:00.000Z',
  hasThumbnail: true,
});

const page = (ids: string[], nextCursor: string | null = null): PublicationPageDto => ({
  publications: ids.map((id) => summary(id)),
  nextCursor,
});

@Component({ template: '' })
class Blank {}

interface Setup {
  platform?: string;
}

function configure({ platform = 'browser' }: Setup = {}) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(withInterceptors([authInterceptor])),
      provideHttpClientTesting(),
      provideLocationMocks(),
      provideRouter([
        { path: 'explore', component: ExplorePage },
        { path: 'explore/:publicationId', component: PublicationPage },
        { path: '**', component: Blank },
      ]),
      { provide: PLATFORM_ID, useValue: platform },
      { provide: I18n, useValue: { t: (key: string) => key, locale: signal('en') } },
      {
        provide: AuthService,
        useValue: {
          status: signal('anonymous'),
          verified: signal(false),
          user: signal(null),
          authenticated: () => false,
          refresh: async () => undefined,
        },
      },
      { provide: DesktopPlatform, useValue: { available: false } },
      { provide: ShaderStore, useValue: { refreshList: vi.fn(), notice: signal(null) } },
    ],
  });
  return TestBed.inject(HttpTestingController);
}

/** The router with its history listener on, which a test module does not start by itself. */
async function start(options: Setup = {}) {
  const http = configure(options);
  const harness = await RouterTestingHarness.create();
  TestBed.inject(Router).initialNavigation();
  return { http, harness };
}

/** Opens `/explore…` as the router would: a routed page, a real history, the API under test control. */
async function visit(url: string, options: Setup = {}) {
  const { http, harness } = await start(options);
  const explore = await harness.navigateByUrl(url, ExplorePage);
  return { http, harness, explore, location: TestBed.inject(Location) };
}

const listing = (http: HttpTestingController) =>
  http.match((request) => request.url === '/api/publications');

/** The one listing request outstanding, and which search and page it is for. */
function nextRequest(http: HttpTestingController) {
  const [request, ...others] = listing(http);
  if (!request) throw new Error('no listing request was made');
  expect(others, 'one request at a time').toHaveLength(0);
  return {
    search: request.request.params.get('search'),
    sort: request.request.params.get('sort'),
    cursor: request.request.params.get('cursor'),
    flush: (body: PublicationPageDto) => request.flush(body),
    fail: () => request.error(new ProgressEvent('error')),
  };
}

async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  for (let pass = 0; pass < 3; pass += 1) {
    await new Promise((resolve) => setTimeout(resolve));
    fixture.detectChanges();
    await fixture.whenStable();
  }
}

const titles = (fixture: ComponentFixture<unknown>) =>
  [...(fixture.nativeElement as HTMLElement).querySelectorAll('.card-title')].map(
    (entry) => entry.textContent,
  );

const input = (fixture: ComponentFixture<unknown>) =>
  (fixture.nativeElement as HTMLElement).querySelector('input') as HTMLInputElement;

function submit(fixture: ComponentFixture<unknown>, value: string): void {
  const root = fixture.nativeElement as HTMLElement;
  input(fixture).value = value;
  root.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
}

/** The element Explore scrolls: whatever the router put on screen now. */
const scroller = (harness: RouterTestingHarness) => harness.routeNativeElement as HTMLElement;

function scrollTo(harness: RouterTestingHarness, top: number): void {
  const host = scroller(harness);
  host.scrollTop = top;
  host.dispatchEvent(new Event('scroll'));
}

function loadMore(fixture: ComponentFixture<unknown>): void {
  const button = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].find(
    (entry) => entry.textContent?.includes('explore.loadMore'),
  );
  button?.click();
}

const sortBox = (fixture: ComponentFixture<unknown>) =>
  (fixture.nativeElement as HTMLElement).querySelector('select#explore-sort') as HTMLSelectElement;

function chooseSort(fixture: ComponentFixture<unknown>, sort: string): void {
  const box = sortBox(fixture);
  box.value = sort;
  box.dispatchEvent(new Event('change'));
}

function clickButton(fixture: ComponentFixture<unknown>, label: string): void {
  const button = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].find(
    (entry) => entry.textContent?.includes(label),
  );
  if (!button) throw new Error(`no ${label} button`);
  button.click();
}

/**
 * Explore's scroll as a browser keeps it: clamped to how far the list can scroll, which the test
 * sets, and grown in `resize()` the way a late layout grows the list and wakes ResizeObservers.
 */
function laidOutLate() {
  const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  if (!original?.get || !original.set) throw new Error('no scrollTop to stand in for');
  const { get, set } = original;
  const tops = new WeakMap<Element, number>();
  const list = { room: 1000, resize: () => undefined as void };
  const observers = new Set<() => void>();
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element) {
      return this.localName === 'app-explore-page' ? (tops.get(this) ?? 0) : get.call(this);
    },
    set(this: Element, top: number) {
      if (this.localName !== 'app-explore-page') return set.call(this, top);
      tops.set(this, Math.max(0, Math.min(top, list.room)));
    },
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly wake: () => void;
      constructor(callback: () => void) {
        this.wake = () => callback();
      }
      observe() {
        observers.add(this.wake);
      }
      disconnect() {
        observers.delete(this.wake);
      }
    },
  );
  list.resize = () => observers.forEach((wake) => wake());
  onTestFinished(() => {
    Object.defineProperty(Element.prototype, 'scrollTop', original);
    vi.unstubAllGlobals();
  });
  return list;
}

const backLink = (harness: RouterTestingHarness) =>
  (harness.routeNativeElement as HTMLElement).querySelector('a.mat-mdc-button') as HTMLElement;

afterEach(() => TestBed.resetTestingModule());

describe('Explore search address', () => {
  it('lists the unfiltered library when there is no q', async () => {
    const { http, harness } = await visit('/explore');
    const all = nextRequest(http);
    expect(all.search).toBeNull();
    all.flush(page(['a1']));
    await settle(harness.fixture);
    expect(titles(harness.fixture)).toEqual(['a1']);
  });

  it('searches for the q a link carries, and shows it in the box', async () => {
    const { http, harness } = await visit('/explore?q=bloom');
    expect(nextRequest(http).search).toBe('bloom');
    await settle(harness.fixture);
    expect(input(harness.fixture).value).toBe('bloom');
  });

  it('puts a submitted search in the address, one history entry per change and none per keystroke', async () => {
    const { http, harness, location } = await visit('/explore');
    nextRequest(http).flush(page(['a1']));
    await settle(harness.fixture);

    input(harness.fixture).value = 'bl';
    input(harness.fixture).dispatchEvent(new Event('input'));
    await settle(harness.fixture);
    expect(location.path()).toBe('/explore');

    submit(harness.fixture, ' bloom ');
    await settle(harness.fixture);
    expect(location.path()).toBe('/explore?q=bloom');
    expect(input(harness.fixture).value).toBe('bloom');
    const request = nextRequest(http);
    expect(request.search).toBe('bloom');
    expect(request.cursor).toBeNull();
    request.flush(page(['b2']));
    await settle(harness.fixture);
    expect(titles(harness.fixture)).toEqual(['b2']);

    // Back is one step: the unfiltered list, not a half-typed search.
    location.back();
    await settle(harness.fixture);
    expect(location.path()).toBe('/explore');
    expect(input(harness.fixture).value).toBe('');
    expect(titles(harness.fixture)).toEqual(['a1']);
  });

  it('normalizes an untidy address in place, without a second entry or a second request', async () => {
    const { http, harness, location } = await visit('/explore?q=%20%20bloom%20');
    await settle(harness.fixture);
    expect(location.path()).toBe('/explore?q=bloom');
    const request = nextRequest(http);
    expect(request.search).toBe('bloom');
    request.flush(page(['b2']));
    await settle(harness.fixture);
    expect(listing(http)).toHaveLength(0);
  });

  it('drops an empty q from the address', async () => {
    const { http, harness, location } = await visit('/explore?q=');
    await settle(harness.fixture);
    expect(location.path()).toBe('/explore');
    expect(nextRequest(http).search).toBeNull();
  });

  it('caps a q longer than the API accepts', async () => {
    const { http, location, harness } = await visit(`/explore?q=${'x'.repeat(80)}`);
    await settle(harness.fixture);
    expect(location.path()).toBe(`/explore?q=${'x'.repeat(64)}`);
    expect(nextRequest(http).search).toBe('x'.repeat(64));
  });

  it('refreshes rather than navigates when the same search is submitted again', async () => {
    const { http, harness, location } = await visit('/explore?q=bloom');
    nextRequest(http).flush(page(['b2']));
    await settle(harness.fixture);

    submit(harness.fixture, 'bloom ');
    await settle(harness.fixture);
    expect(location.path()).toBe('/explore?q=bloom');
    const request = nextRequest(http);
    expect(request.search).toBe('bloom');
    request.flush(page(['b2', 'b3']));
    await settle(harness.fixture);
    expect(titles(harness.fixture)).toEqual(['b2', 'b3']);
  });

  it('follows the address when the same page is reused for another search', async () => {
    const { http, harness, explore } = await visit('/explore?q=aurora');
    nextRequest(http).flush(page(['a1']));
    await settle(harness.fixture);

    const same = await harness.navigateByUrl('/explore?q=bloom', ExplorePage);
    expect(same).toBe(explore);
    expect(input(harness.fixture).value).toBe('bloom');
    const request = nextRequest(http);
    expect(request.search).toBe('bloom');
    request.flush(page(['b2']));
    await settle(harness.fixture);
    expect(titles(harness.fixture)).toEqual(['b2']);
  });
});

describe('Explore restoration', () => {
  it('shows a search again with every page loaded, its cursor and its scroll, with no request', async () => {
    const { http, harness, location } = await visit('/explore?q=bloom');
    nextRequest(http).flush(page(['b1', 'b2'], 'c2'));
    await settle(harness.fixture);
    loadMore(harness.fixture);
    const more = nextRequest(http);
    expect(more.cursor).toBe('c2');
    more.flush(page(['b3'], 'c3'));
    await settle(harness.fixture);
    scrollTo(harness, 480);

    const card = (harness.fixture.nativeElement as HTMLElement).querySelector(
      '.card',
    ) as HTMLElement;
    card.click();
    await settle(harness.fixture);
    expect(location.path()).toBe('/explore/b1');

    location.back();
    await settle(harness.fixture);
    expect(location.path()).toBe('/explore?q=bloom');
    expect(listing(http)).toHaveLength(0);
    expect(titles(harness.fixture)).toEqual(['b1', 'b2', 'b3']);
    expect(input(harness.fixture).value).toBe('bloom');
    expect(scroller(harness).scrollTop).toBe(480);
    // The cursor came back too: the next page is the one after the last that was shown.
    loadMore(harness.fixture);
    expect(nextRequest(http).cursor).toBe('c3');
  });

  it('puts the scroll back once the list has grown tall enough for it, not where the first frame clamped it', async () => {
    const list = laidOutLate();
    const { http, harness, location } = await visit('/explore?q=bloom');
    nextRequest(http).flush(page(['b1', 'b2', 'b3']));
    await settle(harness.fixture);
    scrollTo(harness, 480);
    (harness.fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('.card')?.click();
    await settle(harness.fixture);

    // On the way back, the first frame lays the cards out in more columns, so fewer rows.
    list.room = 200;
    location.back();
    await settle(harness.fixture);
    expect(scroller(harness).scrollTop).toBe(200);

    list.room = 1000;
    list.resize();
    expect(scroller(harness).scrollTop).toBe(480);
  });

  it('does not take the scroll back from a visitor who moves it while the list settles', async () => {
    const list = laidOutLate();
    const { http, harness, location } = await visit('/explore?q=bloom');
    nextRequest(http).flush(page(['b1', 'b2', 'b3']));
    await settle(harness.fixture);
    scrollTo(harness, 480);
    const open = () =>
      (harness.fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('.card')?.click();
    open();
    await settle(harness.fixture);

    list.room = 200;
    location.back();
    await settle(harness.fixture);
    scrollTo(harness, 50);
    list.room = 1000;
    list.resize();
    expect(scroller(harness).scrollTop).toBe(50);

    // And where the visitor went is what is kept for next time.
    open();
    await settle(harness.fixture);
    location.back();
    await settle(harness.fixture);
    expect(scroller(harness).scrollTop).toBe(50);
  });

  it('does not mix pages when walking back and forward between two searches', async () => {
    const { http, harness, location } = await visit('/explore?q=aurora');
    nextRequest(http).flush(page(['a1', 'a2'], 'ca'));
    await settle(harness.fixture);
    loadMore(harness.fixture);
    nextRequest(http).flush(page(['a3']));
    await settle(harness.fixture);

    await harness.navigateByUrl('/explore?q=bloom', ExplorePage);
    nextRequest(http).flush(page(['b1']));
    await settle(harness.fixture);
    expect(titles(harness.fixture)).toEqual(['b1']);

    location.back();
    await settle(harness.fixture);
    expect(titles(harness.fixture)).toEqual(['a1', 'a2', 'a3']);
    location.forward();
    await settle(harness.fixture);
    expect(titles(harness.fixture)).toEqual(['b1']);
    expect(listing(http)).toHaveLength(0);
  });

  it('asks again once a kept search is five minutes old', async () => {
    const { http, harness, location } = await visit('/explore?q=bloom');
    nextRequest(http).flush(page(['b1']));
    await settle(harness.fixture);
    await harness.navigateByUrl('/explore/b1');

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.advanceTimersByTime(SNAPSHOT_TTL_MS + 1);
    try {
      location.back();
      await settle(harness.fixture);
      const request = nextRequest(http);
      expect(request.search).toBe('bloom');
      // Loading, not a stale list that is replaced a moment later.
      expect(titles(harness.fixture)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never shows or stores a response for a search the visitor has already left', async () => {
    const { http, harness, location } = await visit('/explore?q=aurora');
    const slow = nextRequest(http);

    await harness.navigateByUrl('/explore?q=bloom', ExplorePage);
    const current = nextRequest(http);
    expect(current.search).toBe('bloom');
    current.flush(page(['b1']));
    slow.flush(page(['a-late']));
    await settle(harness.fixture);
    expect(titles(harness.fixture)).toEqual(['b1']);

    // "aurora" never completed, so there is nothing of it to restore: it is fetched.
    location.back();
    await settle(harness.fixture);
    const again = nextRequest(http);
    expect(again.search).toBe('aurora');
    again.flush(page(['a1']));
    await settle(harness.fixture);
    expect(titles(harness.fixture)).toEqual(['a1']);
  });

  it('keeps where the previous search was scrolled when a new search is submitted, for Back', async () => {
    const { http, harness, location } = await visit('/explore?q=aurora');
    nextRequest(http).flush(page(['a1', 'a2', 'a3'], 'ca'));
    await settle(harness.fixture);
    scrollTo(harness, 320);

    submit(harness.fixture, 'bloom');
    await settle(harness.fixture);
    expect(location.path()).toBe('/explore?q=bloom');
    nextRequest(http).flush(page(['b1']));
    await settle(harness.fixture);
    scrollTo(harness, 0);

    location.back();
    await settle(harness.fixture);
    expect(location.path()).toBe('/explore?q=aurora');
    expect(listing(http)).toHaveLength(0);
    expect(titles(harness.fixture)).toEqual(['a1', 'a2', 'a3']);
    expect(scroller(harness).scrollTop).toBe(320);
  });

  it('ignores a page-two response that lands after the search changed', async () => {
    const { http, harness } = await visit('/explore?q=aurora');
    nextRequest(http).flush(page(['a1'], 'ca'));
    await settle(harness.fixture);
    loadMore(harness.fixture);
    const pageTwo = nextRequest(http);

    await harness.navigateByUrl('/explore?q=bloom', ExplorePage);
    nextRequest(http).flush(page(['b1']));
    await settle(harness.fixture);
    pageTwo.flush(page(['a2']));
    await settle(harness.fixture);
    expect(titles(harness.fixture)).toEqual(['b1']);
  });

  it('does not keep a failed search, so coming back tries again', async () => {
    const { http, harness, location } = await visit('/explore?q=bloom');
    nextRequest(http).fail();
    await settle(harness.fixture);
    expect((harness.fixture.nativeElement as HTMLElement).textContent).toContain(
      'explore.loadError',
    );

    await harness.navigateByUrl('/explore/b1');
    location.back();
    await settle(harness.fixture);
    expect(nextRequest(http).search).toBe('bloom');
  });

  it('does not keep what is still loading', async () => {
    const { http, harness, location } = await visit('/explore?q=bloom');
    nextRequest(http);
    await harness.navigateByUrl('/explore/b1');
    // The abandoned response has nowhere to land and nothing to leave behind.
    location.back();
    await settle(harness.fixture);
    expect(nextRequest(http).search).toBe('bloom');
  });
});

describe('Explore order', () => {
  it('lists recently updated by default, with no sort in the address or the request', async () => {
    const { http, harness, location } = await visit('/explore');
    const request = nextRequest(http);
    expect(request.sort).toBeNull();
    request.flush(page(['u1']));
    await settle(harness.fixture);
    expect(location.path()).toBe('/explore');
    expect(sortBox(harness.fixture).value).toBe('updated');
    const label = (harness.fixture.nativeElement as HTMLElement).querySelector(
      'label[for="explore-sort"]',
    );
    expect(label?.textContent?.trim()).toBe('explore.sort');
    expect([...sortBox(harness.fixture).options].map((option) => option.value)).toEqual([
      'updated',
      'published',
    ]);
  });

  it('asks for the q and sort a link carries, and shows both', async () => {
    const { http, harness, location } = await visit('/explore?q=bloom&sort=published');
    const request = nextRequest(http);
    expect(request).toMatchObject({ search: 'bloom', sort: 'published', cursor: null });
    request.flush(page(['p1']));
    await settle(harness.fixture);
    expect(location.path()).toBe('/explore?q=bloom&sort=published');
    expect(input(harness.fixture).value).toBe('bloom');
    expect(sortBox(harness.fixture).value).toBe('published');
  });

  it('replaces an unknown or default sort in the address, adding no history entry', async () => {
    const { http, harness, location } = await visit('/explore?q=aurora');
    nextRequest(http).flush(page(['a1']));
    await settle(harness.fixture);

    await harness.navigateByUrl('/explore?q=bloom&sort=Published', ExplorePage);
    await settle(harness.fixture);
    expect(location.path()).toBe('/explore?q=bloom');
    const request = nextRequest(http);
    expect(request).toMatchObject({ search: 'bloom', sort: null });
    request.flush(page(['b1']));
    await settle(harness.fixture);
    expect(sortBox(harness.fixture).value).toBe('updated');

    location.back();
    await settle(harness.fixture);
    expect(location.path()).toBe('/explore?q=aurora');

    // The default spelled out is the same listing, written the plain way.
    await harness.navigateByUrl('/explore?q=aurora&sort=updated', ExplorePage);
    await settle(harness.fixture);
    expect(location.path()).toBe('/explore?q=aurora');
    expect(listing(http)).toHaveLength(0);
    expect(titles(harness.fixture)).toEqual(['a1']);
  });

  it('pushes one entry per chosen order, from a fresh first page, and walks back to the other intact', async () => {
    const { http, harness, location } = await visit('/explore?q=bloom');
    nextRequest(http).flush(page(['u1', 'u2'], 'cu2'));
    await settle(harness.fixture);
    loadMore(harness.fixture);
    nextRequest(http).flush(page(['u3'], 'cu3'));
    await settle(harness.fixture);
    scrollTo(harness, 300);

    chooseSort(harness.fixture, 'published');
    await settle(harness.fixture);
    expect(location.path()).toBe('/explore?q=bloom&sort=published');
    const first = nextRequest(http);
    // Page one of the new order: no cursor from the other, nothing of it on screen, at the top.
    expect(first).toMatchObject({ search: 'bloom', sort: 'published', cursor: null });
    expect(titles(harness.fixture)).toEqual([]);
    expect(scroller(harness).scrollTop).toBe(0);
    first.flush(page(['p1', 'p2'], 'cp2'));
    await settle(harness.fixture);
    expect(titles(harness.fixture)).toEqual(['p1', 'p2']);
    loadMore(harness.fixture);
    const more = nextRequest(http);
    expect(more).toMatchObject({ sort: 'published', cursor: 'cp2' });
    more.flush(page(['p3']));
    await settle(harness.fixture);

    location.back();
    await settle(harness.fixture);
    expect(location.path()).toBe('/explore?q=bloom');
    expect(listing(http)).toHaveLength(0);
    expect(titles(harness.fixture)).toEqual(['u1', 'u2', 'u3']);
    expect(sortBox(harness.fixture).value).toBe('updated');
    expect(scroller(harness).scrollTop).toBe(300);

    location.forward();
    await settle(harness.fixture);
    expect(location.path()).toBe('/explore?q=bloom&sort=published');
    expect(listing(http)).toHaveLength(0);
    expect(titles(harness.fixture)).toEqual(['p1', 'p2', 'p3']);
    expect(sortBox(harness.fixture).value).toBe('published');

    location.back();
    await settle(harness.fixture);
    loadMore(harness.fixture);
    expect(nextRequest(http)).toMatchObject({ sort: null, cursor: 'cu3' });
  });

  it('lists an order chosen again from its first page rather than from what was kept', async () => {
    const { http, harness, location } = await visit('/explore?sort=published');
    nextRequest(http).flush(page(['p1'], 'cp'));
    await settle(harness.fixture);
    chooseSort(harness.fixture, 'updated');
    await settle(harness.fixture);
    expect(location.path()).toBe('/explore');
    nextRequest(http).flush(page(['u1']));
    await settle(harness.fixture);

    chooseSort(harness.fixture, 'published');
    await settle(harness.fixture);
    expect(location.path()).toBe('/explore?sort=published');
    const again = nextRequest(http);
    expect(again).toMatchObject({ sort: 'published', cursor: null });
    again.flush(page(['p0', 'p1']));
    await settle(harness.fixture);
    expect(titles(harness.fixture)).toEqual(['p0', 'p1']);
  });

  it('never appends or keeps a response for an order the visitor has left', async () => {
    const { http, harness, location } = await visit('/explore?q=bloom');
    nextRequest(http).flush(page(['u1'], 'cu'));
    await settle(harness.fixture);
    loadMore(harness.fixture);
    const pageTwo = nextRequest(http);
    expect(pageTwo.cursor).toBe('cu');

    chooseSort(harness.fixture, 'published');
    await settle(harness.fixture);
    const slowFirst = nextRequest(http);
    expect(slowFirst.sort).toBe('published');

    // Back to updated before published answers: both late pages land on nothing.
    location.back();
    await settle(harness.fixture);
    pageTwo.flush(page(['u-late']));
    slowFirst.flush(page(['p-late']));
    await settle(harness.fixture);
    expect(location.path()).toBe('/explore?q=bloom');
    expect(titles(harness.fixture)).toEqual(['u1']);

    // Published never completed, so it is fetched, not restored from the late answer.
    location.forward();
    await settle(harness.fixture);
    const again = nextRequest(http);
    expect(again).toMatchObject({ sort: 'published', cursor: null });
    again.flush(page(['p1']));
    await settle(harness.fixture);
    expect(titles(harness.fixture)).toEqual(['p1']);
  });

  it('retries a failed listing in the same search and order', async () => {
    const { http, harness } = await visit('/explore?q=bloom&sort=published');
    nextRequest(http).fail();
    await settle(harness.fixture);
    clickButton(harness.fixture, 'explore.retry');
    const retry = nextRequest(http);
    expect(retry).toMatchObject({ search: 'bloom', sort: 'published', cursor: null });
    retry.flush(page(['p1']));
    await settle(harness.fixture);
    expect(titles(harness.fixture)).toEqual(['p1']);
  });

  it('comes back from a publication to the same search, order, pages and scroll, by Back and by its link', async () => {
    const detail = (http: HttpTestingController, id: string) =>
      http
        .expectOne(`/api/publications/${id}`)
        .flush({ publication: { ...summary(id), shader: {} } });
    const { http, harness, location } = await visit('/explore?q=bloom&sort=published');
    nextRequest(http).flush(page(['p1', 'p2'], 'cp2'));
    await settle(harness.fixture);
    loadMore(harness.fixture);
    nextRequest(http).flush(page(['p3'], 'cp3'));
    await settle(harness.fixture);
    scrollTo(harness, 240);

    const open = () =>
      (
        (harness.fixture.nativeElement as HTMLElement).querySelector('.card') as HTMLElement
      ).click();
    const expectRestored = () => {
      expect(location.path()).toBe('/explore?q=bloom&sort=published');
      expect(listing(http)).toHaveLength(0);
      expect(titles(harness.fixture)).toEqual(['p1', 'p2', 'p3']);
      expect(input(harness.fixture).value).toBe('bloom');
      expect(sortBox(harness.fixture).value).toBe('published');
      expect(scroller(harness).scrollTop).toBe(240);
    };

    open();
    await settle(harness.fixture);
    detail(http, 'p1');
    await settle(harness.fixture);
    expect(backLink(harness).getAttribute('href')).toBe('/explore?q=bloom&sort=published');
    location.back();
    await settle(harness.fixture);
    expectRestored();

    open();
    await settle(harness.fixture);
    detail(http, 'p1');
    await settle(harness.fixture);
    backLink(harness).click();
    await settle(harness.fixture);
    expectRestored();
    loadMore(harness.fixture);
    expect(nextRequest(http)).toMatchObject({ search: 'bloom', sort: 'published', cursor: 'cp3' });
  });
});

describe('Explore link on a publication', () => {
  const href = (harness: RouterTestingHarness) => backLink(harness)?.getAttribute('href');

  it('returns to the search the visitor came from', async () => {
    const { http, harness } = await visit('/explore?q=bloom');
    nextRequest(http).flush(page(['b1']));
    await settle(harness.fixture);
    await harness.navigateByUrl('/explore/b1');
    http.expectOne('/api/publications/b1').flush({ publication: { ...summary('b1'), shader: {} } });
    await settle(harness.fixture);
    expect(href(harness)).toBe('/explore?q=bloom');
  });

  it('is plain Explore for a visitor who arrived on the publication directly', async () => {
    const { http, harness } = await start();
    await harness.navigateByUrl('/explore/b1');
    http.expectOne('/api/publications/b1').flush({ publication: { ...summary('b1'), shader: {} } });
    await settle(harness.fixture);
    expect(href(harness)).toBe('/explore');
  });

  it('still leads back when the publication is gone', async () => {
    const { http, harness, location } = await visit('/explore?q=bloom');
    nextRequest(http).flush(page(['b1']));
    await settle(harness.fixture);
    await harness.navigateByUrl('/explore/gone');
    http
      .expectOne('/api/publications/gone')
      .flush({ error: { code: 'not_found', message: 'x' } }, { status: 404, statusText: 'x' });
    await settle(harness.fixture);
    expect(href(harness)).toBe('/explore?q=bloom');

    backLink(harness).click();
    await settle(harness.fixture);
    expect(location.path()).toBe('/explore?q=bloom');
    expect(listing(harness.fixture ? http : http)).toHaveLength(0);
    expect(titles(harness.fixture)).toEqual(['b1']);
  });
});

describe('Explore server rendering', () => {
  const key = makeStateKey<unknown>('explore');

  it('starts from the page the server rendered for the same search', async () => {
    const http = configure();
    TestBed.inject(TransferState).set(key, { query: 'bloom', sort: 'updated', page: page(['b1']) });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/explore?q=bloom', ExplorePage);
    await settle(harness.fixture);
    expect(listing(http)).toHaveLength(0);
    expect(titles(harness.fixture)).toEqual(['b1']);
  });

  it('does not show another search’s page, and fetches its own', async () => {
    const http = configure();
    TestBed.inject(TransferState).set(key, {
      query: 'aurora',
      sort: 'updated',
      page: page(['a1']),
    });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/explore?q=bloom', ExplorePage);
    const request = nextRequest(http);
    expect(request.search).toBe('bloom');
    request.flush(page(['b1']));
    await settle(harness.fixture);
    expect(titles(harness.fixture)).toEqual(['b1']);
    expect(TestBed.inject(TransferState).hasKey(key)).toBe(false);
  });

  it('hydrates an untidy q from the page the server rendered for its tidy form, with no request', async () => {
    const http = configure();
    TestBed.inject(TransferState).set(key, {
      query: 'bloom',
      sort: 'updated',
      page: page(['b1'], 'next'),
    });
    const harness = await RouterTestingHarness.create();
    TestBed.inject(Router).initialNavigation();
    await harness.navigateByUrl('/explore?q=%20bloom%20', ExplorePage);
    await settle(harness.fixture);
    expect(TestBed.inject(Location).path()).toBe('/explore?q=bloom');
    expect(listing(http)).toHaveLength(0);
    expect(titles(harness.fixture)).toEqual(['b1']);
    expect(input(harness.fixture).value).toBe('bloom');
  });

  it('does not hydrate one order from the page the server rendered for the other', async () => {
    const http = configure();
    TestBed.inject(TransferState).set(key, { query: 'bloom', sort: 'updated', page: page(['u1']) });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/explore?q=bloom&sort=published', ExplorePage);
    const request = nextRequest(http);
    expect(request).toMatchObject({ search: 'bloom', sort: 'published' });
    request.flush(page(['p1']));
    await settle(harness.fixture);
    expect(titles(harness.fixture)).toEqual(['p1']);
  });

  it('hydrates a published listing from the page the server rendered for it, with no request', async () => {
    const http = configure();
    TestBed.inject(TransferState).set(key, {
      query: 'bloom',
      sort: 'published',
      page: page(['p1'], 'cp'),
    });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/explore?q=bloom&sort=published', ExplorePage);
    await settle(harness.fixture);
    expect(listing(http)).toHaveLength(0);
    expect(titles(harness.fixture)).toEqual(['p1']);
    expect(sortBox(harness.fixture).value).toBe('published');
  });

  it('renders the requested order on the server, selected in the HTML and transferred', async () => {
    const { http, harness } = await start({ platform: 'server' });
    await harness.navigateByUrl('/explore?sort=published', ExplorePage);
    const request = nextRequest(http);
    expect(request).toMatchObject({ search: null, sort: 'published' });
    request.flush(page(['p1']));
    await settle(harness.fixture);

    expect(TestBed.inject(TransferState).get(key, null)).toEqual({
      query: '',
      sort: 'published',
      page: page(['p1']),
    });
    const selected = [...sortBox(harness.fixture).options]
      .filter((option) => option.hasAttribute('selected'))
      .map((option) => option.value);
    expect(selected).toEqual(['published']);
  });

  it('renders and transfers the first page of the requested q, and keeps nothing for the next request', async () => {
    const { http, harness } = await start({ platform: 'server' });
    await harness.navigateByUrl('/explore?q=%20bloom', ExplorePage);
    const request = nextRequest(http);
    expect(request.search).toBe('bloom');
    request.flush(page(['b1'], 'next'));
    await settle(harness.fixture);

    expect(TestBed.inject(TransferState).get(key, null)).toEqual({
      query: 'bloom',
      sort: 'updated',
      page: page(['b1'], 'next'),
    });
    // The server has no address bar to tidy and no memory to share between requests.
    expect(TestBed.inject(Router).url).toBe('/explore?q=%20bloom');
    expect(
      TestBed.inject(ExploreBrowseState).recall({ query: 'bloom', sort: 'updated' }),
    ).toBeNull();
    expect(TestBed.inject(ExploreBrowseState).returnTo()).toEqual({ query: '', sort: 'updated' });
  });
});
