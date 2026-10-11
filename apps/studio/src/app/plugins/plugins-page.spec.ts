import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_LANGUAGE_REFS,
  FRENCH_PACKAGE_ID,
  type CatalogueEntry,
} from '@shadergrove/shared/plugin';
import { DesktopPlatform } from '../desktop/desktop-platform';
import { I18n } from '../i18n/i18n';
import { installedPackage } from '../i18n/testing/languages';
import { officialPackageText } from './testing/official-packages';
import { Preferences, type WorkspacePreferences } from '../prefs/preferences';
import { AppThemes } from '../themes/app-themes';
import { ShaderStore } from '../workspace/shader-store';
import { EffectAdoption } from './effect-adoption';
import { SOURCE_PROVIDERS, type SourceProvider } from './host-adapters';
import { PluginCatalogueService, type CatalogueState } from './plugin-catalogue';
import { PluginCommands } from './plugin-commands';
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

/** An installed package as the page lists it: switched off, nothing more needed here. */
const installed = (id: string) => ({ id, plugin: null, problem: null, active: false }) as never;

/**
 * Links into Plugins (`/plugins?use=<id>`) from the menus and the palette, and
 * the Browse/Installed tab kept in the address (`?tab=installed`). Following a
 * link while the page is already open reuses the page, so the tab, the
 * highlight and the scroll have to follow the link, not the first visit — and
 * nothing is decided from a package's absence before both lists have loaded.
 */
describe('PluginsPage tabs and deep links', () => {
  const FIRST = 'dev.example.first';
  const SECOND = 'dev.example.second';
  const scrolled: string[] = [];
  const original = Element.prototype.scrollIntoView;
  const plugins = signal<never[]>([]);
  const defaultsSettled = signal(true);
  const catalogue = signal<CatalogueState>({ status: 'idle' });
  const install = vi.fn();
  const installReviewedUpdate = vi.fn();
  /** Holds every catalogue fetch until released; open by default. */
  let fetched: Promise<void> = Promise.resolve();

  beforeEach(async () => {
    scrolled.length = 0;
    plugins.set([]);
    defaultsSettled.set(true);
    catalogue.set({ status: 'ready', packages: [entry(FIRST), entry(SECOND)] });
    install.mockReset();
    installReviewedUpdate.mockReset();
    fetched = Promise.resolve();
    // The test DOM has neither `CSS.escape` nor layout; ids here need no escaping.
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
      scrolled.push(this.id);
    });
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([
          { path: 'plugins', component: PluginsPage },
          { path: '', children: [] },
        ]),
        I18n,
        { provide: Preferences, useValue: { value: signal({ language: 'en' }).asReadonly() } },
        {
          provide: PluginInstallations,
          useValue: {
            loading: signal(false),
            defaultsSettled,
            plugins,
            profile: signal('anonymous'),
            find: (id: string) => plugins().find((item) => (item as { id: string }).id === id),
            // The bytes fetched below are the package id; a second package is an update.
            review: (bytes: Uint8Array) => ({
              ok: true,
              compatible: true,
              plugin: { manifest: { id: new TextDecoder().decode(bytes) } },
              replaces: plugins().length ? '0.9.0' : null,
            }),
            install,
            installReviewedUpdate,
          },
        },
        {
          provide: PluginCatalogueService,
          useValue: {
            state: catalogue,
            load: async () => undefined,
            fetchPackage: async (item: CatalogueEntry) => {
              await fetched;
              return new TextEncoder().encode(item.id);
            },
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

  const page = (harness: RouterTestingHarness) => harness.routeNativeElement as HTMLElement;
  const focused = (harness: RouterTestingHarness): string[] =>
    Array.from(page(harness).querySelectorAll('article.focused')).map((card) => card.id);
  /** The cards on the page: only the selected tab's are there. */
  const cards = (harness: RouterTestingHarness): string[] =>
    Array.from(page(harness).querySelectorAll('article')).map((card) => card.id);
  const query = () => {
    const router = TestBed.inject(Router);
    return router.parseUrl(router.url).queryParams;
  };
  const click = (harness: RouterTestingHarness, testId: string) =>
    page(harness).querySelector<HTMLElement>(`[data-testid="${testId}"]`)!.click();

  const settle = async (harness: RouterTestingHarness) => {
    harness.detectChanges();
    await new Promise((done) => setTimeout(done, 5));
    harness.detectChanges();
  };

  /** Opens the page; `navigate` then records every navigation it makes on its own. */
  async function open(url: string) {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url, PluginsPage);
    await settle(harness);
    await settle(harness);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate');
    return { harness, navigate };
  }

  it('moves the highlight and the scroll to each package a link asks for', async () => {
    const { harness } = await open(`/plugins?use=${FIRST}`);
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

  it('shows the tab the address names, Browse by default, and tidies anything else in place', async () => {
    plugins.set([installed(FIRST)]);
    const { harness, navigate } = await open('/plugins?tab=installed&keep=1');
    expect(cards(harness)).toEqual([`installed-${FIRST}`]);
    expect(navigate).not.toHaveBeenCalled();

    await harness.navigateByUrl('/plugins?keep=1', PluginsPage);
    await settle(harness);
    expect(cards(harness)).toEqual([`available-${FIRST}`, `available-${SECOND}`]);
    expect(navigate).not.toHaveBeenCalled();

    // Unknown, or the default spelled out: replaced, the rest of the address kept.
    for (const tab of ['nonsense', 'browse']) {
      navigate.mockClear();
      await harness.navigateByUrl(`/plugins?tab=${tab}&keep=1`, PluginsPage);
      await settle(harness);
      await settle(harness);
      expect(query()).toEqual({ keep: '1' });
      expect(navigate).toHaveBeenCalledOnce();
      expect(navigate.mock.calls[0][1]).toMatchObject({ replaceUrl: true });
    }
  });

  it('decides where a linked package is only once both lists have loaded, then once', async () => {
    defaultsSettled.set(false);
    catalogue.set({ status: 'loading' });
    const { harness, navigate } = await open(`/plugins?use=${FIRST}`);
    expect(focused(harness)).toEqual([]);

    // Installed, but the catalogue is still loading: nothing is decided yet.
    plugins.set([installed(FIRST)]);
    defaultsSettled.set(true);
    await settle(harness);
    expect(navigate).not.toHaveBeenCalled();
    expect(scrolled).toEqual([]);

    catalogue.set({ status: 'ready', packages: [entry(FIRST)] });
    await settle(harness);
    await settle(harness);
    expect(query()).toEqual({ use: FIRST, tab: 'installed' });
    expect(cards(harness)).toEqual([`installed-${FIRST}`]);
    expect(focused(harness)).toEqual([`installed-${FIRST}`]);
    expect(scrolled).toEqual([`installed-${FIRST}`]);
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate.mock.calls[0][1]).toMatchObject({ replaceUrl: true });
  });

  it('decides again after a profile switch, only once the new profile has loaded', async () => {
    plugins.set([installed(FIRST)]);
    const { harness, navigate } = await open(`/plugins?use=${FIRST}`);
    expect(query()).toEqual({ use: FIRST, tab: 'installed' });

    // The switch empties the list before the new profile's is read.
    defaultsSettled.set(false);
    plugins.set([]);
    await settle(harness);
    expect(navigate).not.toHaveBeenCalled();
    expect(query()).toEqual({ use: FIRST, tab: 'installed' });

    // The new profile does not have it, the catalogue lists it: Browse.
    defaultsSettled.set(true);
    await settle(harness);
    await settle(harness);
    expect(query()).toEqual({ use: FIRST });
    expect(focused(harness)).toEqual([`available-${FIRST}`]);
    expect(navigate).toHaveBeenCalledOnce();
  });

  it('keeps the tab asked for when the linked package is listed nowhere, without looping', async () => {
    const { harness, navigate } = await open('/plugins?tab=installed&use=dev.example.missing');
    await settle(harness);
    expect(query()).toEqual({ tab: 'installed', use: 'dev.example.missing' });
    expect(navigate).not.toHaveBeenCalled();
    expect(scrolled).toEqual([]);
  });

  it('links each tab with the rest of the address, dropping a package that would pull it back', async () => {
    plugins.set([installed(FIRST)]);
    const { harness } = await open(`/plugins?use=${FIRST}&keep=1`);
    const href = (tab: string) =>
      page(harness).querySelector(`[data-testid="plugins-tab-${tab}"]`)?.getAttribute('href');
    expect(href('browse')).toBe('/plugins?keep=1');
    expect(href('installed')).toBe(`/plugins?use=${FIRST}&keep=1&tab=installed`);
  });

  it('shows a new install on Installed, focused; an update stays where it was', async () => {
    install.mockImplementation(async () => plugins.set([installed(FIRST)]));
    // Followed from a link to it on Browse: the card it moves to is scrolled to as well.
    const { harness } = await open(`/plugins?use=${FIRST}`);
    click(harness, `install-available-${FIRST}`);
    await settle(harness);
    await settle(harness);
    expect(install).toHaveBeenCalledOnce();
    expect(query()).toEqual({ use: FIRST, tab: 'installed' });
    expect(focused(harness)).toEqual([`installed-${FIRST}`]);
    expect(scrolled).toEqual([`available-${FIRST}`, `installed-${FIRST}`]);

    await harness.navigateByUrl('/plugins', PluginsPage);
    await settle(harness);
    click(harness, `install-available-${SECOND}`);
    await settle(harness);
    expect(installReviewedUpdate).toHaveBeenCalledOnce();
    expect(query()).toEqual({});
    expect(page(harness).querySelector('[data-testid="plugin-message"]')?.textContent).toContain(
      'Updated',
    );
  });

  it('does not pull the user back when an install finishes after they left the page', async () => {
    let release: () => void = () => undefined;
    fetched = new Promise((done) => (release = done));
    install.mockImplementation(async () => plugins.set([installed(FIRST)]));
    const { harness } = await open('/plugins');
    click(harness, `install-available-${FIRST}`);

    await harness.navigateByUrl('/');
    release();
    await settle(harness);
    await settle(harness);
    expect(install).toHaveBeenCalledOnce();
    expect(TestBed.inject(Router).url).toBe('/');
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
            defaultsSettled: signal(true),
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
    await harness.navigateByUrl('/plugins?tab=installed', PluginsPage);
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

/**
 * A project importer on the Installed page no longer carries a form of its
 * own: it opens the dialog the editor's commands open, for that importer and
 * the installation shown.
 */
describe('PluginsPage project importers', () => {
  const SHADERTOY = 'dev.shadergrove.shadertoy';
  const shadertoy = installedPackage(officialPackageText(SHADERTOY));
  const context = { profile: 'anonymous', id: SHADERTOY, version: '1.0.0', installedAt: '' };
  const openImport = vi.fn();
  const provider: SourceProvider = {
    id: 'shadertoy-api/v1',
    fields: [],
    fetchSource: async () => ({ sourceId: 'x', source: {} }),
    fetchAsset: async () => new Uint8Array(),
  };

  beforeEach(() => {
    openImport.mockReset();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([
          { path: 'plugins', component: PluginsPage },
          { path: 'explore', children: [] },
          { path: '', children: [] },
        ]),
        I18n,
        { provide: Preferences, useValue: { value: signal({ language: 'en' }).asReadonly() } },
        {
          provide: PluginInstallations,
          useValue: {
            loading: signal(false),
            defaultsSettled: signal(true),
            plugins: signal([shadertoy]),
            profile: signal('anonymous'),
            find: (id: string) => (id === SHADERTOY ? shadertoy : undefined),
            context: (id: string) => (id === SHADERTOY ? context : null),
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
        { provide: SOURCE_PROVIDERS, useValue: provider, multi: true },
        { provide: PluginCommands, useValue: { openImport } },
        { provide: AppThemes, useValue: { entries: signal([]) } },
        { provide: EffectAdoption, useValue: {} },
        { provide: ShaderStore, useValue: { draft: signal(null) } },
        { provide: DesktopPlatform, useValue: { available: false } },
      ],
    });
  });

  afterEach(() => TestBed.resetTestingModule());

  async function show() {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/plugins?tab=installed', PluginsPage);
    harness.detectChanges();
    return harness;
  }

  const page = (harness: RouterTestingHarness) => harness.routeNativeElement as HTMLElement;
  const button = (harness: RouterTestingHarness) =>
    page(harness).querySelector<HTMLButtonElement>(
      `[data-testid="open-import-${SHADERTOY}/shadertoy"]`,
    );

  it('offers an Import action instead of a form, and opens the shared dialog with it', async () => {
    openImport.mockResolvedValue(undefined);
    const harness = await show();
    expect(page(harness).querySelector('textarea, [data-testid^="field-"]')).toBeNull();
    expect(button(harness)?.textContent?.trim()).toBe('Import…');

    button(harness)!.click();
    expect(openImport).toHaveBeenCalledWith(context, 'shadertoy');
  });

  it('reports a successful import here, warnings included, and goes to the editor on request', async () => {
    openImport.mockResolvedValueOnce({
      imported: { name: 'Parity', warnings: ['No sound pass.'] },
      toEditor: false,
    });
    const harness = await show();
    button(harness)!.click();
    await new Promise((done) => setTimeout(done, 0));
    harness.detectChanges();
    expect(page(harness).querySelector('[data-testid="plugin-message"]')?.textContent).toContain(
      'Imported “Parity”.',
    );
    expect(page(harness).querySelector('[data-testid="plugin-warnings"]')?.textContent).toContain(
      'No sound pass.',
    );

    openImport.mockResolvedValueOnce({
      imported: { name: 'Parity', warnings: ['No sound pass.'] },
      toEditor: true,
    });
    button(harness)!.click();
    await new Promise((done) => setTimeout(done, 0));
    expect(TestBed.inject(Router).url).toBe('/');
  });

  it('does not go to the editor for a dialog that closes after the user left the page', async () => {
    let finish: (result: unknown) => void = () => undefined;
    openImport.mockReturnValueOnce(new Promise((done) => (finish = done)));
    const harness = await show();
    button(harness)!.click();
    await harness.navigateByUrl('/explore');
    finish({ imported: { name: 'Parity', warnings: [] }, toEditor: true });
    await new Promise((done) => setTimeout(done, 0));
    expect(TestBed.inject(Router).url).toBe('/explore');
  });
});
