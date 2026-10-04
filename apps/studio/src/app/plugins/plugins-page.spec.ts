import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_LANGUAGE_REFS,
  FRENCH_PACKAGE_ID,
  type CatalogueEntry,
} from '@shadergrove/shared/plugin';
import { DesktopPlatform } from '../desktop/desktop-platform';
import { I18n } from '../i18n/i18n';
import { installedPackage, officialPackageText } from '../i18n/testing/languages';
import { Preferences, type WorkspacePreferences } from '../prefs/preferences';
import { AppThemes } from '../themes/app-themes';
import { ShaderStore } from '../workspace/shader-store';
import { EffectAdoption } from './effect-adoption';
import { PluginCatalogueService } from './plugin-catalogue';
import { PluginInstallations } from './plugin-installations';
import { PluginsPage } from './plugins-page';
import { ProjectPluginActions } from './project-actions';

const entry = (id: string): CatalogueEntry => ({
  id,
  version: '1.0.0',
  name: id,
  description: '',
  publisher: 'Example',
  license: 'MIT',
  protocolVersion: 2,
  appVersionRange: '>=1.0.0',
  file: `${id}-1.0.0.sgplugin.json`,
  bytes: 1,
  sha256: '0'.repeat(64),
  contributions: [],
});

/**
 * Links into Plugins (`/plugins?use=<id>`) from the menus and the palette.
 * Following one while the page is already open reuses the page, so the
 * highlight and the scroll have to follow the link, not the first visit.
 */
describe('PluginsPage deep links', () => {
  const FIRST = 'dev.example.first';
  const SECOND = 'dev.example.second';
  const scrolled: string[] = [];
  const original = Element.prototype.scrollIntoView;

  beforeEach(async () => {
    scrolled.length = 0;
    // The test DOM has neither `CSS.escape` nor layout; ids here need no escaping.
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
      scrolled.push(this.id);
    });
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([{ path: 'plugins', component: PluginsPage }]),
        I18n,
        { provide: Preferences, useValue: { value: signal({ language: 'en' }).asReadonly() } },
        {
          provide: PluginInstallations,
          useValue: {
            loading: signal(false),
            defaultsSettled: signal(false),
            plugins: signal([]),
            profile: signal('anonymous'),
            find: () => undefined,
          },
        },
        {
          provide: PluginCatalogueService,
          useValue: {
            state: signal({ status: 'ready', packages: [entry(FIRST), entry(SECOND)] }),
            load: async () => undefined,
          },
        },
        {
          provide: ProjectPluginActions,
          useValue: { running: signal(null), importers: signal([]), exporters: signal([]) },
        },
        { provide: AppThemes, useValue: { entries: signal([]) } },
        { provide: EffectAdoption, useValue: {} },
        { provide: ShaderStore, useValue: { draft: signal(null) } },
        { provide: DesktopPlatform, useValue: { available: false } },
      ],
    });
  });

  afterEach(() => {
    Element.prototype.scrollIntoView = original;
    vi.unstubAllGlobals();
    TestBed.resetTestingModule();
  });

  const focused = (harness: RouterTestingHarness): string[] =>
    Array.from(harness.routeNativeElement!.querySelectorAll('article.focused')).map(
      (card) => card.id,
    );

  const settle = async (harness: RouterTestingHarness) => {
    harness.detectChanges();
    await new Promise((done) => setTimeout(done, 5));
    harness.detectChanges();
  };

  it('moves the highlight and the scroll to each package a link asks for', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(`/plugins?use=${FIRST}`, PluginsPage);
    await settle(harness);
    expect(focused(harness)).toEqual([`available-${FIRST}`]);
    expect(scrolled).toEqual([`available-${FIRST}`]);

    // Same route, another package: the page is reused.
    await harness.navigateByUrl(`/plugins?use=${SECOND}`, PluginsPage);
    await settle(harness);
    expect(focused(harness)).toEqual([`available-${SECOND}`]);
    expect(scrolled).toEqual([`available-${FIRST}`, `available-${SECOND}`]);

    // Without one, nothing is highlighted; the same link followed again scrolls again.
    await harness.navigateByUrl('/plugins', PluginsPage);
    await settle(harness);
    expect(focused(harness)).toEqual([]);
    await harness.navigateByUrl(`/plugins?use=${SECOND}`, PluginsPage);
    await settle(harness);
    expect(scrolled).toEqual([`available-${FIRST}`, `available-${SECOND}`, `available-${SECOND}`]);
  });
});

/**
 * A language pack in Plugins: its locale and native name, and a plain choice
 * to speak it — no importer form, no Worker — that shows when it is in use.
 */
describe('PluginsPage language packs', () => {
  const prefs = signal<Pick<WorkspacePreferences, 'language' | 'languagePackId'>>({
    language: 'en',
    languagePackId: null,
  });
  const french = installedPackage(officialPackageText(FRENCH_PACKAGE_ID));

  beforeEach(() => {
    prefs.set({ language: 'en', languagePackId: null });
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([{ path: 'plugins', component: PluginsPage }]),
        I18n,
        {
          provide: Preferences,
          useValue: {
            value: prefs.asReadonly(),
            patch: (patch: Partial<WorkspacePreferences>) =>
              prefs.update((value) => ({ ...value, ...patch })),
          },
        },
        {
          provide: PluginInstallations,
          useValue: {
            loading: signal(false),
            defaultsSettled: signal(false),
            plugins: signal([french]),
            profile: signal('anonymous'),
            find: (id: string) => (id === french.id ? french : undefined),
          },
        },
        {
          provide: PluginCatalogueService,
          useValue: {
            state: signal({ status: 'ready', packages: [] }),
            load: async () => undefined,
          },
        },
        {
          provide: ProjectPluginActions,
          useValue: { running: signal(null), importers: signal([]), exporters: signal([]) },
        },
        { provide: AppThemes, useValue: { entries: signal([]) } },
        { provide: EffectAdoption, useValue: {} },
        { provide: ShaderStore, useValue: { draft: signal(null) } },
        { provide: DesktopPlatform, useValue: { available: false } },
      ],
    });
  });

  afterEach(() => TestBed.resetTestingModule());

  it('shows the language, and speaks it when chosen there', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/plugins', PluginsPage);
    harness.detectChanges();
    const page = harness.routeNativeElement as HTMLElement;
    const key = `${FRENCH_PACKAGE_ID}/french`;
    expect(page.textContent).toContain('Language');
    expect(page.textContent).toContain('Français (fr)');

    const use = page.querySelector<HTMLButtonElement>(`[data-testid="use-language-${key}"]`);
    expect(use?.textContent?.trim()).toBe('Use as app language');
    use!.click();
    harness.detectChanges();
    expect(prefs()).toEqual({ language: 'fr', languagePackId: DEFAULT_LANGUAGE_REFS.fr });
    expect(page.querySelector(`[data-testid="language-in-use-${key}"]`)?.textContent?.trim()).toBe(
      'Langue actuelle de l’app',
    );
  });
});
