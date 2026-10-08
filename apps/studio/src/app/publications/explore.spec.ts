import {
  HttpClient,
  HttpErrorResponse,
  provideHttpClient,
  withInterceptors,
} from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, input, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PublicationDetail, PublicationSummary } from '@shadergrove/shared/publication';
import { authInterceptor } from '../auth/auth.interceptor';
import { AuthPrompt } from '../auth/auth-prompt';
import { AuthService, type AuthStatus } from '../auth/auth.service';
import { DesktopPlatform } from '../desktop/desktop-platform';
import { I18n } from '../i18n/i18n';
import { ShaderStore } from '../workspace/shader-store';
import { ExploreAccess } from './explore-access';
import { ExplorePage } from './explore-page';
import { PublicationPage } from './publication-page';
import { PublicationPreview } from './publication-preview';

/** Translations are their own keys here, so assertions name the message rather than its wording. */
const i18n = { t: (key: string) => key, locale: signal('en') };

const summary = (id: string, title: string): PublicationSummary => ({
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

const detail = (id: string, title: string): PublicationDetail => ({
  ...summary(id, title),
  attribution: '',
  derivedFrom: null,
  shader: { id } as PublicationDetail['shader'],
});

@Component({ selector: 'app-publication-preview', template: 'running' })
class PreviewStub {
  readonly publication = input.required<PublicationDetail>();
}

@Component({ template: '' })
class Blank {}

const status = signal<AuthStatus>('anonymous');
const verified = signal(false);
const user = signal<{ id: string } | null>(null);
const auth = { status, verified, user, authenticated: () => status() === 'authenticated' };
const desktop = { available: false };
const store = { refreshList: vi.fn(async () => true), notice: signal<unknown>(null) };

function configure(extra: unknown[] = []): HttpTestingController {
  status.set('anonymous');
  verified.set(false);
  user.set(null);
  desktop.available = false;
  store.refreshList.mockClear();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(withInterceptors([authInterceptor])),
      provideHttpClientTesting(),
      provideRouter([{ path: '**', component: Blank }]),
      { provide: I18n, useValue: i18n },
      { provide: AuthService, useValue: { ...auth, refresh: async () => undefined } },
      { provide: DesktopPlatform, useValue: desktop },
      { provide: ShaderStore, useValue: store },
      ...(extra as never[]),
    ],
  });
  TestBed.overrideComponent(PublicationPage, {
    remove: { imports: [PublicationPreview] },
    add: { imports: [PreviewStub] },
  });
  return TestBed.inject(HttpTestingController);
}

async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  // Twice: a flushed response resolves a promise, whose continuation sets the signals.
  for (let pass = 0; pass < 2; pass += 1) {
    await new Promise((resolve) => setTimeout(resolve));
    fixture.detectChanges();
    await fixture.whenStable();
  }
}

const text = (fixture: ComponentFixture<unknown>) =>
  (fixture.nativeElement as HTMLElement).textContent ?? '';

function click(fixture: ComponentFixture<unknown>, label: string): void {
  const button = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].find(
    (entry) => entry.textContent?.includes(label),
  );
  if (!button) throw new Error(`no button "${label}"`);
  button.click();
}

afterEach(() => TestBed.resetTestingModule());

describe('ExploreAccess', () => {
  const capabilities = (http: HttpTestingController) => http.match('/api/capabilities');

  it('asks once the session is known, and again when it changes hands', async () => {
    const http = configure();
    status.set('loading');
    const access = TestBed.inject(ExploreAccess);
    TestBed.tick();
    expect(capabilities(http)).toHaveLength(0);
    expect(access.capabilities()).toEqual({ publicExplore: false, admin: false });

    status.set('authenticated');
    user.set({ id: 'moderator' });
    TestBed.tick();
    capabilities(http)[0].flush({ publicExplore: true, admin: true });
    await new Promise((resolve) => setTimeout(resolve));
    expect(access.capabilities()).toEqual({ publicExplore: true, admin: true });

    // Another account: its predecessor's privilege is gone before the answer is in.
    user.set({ id: 'someone-else' });
    TestBed.tick();
    expect(access.capabilities().admin).toBe(false);
    capabilities(http)[0].flush({ publicExplore: true, admin: false });
    await new Promise((resolve) => setTimeout(resolve));
    expect(access.capabilities()).toEqual({ publicExplore: true, admin: false });
  });

  it('offers nothing when the server cannot be reached', async () => {
    const http = configure();
    const access = TestBed.inject(ExploreAccess);
    TestBed.tick();
    capabilities(http)[0].error(new ProgressEvent('error'));
    await new Promise((resolve) => setTimeout(resolve));
    expect(access.capabilities()).toEqual({ publicExplore: false, admin: false });
  });

  it('never calls the server from the desktop app', () => {
    const http = configure();
    desktop.available = true;
    TestBed.inject(ExploreAccess);
    TestBed.tick();
    expect(capabilities(http)).toHaveLength(0);
  });
});

describe('ExplorePage', () => {
  const listing = (http: HttpTestingController) =>
    http.match((request) => request.url === '/api/publications');

  async function mount() {
    const http = configure();
    const fixture = TestBed.createComponent(ExplorePage);
    fixture.detectChanges();
    return { http, fixture };
  }

  it('lists static cards, then pages and searches without losing its place', async () => {
    const { http, fixture } = await mount();
    listing(http)[0].flush({ publications: [summary('a1', 'Aurora')], nextCursor: 'next' });
    await settle(fixture);

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.card')?.getAttribute('href')).toBe('/explore/a1');
    expect(root.querySelector('img')?.getAttribute('src')).toBe(
      '/api/publications/a1/thumbnail?v=1',
    );
    expect(root.querySelector('canvas')).toBeNull();

    click(fixture, 'explore.loadMore');
    const [more] = listing(http);
    expect(more.request.params.get('cursor')).toBe('next');
    more.flush({ publications: [summary('b2', 'Bloom')], nextCursor: null });
    await settle(fixture);
    expect(root.querySelectorAll('.card')).toHaveLength(2);
    expect(text(fixture)).not.toContain('explore.loadMore');

    const search = root.querySelector('input') as HTMLInputElement;
    search.value = ' bloom ';
    root.querySelector('form')?.dispatchEvent(new Event('submit'));
    // The search lands in the address first; the page loads what the address says.
    await settle(fixture);
    const [searched] = listing(http);
    expect(searched.request.params.get('search')).toBe('bloom');
    expect(searched.request.params.has('cursor')).toBe(false);
    searched.flush({ publications: [], nextCursor: null });
    await settle(fixture);
    expect(root.querySelectorAll('.card')).toHaveLength(0);
    expect(text(fixture)).toContain('explore.noMatch');
  });

  it('says so when the server has Explore turned off, and lets a failure be retried', async () => {
    const { http, fixture } = await mount();
    listing(http)[0].flush(
      { error: { code: 'not_found', message: 'No such API route' } },
      { status: 404, statusText: 'Not Found' },
    );
    await settle(fixture);
    expect(text(fixture)).toContain('explore.unavailable');

    const second = TestBed.createComponent(ExplorePage);
    second.detectChanges();
    listing(http)[0].error(new ProgressEvent('error'));
    await settle(second);
    expect(text(second)).toContain('explore.loadError');
    click(second, 'explore.retry');
    listing(http)[0].flush({ publications: [summary('a1', 'Aurora')], nextCursor: null });
    await settle(second);
    expect(text(second)).toContain('Aurora');
  });
});

describe('PublicationPage', () => {
  async function mount(id = 'a1') {
    const params = new BehaviorSubject(convertToParamMap({ publicationId: id }));
    const http = configure([{ provide: ActivatedRoute, useValue: { paramMap: params } }]);
    const fixture = TestBed.createComponent(PublicationPage);
    fixture.detectChanges();
    http.expectOne(`/api/publications/${id}`).flush({ publication: detail(id, 'Aurora') });
    await settle(fixture);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    return { http, fixture, params, navigate, prompt: TestBed.inject(AuthPrompt) };
  }

  const signIn = (isVerified = true) => {
    status.set('authenticated');
    verified.set(isVerified);
  };

  it('shows the snapshot and renders nothing live until asked, then stops on request', async () => {
    const { fixture } = await mount();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('h1')?.textContent).toBe('Aurora');
    expect(root.querySelector('app-publication-preview')).toBeNull();
    expect(root.querySelector('img')?.getAttribute('src')).toBe(
      '/api/publications/a1/thumbnail?v=1',
    );

    click(fixture, 'explore.runPreview');
    await settle(fixture);
    expect(root.querySelector('app-publication-preview')).not.toBeNull();

    click(fixture, 'explore.stopPreview');
    await settle(fixture);
    expect(root.querySelector('app-publication-preview')).toBeNull();
  });

  it('treats a hidden or unknown publication as simply not there', async () => {
    const params = new BehaviorSubject(convertToParamMap({ publicationId: 'gone' }));
    const http = configure([{ provide: ActivatedRoute, useValue: { paramMap: params } }]);
    const fixture = TestBed.createComponent(PublicationPage);
    fixture.detectChanges();
    http
      .expectOne('/api/publications/gone')
      .flush({ error: { code: 'not_found', message: 'x' } }, { status: 404, statusText: 'x' });
    await settle(fixture);
    expect(text(fixture)).toContain('explore.notFound');
    expect((fixture.nativeElement as HTMLElement).querySelector('article')).toBeNull();
    // Nobody was asked to sign in to be told that.
    expect(TestBed.inject(AuthPrompt).pending()).toBeNull();
  });

  it('asks an anonymous or unverified visitor to sign in before copying, and sends nothing', async () => {
    const { http, fixture, prompt } = await mount();
    click(fixture, 'explore.copy');
    expect(prompt.pending()).toEqual({ mode: 'sign-in' });
    prompt.clear();

    signIn(false);
    click(fixture, 'explore.copy');
    expect(prompt.pending()).toEqual({ mode: 'verify-email' });
    http.expectNone('/api/publications/a1/copy');
  });

  it('copies into the library and hands over to the editor’s own route', async () => {
    const { http, fixture, navigate } = await mount();
    signIn();
    click(fixture, 'explore.copy');
    http
      .expectOne({ method: 'POST', url: '/api/publications/a1/copy' })
      .flush({ shader: { id: 'aurora-2', name: 'Aurora' } });
    await settle(fixture);

    expect(store.refreshList).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith('/shaders/aurora-2');
  });

  it('keeps the page and asks for the session back when it expired mid-visit', async () => {
    const { http, fixture, navigate, prompt } = await mount();
    signIn();
    click(fixture, 'explore.copy');
    http
      .expectOne('/api/publications/a1/copy')
      .flush({ error: { code: 'unauthorized', message: 'x' } }, { status: 401, statusText: 'x' });
    await settle(fixture);

    expect(prompt.pending()).toEqual({ mode: 'sign-in' });
    expect(navigate).not.toHaveBeenCalled();
    expect(text(fixture)).toContain('Aurora');
  });

  it('reports once, and says so when a report is already open', async () => {
    const { http, fixture } = await mount();
    signIn();
    const root = fixture.nativeElement as HTMLElement;
    const send = async (code: number) => {
      click(fixture, 'explore.report');
      await settle(fixture);
      root.querySelector('form.report')?.dispatchEvent(new Event('submit'));
      const request = http.expectOne('/api/publications/a1/reports');
      expect(request.request.body).toEqual({ reason: 'copyright', body: '' });
      request.flush(
        code === 201 ? { report: { id: 'r1' } } : { error: { code: 'conflict', message: 'x' } },
        { status: code, statusText: 'x' },
      );
      await settle(fixture);
    };

    await send(201);
    expect(text(fixture)).toContain('explore.reported');
    expect(root.querySelector('form.report')).toBeNull();
    await send(409);
    expect(text(fixture)).toContain('explore.alreadyReported');
  });

  it('stops the preview when the page moves on to another publication', async () => {
    const { http, fixture, params } = await mount();
    click(fixture, 'explore.runPreview');
    await settle(fixture);

    params.next(convertToParamMap({ publicationId: 'b2' }));
    http.expectOne('/api/publications/b2').flush({ publication: detail('b2', 'Bloom') });
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('h1')?.textContent).toBe('Bloom');
    expect(root.querySelector('app-publication-preview')).toBeNull();
  });
});

describe('authInterceptor on Explore', () => {
  it('does not meet a visitor with a sign-in dialog for the library they do not have', async () => {
    const http = configure();
    const router = TestBed.inject(Router);
    const prompt = TestBed.inject(AuthPrompt);
    const failLibraryLoad = async () => {
      const result = fetchLibrary();
      http
        .expectOne('/api/shaders')
        .flush({ error: { code: 'unauthorized', message: 'x' } }, { status: 401, statusText: 'x' });
      expect(await result).toBeInstanceOf(HttpErrorResponse);
      await new Promise((resolve) => setTimeout(resolve));
    };

    await router.navigateByUrl('/explore/a1');
    await failLibraryLoad();
    expect(prompt.pending()).toBeNull();

    // In the editor, the same refusal still asks for a session.
    await router.navigateByUrl('/');
    await failLibraryLoad();
    expect(prompt.pending()).toEqual({ mode: 'sign-in' });
  });
});

function fetchLibrary(): Promise<unknown> {
  return firstValueFrom(TestBed.inject(HttpClient).get('/api/shaders')).catch(
    (error: unknown) => error,
  );
}
