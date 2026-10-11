import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import type { ExploreCapabilities } from '@shadergrove/shared/publication';
import { I18n } from '../../i18n/i18n';
import { ExploreAccess } from '../../publications/explore-access';
import { ExploreBrowseState } from '../../publications/explore-browse-state';
import { ShaderStore } from '../../workspace/shader-store';
import { AppNavigation, AppNavigationLinks, sectionOf } from './app-navigation';

@Component({ template: '' })
class Blank {}

function setup() {
  const selectedId = signal<string | null>(null);
  const capabilities = signal<ExploreCapabilities>({ publicExplore: false, admin: false });
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([{ path: '**', component: Blank }]),
      { provide: ShaderStore, useValue: { selectedId } },
      { provide: ExploreAccess, useValue: { capabilities } },
      { provide: I18n, useValue: { t: (key: string) => key } },
    ],
  });
  const router = TestBed.inject(Router);
  const nav = TestBed.inject(AppNavigation);
  const browse = TestBed.inject(ExploreBrowseState);
  const go = async (url: string) => {
    await router.navigateByUrl(url);
    TestBed.tick();
  };
  const href = (tree: ReturnType<Router['parseUrl']>) => router.serializeUrl(tree);
  return { router, nav, browse, selectedId, capabilities, go, href };
}

describe('sectionOf', () => {
  it('names the pages the routing coordinator treats as standalone', () => {
    expect(sectionOf('/explore')).toBe('explore');
    expect(sectionOf('/explore?q=a&sort=published')).toBe('explore');
    expect(sectionOf('/explore/abc')).toBe('explore');
    expect(sectionOf('/plugins?tab=installed&use=x')).toBe('plugins');
    expect(sectionOf('/admin/publications')).toBe('admin');
    expect(sectionOf('/desktop/connect?state=s&code_challenge=c')).toBe('connect');
  });

  it('leaves everything else to the editor', () => {
    for (const url of ['/', '/shaders/waves', '/explorer', '/pluginsx', '/desktop', '/x#explore']) {
      expect(sectionOf(url), url).toBe('editor');
    }
  });
});

describe('AppNavigation', () => {
  it('follows finished navigations, so the editor is shown until a page has arrived', async () => {
    const { nav, go } = setup();
    expect(nav.section()).toBe('editor');
    expect(nav.away()).toBe(false);
    await go('/plugins');
    expect(nav.section()).toBe('plugins');
    expect(nav.away()).toBe(true);
    await go('/shaders/waves');
    expect(nav.away()).toBe(false);
  });

  it('leads the Editor link to the selection’s canonical address', () => {
    const { nav, selectedId, href } = setup();
    expect(href(nav.editorLink())).toBe('/');
    selectedId.set('a b');
    expect(href(nav.editorLink())).toBe('/shaders/a%20b');
  });

  it('returns Explore to the search last browsed, and stays put on the listing itself', async () => {
    const { nav, browse, go, href } = setup();
    expect(href(nav.exploreLink())).toBe('/explore');
    browse.returnTo.set({ query: 'aurora', sort: 'published' });
    expect(href(nav.exploreLink())).toBe('/explore?q=aurora&sort=published');

    // A publication goes up to its search; the listing links to itself, a no-op.
    await go('/explore/aurora-01');
    expect(href(nav.exploreLink())).toBe('/explore?q=aurora&sort=published');
    await go('/explore?q=bloom');
    expect(href(nav.exploreLink())).toBe('/explore?q=bloom');
  });

  it('reopens the Plugins tab last shown, dropping a one-off package link', async () => {
    const { nav, go, href } = setup();
    expect(href(nav.pluginsLink())).toBe('/plugins');
    await go('/plugins?tab=installed&use=dev.example');
    expect(href(nav.pluginsLink())).toBe('/plugins?tab=installed&use=dev.example');
    await go('/');
    expect(href(nav.pluginsLink())).toBe('/plugins?tab=installed');
    await go('/plugins');
    await go('/shaders/waves');
    expect(href(nav.pluginsLink())).toBe('/plugins');
  });
});

describe('AppNavigationLinks', () => {
  it('offers Explore only while the server does, and marks the current section', async () => {
    const { capabilities, go } = setup();
    const fixture = TestBed.createComponent(AppNavigationLinks);
    const element = fixture.nativeElement as HTMLElement;
    const links = () =>
      [...element.querySelectorAll('nav a')].map((link) => [
        link.getAttribute('data-testid'),
        link.getAttribute('aria-current'),
      ]);
    await fixture.whenStable();
    expect(element.querySelector('nav')?.getAttribute('aria-label')).toBe('toolbar.sections');
    expect(links()).toEqual([
      ['open-editor', 'page'],
      ['open-plugins', null],
    ]);

    capabilities.set({ publicExplore: true, admin: false });
    await go('/explore/abc');
    await fixture.whenStable();
    expect(links()).toEqual([
      ['open-editor', null],
      ['open-explore', 'page'],
      ['open-plugins', null],
    ]);

    // Switched off again (another account, an unreachable server): no way in.
    capabilities.set({ publicExplore: false, admin: false });
    await fixture.whenStable();
    expect(links().map(([id]) => id)).toEqual(['open-editor', 'open-plugins']);
  });
});
