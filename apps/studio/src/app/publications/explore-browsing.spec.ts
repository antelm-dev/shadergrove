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
import { afterEach, describe, expect, it, vi } from 'vitest';

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

describe('Explore link on a publication', () => {
  const backLink = (harness: RouterTestingHarness) =>
    (harness.routeNativeElement as HTMLElement)
      .querySelector('a.mat-mdc-button')
      ?.getAttribute('href');

  it('returns to the search the visitor came from', async () => {
    const { http, harness } = await visit('/explore?q=bloom');
    nextRequest(http).flush(page(['b1']));
    await settle(harness.fixture);
    await harness.navigateByUrl('/explore/b1');
    http.expectOne('/api/publications/b1').flush({ publication: { ...summary('b1'), shader: {} } });
    await settle(harness.fixture);
    expect(backLink(harness)).toBe('/explore?q=bloom');
  });

  it('is plain Explore for a visitor who arrived on the publication directly', async () => {
    const { http, harness } = await start();
    await harness.navigateByUrl('/explore/b1');
    http.expectOne('/api/publications/b1').flush({ publication: { ...summary('b1'), shader: {} } });
    await settle(harness.fixture);
    expect(backLink(harness)).toBe('/explore');
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
    expect(backLink(harness)).toBe('/explore?q=bloom');

    (
      (harness.routeNativeElement as HTMLElement).querySelector('a.mat-mdc-button') as HTMLElement
    ).click();
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
    TestBed.inject(TransferState).set(key, { query: 'bloom', page: page(['b1']) });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/explore?q=bloom', ExplorePage);
    await settle(harness.fixture);
    expect(listing(http)).toHaveLength(0);
    expect(titles(harness.fixture)).toEqual(['b1']);
  });

  it('does not show another search’s page, and fetches its own', async () => {
    const http = configure();
    TestBed.inject(TransferState).set(key, { query: 'aurora', page: page(['a1']) });
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
    TestBed.inject(TransferState).set(key, { query: 'bloom', page: page(['b1'], 'next') });
    const harness = await RouterTestingHarness.create();
    TestBed.inject(Router).initialNavigation();
    await harness.navigateByUrl('/explore?q=%20bloom%20', ExplorePage);
    await settle(harness.fixture);
    expect(TestBed.inject(Location).path()).toBe('/explore?q=bloom');
    expect(listing(http)).toHaveLength(0);
    expect(titles(harness.fixture)).toEqual(['b1']);
    expect(input(harness.fixture).value).toBe('bloom');
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
      page: page(['b1'], 'next'),
    });
    // The server has no address bar to tidy and no memory to share between requests.
    expect(TestBed.inject(Router).url).toBe('/explore?q=%20bloom');
    expect(TestBed.inject(ExploreBrowseState).recall('bloom')).toBeNull();
    expect(TestBed.inject(ExploreBrowseState).returnQuery()).toBe('');
  });
});
