import { DOCUMENT, PLATFORM_ID, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
      remove: async (id) => void records.delete(id),
      readBootstrap: async () => null,
      writeBootstrap: async () => undefined,
    };
  }

  seed(profile: string, text: string, enabled: boolean): void {
    void this.for(profile);
    this.byProfile.get(profile)!.set(PACKAGE_ID, {
      id: PACKAGE_ID,
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
              matchMedia: () => null,
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
    expect(preferences.value()).toMatchObject({ appThemeId: LIGHT, colorScheme: 'dark' });
    expect(JSON.parse(storage.get(STORAGE_KEY)!).appThemeId).toBe(LIGHT);

    themes.selectBuiltin('system');
    await settle();
    expect(preferences.value()).toMatchObject({ appThemeId: 'builtin', colorScheme: 'system' });
    expect(painted()).toEqual([]);
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
