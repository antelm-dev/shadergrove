import { computed, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_THEMES_PACKAGE_ID,
  DEFAULT_THEME_REFS,
  parsePluginPackage,
} from '@shadergrove/shared/plugin';

import { AuthService } from '../auth/auth.service';
import { DesktopPlatform } from '../desktop/desktop-platform';
import { I18n } from '../i18n/i18n';
import { WallpaperWebRuntime } from '../rendering/wallpaper-runtime';
import { AppThemes } from '../themes/app-themes';
import { pluginThemeEntries, themePairs, type PluginThemeEntry } from '../themes/theme-catalog';
import { WorkspaceActions } from '../ui/workspace-actions';
import { ShaderStore } from '../workspace/shader-store';
import { EffectAdoption } from './effect-adoption';
import { SOURCE_PROVIDERS, provideHostAdapters, type SourceProvider } from './host-adapters';
import { PluginCommands } from './plugin-commands';
import { PLUGIN_STORE, PluginInstallations } from './plugin-installations';
import type { StoredPlugin } from './plugin-store';
import { ProjectPluginActions } from './project-actions';

/**
 * The menu entries plugins contribute, against the real installations and the
 * official packages: an entry exists exactly while its package is installed,
 * switched on and valid for the current profile — whichever way that stops
 * being true.
 */
const generated = resolve(import.meta.dirname, '../../plugins');
const SHADERTOY = 'dev.shadergrove.shadertoy';
const WALLPAPER = 'dev.shadergrove.wallpaper-engine';
const text = (id: string) => {
  const catalogue = JSON.parse(readFileSync(resolve(generated, 'catalogue.json'), 'utf8')) as {
    packages: { id: string; file: string }[];
  };
  return readFileSync(
    resolve(generated, catalogue.packages.find((p) => p.id === id)!.file),
    'utf8',
  );
};

/** A package that is not one of the official ones, doing the same job as Shadertoy Import. */
function rival(): string {
  const shadertoy = JSON.parse(text(SHADERTOY)) as {
    manifest: { id: string; name: string };
  };
  shadertoy.manifest.id = 'org.example.other-shadertoy';
  shadertoy.manifest.name = 'Other Shadertoy';
  return JSON.stringify(shadertoy);
}

/** A protocol-1 package with one effect, as a third party would ship it. */
function effectPackage(): string {
  return JSON.stringify({
    manifest: {
      id: 'dev.example.tint',
      version: '1.0.0',
      protocolVersion: 1,
      appVersionRange: '>=1.0.0',
      name: 'Tint',
      publisher: 'Example',
      license: 'MIT',
      contributions: [{ kind: 'effect', id: 'tint', name: 'Red tint', controls: [] }],
    },
    glsl: { tint: 'vec4 effect(vec4 c, vec2 uv) { return c * vec4(1.0, 0.5, 0.5, 1.0); }' },
  });
}

const themeEntries = signal<PluginThemeEntry[]>([]);
const selectPlugin = vi.fn();
const selectSystem = vi.fn();

describe('PluginCommands', () => {
  const user = signal<{ id: string } | null>(null);
  const status = signal<'loading' | 'anonymous' | 'authenticated'>('anonymous');
  const record = signal<{ id: string; name: string } | null>({ id: 'waves', name: 'Waves' });
  const navigate = vi.fn(async () => true);
  const adopt = vi.fn(() => ({ ok: true as const }));
  const notice = signal<{ text: string; error: boolean } | null>(null);
  let profiles: Map<string, Map<string, StoredPlugin>>;

  const provider: SourceProvider = {
    id: 'shadertoy-api/v1',
    command: { label: 'action.importShadertoy', icon: 'public' },
    fields: [],
    fetchSource: async () => ({ sourceId: 'x', source: {} }),
    fetchAsset: async () => new Uint8Array(),
  };

  function setup(): { commands: PluginCommands; installations: PluginInstallations } {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: PLUGIN_STORE,
          useValue: (profile: string) => {
            const records = profiles.get(profile) ?? new Map<string, StoredPlugin>();
            profiles.set(profile, records);
            return {
              list: async () => [...records.values()],
              put: async (stored: StoredPlugin) => void records.set(stored.id, stored),
              remove: async (id: string) => void records.delete(id),
              readBootstrap: async () => null,
              writeBootstrap: async () => undefined,
            };
          },
        },
        { provide: AuthService, useValue: { user, status } },
        { provide: DesktopPlatform, useValue: { available: false } },
        {
          provide: I18n,
          useValue: {
            t: (key: string, params?: object) =>
              params ? `${key} ${JSON.stringify(params)}` : key,
          },
        },
        { provide: WorkspaceActions, useValue: {} },
        {
          provide: ShaderStore,
          useValue: { selectedId: signal('waves'), record, notice },
        },
        {
          provide: AppThemes,
          useValue: {
            entries: themeEntries,
            pairs: computed(() => themePairs(themeEntries())),
            selectPlugin,
            selectSystem,
          },
        },
        { provide: EffectAdoption, useValue: { adopt } },
        { provide: Router, useValue: { navigate } },
        { provide: SOURCE_PROVIDERS, useValue: provider, multi: true },
        provideHostAdapters({ exportRuntimes: [WallpaperWebRuntime] }),
      ],
    });
    return {
      commands: TestBed.inject(PluginCommands),
      installations: TestBed.inject(PluginInstallations),
    };
  }

  async function settle(): Promise<void> {
    TestBed.tick();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  async function install(installations: PluginInstallations, source: string): Promise<string> {
    const review = installations.review(new TextEncoder().encode(source));
    if (!review.ok) throw new Error(review.errors.join());
    await installations.install(review);
    return review.plugin.manifest.id;
  }

  const labels = (commands: readonly { label: () => string }[]) =>
    commands.map((command) => command.label());

  beforeEach(() => {
    profiles = new Map();
    user.set(null);
    status.set('anonymous');
    record.set({ id: 'waves', name: 'Waves' });
    navigate.mockClear();
    adopt.mockClear();
    notice.set(null);
  });

  afterEach(() => TestBed.resetTestingModule());

  it('offers every active theme and System for each pair, selecting through the theme service', async () => {
    const parsed = parsePluginPackage(text(DEFAULT_THEMES_PACKAGE_ID));
    if (!parsed.ok) throw new Error(parsed.errors.join());
    const id = DEFAULT_THEMES_PACKAGE_ID;
    themeEntries.set(
      pluginThemeEntries([
        {
          id,
          stored: { id, text: '', enabled: true, installedAt: '' },
          plugin: parsed.value,
          problem: null,
          active: true,
        },
      ]),
    );
    const { commands } = setup();
    await settle();
    const themes = commands.themeCommands();
    // The app's own themes read in the app's language.
    expect(labels(themes)).toEqual([
      'menu.theme: theme.light',
      'menu.theme: theme.dark',
      'menu.theme: theme.system',
    ]);
    expect(themes.map((command) => command.icon())).toEqual([
      'light_mode',
      'dark_mode',
      'contrast',
    ]);

    themes[1]!.action();
    themes[2]!.action();
    expect(selectPlugin).toHaveBeenCalledWith(DEFAULT_THEME_REFS.dark);
    expect(selectSystem).toHaveBeenCalledWith(`${id}/default`);

    themeEntries.set([]);
    expect(commands.themeCommands()).toEqual([]);
  });

  it('offers nothing for a package that is missing, or installed but switched off', async () => {
    const { commands, installations } = setup();
    await settle();
    expect(commands.imports()).toEqual([]);
    expect(commands.exports()).toEqual([]);

    await install(installations, text(SHADERTOY));
    await install(installations, text(WALLPAPER));
    expect(commands.imports()).toEqual([]);
    expect(commands.exports()).toEqual([]);
  });

  it('follows switching on, switching off and removal at once', async () => {
    const { commands, installations } = setup();
    await settle();
    await install(installations, text(SHADERTOY));
    await install(installations, text(WALLPAPER));

    await installations.setEnabled(SHADERTOY, true);
    await installations.setEnabled(WALLPAPER, true);
    expect(labels(commands.imports())).toEqual(['action.importShadertoy']);
    expect(commands.imports()[0].ref).toBe(`${SHADERTOY}/shadertoy`);
    expect(commands.imports()[0].icon()).toBe('public');
    expect(labels(commands.exports())).toEqual(['action.exportWallpaper']);
    expect(commands.exports()[0].icon()).toBe('wallpaper');

    await installations.setEnabled(WALLPAPER, false);
    expect(commands.exports()).toEqual([]);
    expect(commands.imports()).toHaveLength(1);

    await installations.remove(SHADERTOY);
    expect(commands.imports()).toEqual([]);
  });

  it('belongs to the profile: signing in shows that account’s plugins, not the last one’s', async () => {
    const { commands, installations } = setup();
    await settle();
    await install(installations, text(SHADERTOY));
    await installations.setEnabled(SHADERTOY, true);
    expect(commands.imports()).toHaveLength(1);

    user.set({ id: 'u1' });
    status.set('authenticated');
    await settle();
    expect(commands.imports()).toEqual([]);

    user.set(null);
    status.set('anonymous');
    await settle();
    expect(commands.imports()).toHaveLength(1);
  });

  it('dims an export while no shader is open', async () => {
    const { commands, installations } = setup();
    await settle();
    await install(installations, text(WALLPAPER));
    await installations.setEnabled(WALLPAPER, true);
    const [exporter] = commands.exports();
    expect(exporter.disabled?.()).toBe(false);
    record.set(null);
    expect(exporter.disabled?.()).toBe(true);
  });

  it('keeps every plugin doing the same job, each named by its package', async () => {
    const { commands, installations } = setup();
    await settle();
    await install(installations, text(SHADERTOY));
    const other = await install(installations, rival());
    await installations.setEnabled(SHADERTOY, true);
    await installations.setEnabled(other, true);

    expect(commands.imports().map((command) => command.ref)).toEqual([
      `${SHADERTOY}/shadertoy`,
      `${other}/shadertoy`,
    ]);
    expect(labels(commands.imports())).toEqual([
      'action.importShadertoy (Shadertoy Import)',
      'action.importShadertoy (Other Shadertoy)',
    ]);

    // Each opens its own package's form in Plugins, not the first one found.
    commands.imports()[1].action();
    expect(navigate).toHaveBeenCalledWith(['/plugins'], { queryParams: { use: other } });
  });

  it('adds an effect only while the package it was offered for is still the current one', async () => {
    const { commands, installations } = setup();
    await settle();
    const tint = await install(installations, effectPackage());
    await installations.setEnabled(tint, true);
    expect(labels(commands.effects())).toEqual(['action.addPluginEffect {"name":"Red tint"}']);

    commands.effects()[0].action();
    expect(adopt).toHaveBeenCalledOnce();
    expect(adopt.mock.calls[0]).toEqual([expect.objectContaining({ name: 'Red tint' })]);

    // The palette keeps the commands it opened with; under another profile they must not run.
    const [kept] = commands.effects();
    user.set({ id: 'u1' });
    status.set('authenticated');
    await settle();
    expect(commands.effects()).toEqual([]);
    kept.action();
    expect(adopt).toHaveBeenCalledOnce();
    expect(notice()).toEqual({ text: 'plugins.staleResult', error: true });

    // Back on the first profile, but the package was removed and installed again: still stale.
    user.set(null);
    status.set('anonymous');
    await settle();
    const [before] = commands.effects();
    await installations.remove(tint);
    // An install is stamped to the millisecond: make sure the new one is later.
    await new Promise((done) => setTimeout(done, 5));
    await install(installations, effectPackage());
    await installations.setEnabled(tint, true);
    before.action();
    expect(adopt).toHaveBeenCalledOnce();
    commands.effects()[0].action();
    expect(adopt).toHaveBeenCalledTimes(2);
  });

  it('refuses a kept export command once its package is switched off', async () => {
    const { commands, installations } = setup();
    await settle();
    await install(installations, text(WALLPAPER));
    await installations.setEnabled(WALLPAPER, true);
    const run = vi
      .spyOn(TestBed.inject(ProjectPluginActions), 'runExport')
      .mockResolvedValue({ status: 'cancelled' });
    const [kept] = commands.exports();
    await installations.setEnabled(WALLPAPER, false);
    kept.action();
    expect(run).not.toHaveBeenCalled();
    expect(notice()).toEqual({ text: 'plugins.staleResult', error: true });
  });

  it('runs an export through its own contribution', async () => {
    const { commands, installations } = setup();
    await settle();
    await install(installations, text(WALLPAPER));
    await installations.setEnabled(WALLPAPER, true);
    const run = vi
      .spyOn(TestBed.inject(ProjectPluginActions), 'runExport')
      .mockResolvedValue({ status: 'cancelled' });
    commands.exports()[0].action();
    expect(run).toHaveBeenCalledWith(WALLPAPER, 'wallpaper-engine');
  });
});
