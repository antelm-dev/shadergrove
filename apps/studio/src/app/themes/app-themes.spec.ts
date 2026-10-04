import { DOCUMENT, PLATFORM_ID, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { DEFAULT_THEMES_PACKAGE_ID, DEFAULT_THEME_REFS } from '@shadergrove/shared/plugin';

import { AuthService } from '../auth/auth.service';
import { EditorSettings } from '../editor/editor-settings';
import { monacoThemeId } from '../editor/editor-themes';
import type { MonacoApi } from '../editor/monaco-loader';
import { PLUGIN_STORE, PluginInstallations } from '../plugins/plugin-installations';
import type { PluginStore, StoredPlugin } from '../plugins/plugin-store';
import { Preferences } from '../prefs/preferences';
import { AppThemes } from './app-themes';
import { pluginMonacoThemeId } from './theme-catalog';

const STORAGE_KEY = 'shader-studio.preferences';
const PACKAGE_ID = 'dev.shadergrove.grove-amber';
const DARK = `plugin:${PACKAGE_ID}/amber-dark` as const;
const LIGHT = `plugin:${PACKAGE_ID}/amber-light` as const;

const amberText = readFileSync(
  resolve(
    import.meta.dirname,
    '../../../../../tools/workspace/fixtures/plugins/themes/grove-amber.sgplugin.json',
  ),
  'utf8',
);

/** The official Light/Dark pack, exactly as this release ships it. */
const pluginsDir = resolve(import.meta.dirname, '../../plugins');
const defaultThemesText = readFileSync(
  resolve(
    pluginsDir,
    (
      JSON.parse(readFileSync(resolve(pluginsDir, 'catalogue.json'), 'utf8')) as {
        packages: { id: string; file: string }[];
      }
    ).packages.find((entry) => entry.id === DEFAULT_THEMES_PACKAGE_ID)!.file,
  ),
  'utf8',
);

/** The fixture with the dark theme's primary changed: a new release of the same package. */
function amberUpdate(primary: string, version = '1.1.0'): string {
  const json = JSON.parse(amberText);
  json.manifest.version = version;
  json.manifest.contributions[0].ui.primary = primary;
  json.manifest.contributions[0].editor.tokens.keyword = primary;
  return JSON.stringify(json);
}

class MemoryStores {
  readonly byProfile = new Map<string, Map<string, StoredPlugin>>();

  for(profile: string): PluginStore {
    const records = this.byProfile.get(profile) ?? new Map<string, StoredPlugin>();
    this.byProfile.set(profile, records);
    return {
      list: async () => [...records.values()],
      put: async (record) => void records.set(record.id, record),
      add: async (record) => {
        if (records.has(record.id)) return false;
        records.set(record.id, record);
        return true;
      },
      replace: async (record) => {
        if (records.get(record.id)?.installedAt !== record.installedAt) return false;
        records.set(record.id, record);
        return true;
      },
      removeIf: async (expected) => {
        const stored = records.get(expected.id);
        if (JSON.stringify(stored) !== JSON.stringify(expected)) return false;
        records.delete(expected.id);
        return true;
      },
      remove: async (id) => void records.delete(id),
      readBootstrap: async () => null,
      writeBootstrap: async () => undefined,
    };
  }

  seed(profile: string, text: string, enabled: boolean, id = PACKAGE_ID): void {
    void this.for(profile);
    this.byProfile.get(profile)!.set(id, {
      id,
      text,
      enabled,
      installedAt: '2026-10-02T00:00:00.000Z',
    });
  }
}

/** Records what reaches Monaco's global theme registry. */
function fakeMonaco() {
  const defined = new Map<string, { colors: Record<string, string>; rules: unknown[] }>();
  const set: string[] = [];
  const api = {
    editor: {
      defineTheme: vi.fn(
        (name: string, data: { colors: Record<string, string>; rules: unknown[] }) => {
          defined.set(name, data);
        },
      ),
      setTheme: vi.fn((name: string) => void set.push(name)),
    },
  };
  return { api: api as unknown as MonacoApi, defined, set, current: () => set.at(-1) };
}

describe('AppThemes', () => {
  let stores: MemoryStores;
  let storage: Map<string, string>;
  let root: HTMLElement;
  const user = signal<{ id: string } | null>(null);
  const status = signal<'loading' | 'anonymous' | 'authenticated'>('anonymous');
  const workers = vi.fn();
  /** The OS's light/dark setting, as `matchMedia` reports it. */
  const os = {
    dark: true,
    listeners: new Set<(event: { matches: boolean }) => void>(),
    set(dark: boolean) {
      this.dark = dark;
      for (const listener of this.listeners) listener({ matches: dark });
    },
  };

  function setup(stored?: object): {
    themes: AppThemes;
    installations: PluginInstallations;
    preferences: Preferences;
    settings: EditorSettings;
  } {
    if (stored) storage.set(STORAGE_KEY, JSON.stringify(stored));
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: PLATFORM_ID, useValue: 'browser' },
        {
          provide: DOCUMENT,
          useValue: {
            defaultView: {
              localStorage: {
                getItem: (key: string) => storage.get(key) ?? null,
                setItem: (key: string, value: string) => storage.set(key, value),
              },
              matchMedia: () => ({
                get matches() {
                  return os.dark;
                },
                addEventListener: (_: string, listener: (event: { matches: boolean }) => void) =>
                  os.listeners.add(listener),
              }),
            },
            documentElement: root,
          },
        },
        { provide: PLUGIN_STORE, useValue: (profile: string) => stores.for(profile) },
        { provide: AuthService, useValue: { user, status } },
      ],
    });
    const themes = TestBed.inject(AppThemes);
    themes.start();
    return {
      themes,
      installations: TestBed.inject(PluginInstallations),
      preferences: TestBed.inject(Preferences),
      settings: TestBed.inject(EditorSettings),
    };
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      TestBed.tick();
      for (let j = 0; j < 5; j++) await Promise.resolve();
    }
  }

  const css = (name: string) => root.style.getPropertyValue(name);
  const painted = () =>
    Array.from({ length: root.style.length }, (_, i) => root.style.item(i))
      .filter((property) => property.startsWith('--mat-sys-'))
      .sort();

  beforeEach(() => {
    stores = new MemoryStores();
    storage = new Map();
    root = document.createElement('html');
    user.set(null);
    status.set('anonymous');
    workers.mockReset();
    vi.stubGlobal('Worker', workers);
    os.dark = true;
    os.listeners.clear();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
  });

  it('paints the built-in theme in the remembered scheme, with no token overridden', async () => {
    setup({ colorScheme: 'light' });
    await settle();
    expect(root.style.colorScheme).toBe('light');
    expect(painted()).toEqual([]);
    expect(root.dataset['appTheme']).toBeUndefined();
  });

  it('selects nothing when a theme package is installed and switched on', async () => {
    const { themes, installations } = setup();
    await settle();
    const review = installations.review(new TextEncoder().encode(amberText));
    if (!review.ok) throw new Error(review.errors.join());
    await installations.install(review);
    await installations.setEnabled(PACKAGE_ID, true);
    await settle();

    expect(themes.entries().map((entry) => entry.ref)).toEqual([DARK, LIGHT]);
    expect(themes.app().kind).toBe('builtin');
    expect(painted()).toEqual([]);
  });

  it('wears a plugin theme in its own scheme, keeping the built-in scheme for later', async () => {
    stores.seed('anonymous', amberText, true);
    const { themes, preferences } = setup({ colorScheme: 'dark' });
    await settle();

    themes.selectPlugin(LIGHT);
    await settle();
    expect(root.style.colorScheme).toBe('light');
    expect(css('--mat-sys-surface')).toBe('#fbf6ef');
    expect(css('--mat-sys-primary')).toBe('#8a5100');
    expect(root.dataset['appTheme']).toBe(LIGHT);
    expect(themes.icon()).toBe('palette');
    // The fallback takes the theme's scheme, so losing the theme does not flip light to dark.
    expect(preferences.value()).toMatchObject({
      appThemeId: LIGHT,
      appThemeMode: 'fixed',
      colorScheme: 'light',
    });
    expect(JSON.parse(storage.get(STORAGE_KEY)!).appThemeId).toBe(LIGHT);
    expect(themes.isFixed(LIGHT)).toBe(true);
    expect(themes.pairs()).toEqual([]);
  });

  it('clears the roles of a complete theme before applying a partial one', async () => {
    stores.seed('anonymous', amberText, true);
    const { themes } = setup();
    await settle();

    themes.selectPlugin(DARK);
    await settle();
    expect(css('--mat-sys-secondary')).toBe('#d9b98c');
    expect(css('--mat-sys-error')).toBe('#ffb4a8');

    themes.selectPlugin(LIGHT);
    await settle();
    expect(css('--mat-sys-secondary')).toBe('');
    expect(css('--mat-sys-error')).toBe('');
    expect(css('--mat-sys-primary')).toBe('#8a5100');
  });

  it('restores the built-in when the package is switched off, and the choice when it is back', async () => {
    stores.seed('anonymous', amberText, true);
    const { themes, installations, preferences } = setup({ appThemeId: DARK });
    await settle();
    expect(css('--mat-sys-primary')).toBe('#f2a93b');

    await installations.setEnabled(PACKAGE_ID, false);
    await settle();
    expect(themes.app().kind).toBe('builtin');
    expect(painted()).toEqual([]);
    expect(preferences.value().appThemeId).toBe(DARK);

    await installations.setEnabled(PACKAGE_ID, true);
    await settle();
    expect(css('--mat-sys-primary')).toBe('#f2a93b');
  });

  it('restores the built-in when the package is removed, replaced or incompatible', async () => {
    stores.seed('anonymous', amberText, true);
    const { installations } = setup({ appThemeId: DARK });
    await settle();
    expect(painted()).not.toEqual([]);

    // A replacement installs switched off.
    const review = installations.review(new TextEncoder().encode(amberUpdate('#ff0000')));
    if (!review.ok) throw new Error(review.errors.join());
    await installations.install(review);
    await settle();
    expect(painted()).toEqual([]);

    await installations.remove(PACKAGE_ID);
    await settle();
    expect(painted()).toEqual([]);
    expect(root.style.colorScheme).toBe('dark');

    const incompatible = JSON.parse(amberText);
    incompatible.manifest.appVersionRange = '>=99.0.0';
    stores.seed('anonymous', JSON.stringify(incompatible), true);
    TestBed.resetTestingModule();
    root = document.createElement('html');
    setup();
    await settle();
    expect(painted()).toEqual([]);
  });

  it('applies the new colours of a same-id update, in the UI and in Monaco', async () => {
    stores.seed('anonymous', amberText, true);
    const { themes, installations } = setup({ appThemeId: DARK });
    await settle();
    const monaco = fakeMonaco();
    themes.attachMonaco(monaco.api);
    const id = pluginMonacoThemeId(DARK);
    expect(monaco.current()).toBe(id);
    expect(monaco.defined.get(id)?.colors['editor.background']).toBe('#1a1611');

    const review = installations.review(new TextEncoder().encode(amberUpdate('#00aa55')));
    if (!review.ok) throw new Error(review.errors.join());
    await installations.install(review);
    await installations.setEnabled(PACKAGE_ID, true);
    await settle();

    expect(css('--mat-sys-primary')).toBe('#00aa55');
    expect(monaco.current()).toBe(id);
    expect(JSON.stringify(monaco.defined.get(id)?.rules)).toContain('00aa55');
  });

  it('paints only the built-in while the session resolves, and never another profile’s theme', async () => {
    stores.seed('anonymous', amberText, true);
    status.set('loading');
    const { themes } = setup({ appThemeId: DARK });
    await settle();
    expect(painted()).toEqual([]);

    status.set('anonymous');
    await settle();
    expect(css('--mat-sys-primary')).toBe('#f2a93b');

    // Bob has not installed it: his profile shows the built-in, the choice survives.
    user.set({ id: 'bob' });
    status.set('authenticated');
    await settle();
    expect(themes.entries()).toEqual([]);
    expect(painted()).toEqual([]);
  });

  it('starts no plugin Worker to list or apply themes', async () => {
    stores.seed('anonymous', amberText, true);
    const { themes } = setup({ appThemeId: DARK });
    await settle();
    themes.attachMonaco(fakeMonaco().api);
    await settle();
    expect(workers).not.toHaveBeenCalled();
  });

  describe('the default Light/Dark pack', () => {
    const { light: OFFICIAL_LIGHT, dark: OFFICIAL_DARK } = DEFAULT_THEME_REFS;
    const KEY = `${DEFAULT_THEMES_PACKAGE_ID}/default`;

    it('migrates a legacy fixed scheme once, onto the official theme it was showing', async () => {
      stores.seed('anonymous', defaultThemesText, true, DEFAULT_THEMES_PACKAGE_ID);
      let { themes, preferences } = setup({ colorScheme: 'light' });
      await settle();
      expect(preferences.value()).toMatchObject({
        appThemeId: OFFICIAL_LIGHT,
        appThemeMode: 'fixed',
        colorScheme: 'light',
      });
      expect(themes.isFixed(OFFICIAL_LIGHT)).toBe(true);
      expect(root.style.colorScheme).toBe('light');
      // The same colours the stylesheet's fallback paints, now inline.
      expect(css('--mat-sys-surface')).toBe('#f7f7f8');
      expect(css('--mat-sys-primary')).toBe('#276c00');
      expect(themes.icon()).toBe('light_mode');

      // A later choice is never overwritten again, on restart or anywhere else.
      themes.selectPlugin(OFFICIAL_DARK);
      await settle();
      TestBed.resetTestingModule();
      ({ themes, preferences } = setup());
      await settle();
      expect(preferences.value().appThemeId).toBe(OFFICIAL_DARK);
      expect(css('--mat-sys-surface')).toBe('#141416');
    });

    it('migrates legacy System to System mode, which follows the OS in the UI and Monaco', async () => {
      stores.seed('anonymous', defaultThemesText, true, DEFAULT_THEMES_PACKAGE_ID);
      os.dark = false;
      const { themes, preferences } = setup({ colorScheme: 'system' });
      await settle();
      expect(preferences.value()).toMatchObject({
        appThemeId: OFFICIAL_LIGHT,
        appThemeMode: 'system',
        colorScheme: 'system',
      });
      expect(themes.isSystemSelected(KEY)).toBe(true);
      expect(themes.isFixed(OFFICIAL_LIGHT)).toBe(false);
      expect(themes.icon()).toBe('contrast');
      const monaco = fakeMonaco();
      themes.attachMonaco(monaco.api);
      expect(monaco.current()).toBe(pluginMonacoThemeId(OFFICIAL_LIGHT));

      os.set(true);
      await settle();
      expect(themes.app()).toMatchObject({ kind: 'plugin', scheme: 'dark' });
      expect(root.style.colorScheme).toBe('dark');
      expect(css('--mat-sys-surface')).toBe('#141416');
      expect(monaco.current()).toBe(pluginMonacoThemeId(OFFICIAL_DARK));
      // The stored choice did not move; only what it resolves to.
      expect(preferences.value().appThemeId).toBe(OFFICIAL_LIGHT);

      themes.selectPlugin(OFFICIAL_LIGHT);
      await settle();
      os.set(false);
      os.set(true);
      await settle();
      expect(themes.app()).toMatchObject({ scheme: 'light' });
      expect(preferences.value()).toMatchObject({ appThemeMode: 'fixed', colorScheme: 'light' });

      themes.selectSystem(KEY);
      await settle();
      expect(preferences.value()).toMatchObject({
        appThemeId: OFFICIAL_DARK,
        appThemeMode: 'system',
        colorScheme: 'system',
      });
    });

    it('never migrates onto a pack that is not active, and does once it is', async () => {
      stores.seed('anonymous', defaultThemesText, false, DEFAULT_THEMES_PACKAGE_ID);
      const { installations, preferences } = setup({ colorScheme: 'dark' });
      await settle();
      expect(preferences.value().appThemeId).toBe('builtin');
      expect(painted()).toEqual([]);
      expect(root.style.colorScheme).toBe('dark');

      await installations.setEnabled(DEFAULT_THEMES_PACKAGE_ID, true);
      await settle();
      expect(preferences.value()).toMatchObject({
        appThemeId: OFFICIAL_DARK,
        appThemeMode: 'fixed',
      });
    });

    it('keeps a third-party theme and a pinned editor theme as they were', async () => {
      stores.seed('anonymous', amberText, true);
      stores.seed('anonymous', defaultThemesText, true, DEFAULT_THEMES_PACKAGE_ID);
      const { preferences } = setup({
        appThemeId: DARK,
        colorScheme: 'light',
        editorAppearance: { theme: 'parchment' },
      });
      await settle();
      expect(preferences.value()).toMatchObject({ appThemeId: DARK, appThemeMode: 'fixed' });
      expect(preferences.value().editorAppearance.theme).toBe('parchment');
      expect(css('--mat-sys-primary')).toBe('#f2a93b');
    });

    it('paints the fallback, keeping the choice, while the pack is off — and offers System only for pairs', async () => {
      stores.seed('anonymous', amberText, true);
      stores.seed('anonymous', defaultThemesText, true, DEFAULT_THEMES_PACKAGE_ID);
      const { themes, installations, preferences } = setup({
        appThemeId: OFFICIAL_DARK,
        appThemeMode: 'system',
        colorScheme: 'system',
      });
      await settle();
      expect(themes.pairs().map((pair) => pair.key)).toEqual([KEY]);

      await installations.setEnabled(DEFAULT_THEMES_PACKAGE_ID, false);
      await settle();
      expect(themes.app().kind).toBe('builtin');
      expect(painted()).toEqual([]);
      expect(themes.pairs()).toEqual([]);
      expect(preferences.value()).toMatchObject({
        appThemeId: OFFICIAL_DARK,
        appThemeMode: 'system',
      });

      // A command kept from before cannot select what is no longer there.
      themes.selectPlugin(OFFICIAL_LIGHT);
      themes.selectSystem(KEY);
      await settle();
      expect(preferences.value()).toMatchObject({
        appThemeId: OFFICIAL_DARK,
        appThemeMode: 'system',
      });
    });
  });

  describe('Monaco', () => {
    it('paints the built-in before the catalogue loads, then the plugin theme', async () => {
      stores.seed('anonymous', amberText, true);
      status.set('loading');
      const { themes } = setup({ appThemeId: LIGHT });
      const monaco = fakeMonaco();
      themes.attachMonaco(monaco.api);
      expect(monaco.current()).toBe(monacoThemeId('studio-dark'));

      status.set('anonymous');
      await settle();
      const id = pluginMonacoThemeId(LIGHT);
      // Defined before it is selected.
      const defineOrder = monaco.api.editor.defineTheme as ReturnType<typeof vi.fn>;
      const setOrder = monaco.api.editor.setTheme as ReturnType<typeof vi.fn>;
      const definedAt = defineOrder.mock.invocationCallOrder.at(-1)!;
      const setAt = setOrder.mock.invocationCallOrder.at(-1)!;
      expect(monaco.current()).toBe(id);
      expect(definedAt).toBeLessThan(setAt);
    });

    it('keeps an explicit editor choice, and previews and cancels a plugin one', async () => {
      stores.seed('anonymous', amberText, true);
      const { themes, settings, preferences } = setup({
        appThemeId: LIGHT,
        editorAppearance: { theme: 'midnight' },
      });
      await settle();
      const monaco = fakeMonaco();
      themes.attachMonaco(monaco.api);
      expect(monaco.current()).toBe(monacoThemeId('midnight'));

      settings.beginPreview();
      settings.preview({ theme: DARK });
      await settle();
      expect(monaco.current()).toBe(pluginMonacoThemeId(DARK));

      settings.cancelPreview();
      await settle();
      expect(monaco.current()).toBe(monacoThemeId('midnight'));
      expect(preferences.value().editorAppearance.theme).toBe('midnight');

      settings.beginPreview();
      settings.preview({ theme: DARK });
      settings.commit();
      await settle();
      expect(preferences.value().editorAppearance.theme).toBe(DARK);
      expect(monaco.current()).toBe(pluginMonacoThemeId(DARK));
    });

    it('follows the app when a pinned plugin theme goes away', async () => {
      stores.seed('anonymous', amberText, true);
      const { themes, installations } = setup({ editorAppearance: { theme: DARK } });
      await settle();
      const monaco = fakeMonaco();
      themes.attachMonaco(monaco.api);
      expect(monaco.current()).toBe(pluginMonacoThemeId(DARK));

      await installations.remove(PACKAGE_ID);
      await settle();
      expect(monaco.current()).toBe(monacoThemeId('studio-dark'));
    });
  });
});
