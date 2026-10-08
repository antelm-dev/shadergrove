import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { DOCUMENT, PLATFORM_ID, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ɵ$localize as $localize } from '@angular/localize';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_LANGUAGE_REFS,
  ENGLISH_PACKAGE_ID,
  FRENCH_PACKAGE_ID,
  type LanguagePackId,
} from '@shadergrove/shared/plugin';

import { PluginInstallations, type InstalledPlugin } from '../plugins/plugin-installations';
import { Preferences, type WorkspacePreferences } from '../prefs/preferences';
import { I18n } from './i18n';
import { officialPackageText } from '../plugins/testing/official-packages';
import { installedPackage } from './testing/languages';

const spanishText = readFileSync(
  resolve(
    import.meta.dirname,
    '../../../../../tools/workspace/fixtures/plugins/languages/spanish-test.sgplugin.json',
  ),
  'utf8',
);
const SPANISH = 'plugin:dev.shadergrove.test-spanish/spanish' as const;
const FRENCH = DEFAULT_LANGUAGE_REFS.fr;

/** The fixture again, under another package: the same locale and name, from someone else. */
function rivalSpanish(): string {
  const json = JSON.parse(spanishText);
  json.manifest.id = 'org.example.spanish';
  json.manifest.name = 'Other Spanish';
  json.manifest.contributions[0].messages['browser.title'] = 'Shaders (otro)';
  return JSON.stringify(json);
}

describe('I18n', () => {
  let root: HTMLElement;
  const prefs = signal<Pick<WorkspacePreferences, 'language' | 'languagePackId'>>({
    language: 'en',
    languagePackId: null,
  });
  const plugins = signal<InstalledPlugin[]>([]);
  const loading = signal(false);
  const defaultsSettled = signal(false);

  function setup(platform = 'browser'): I18n {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: PLATFORM_ID, useValue: platform },
        { provide: DOCUMENT, useValue: { documentElement: root } },
        {
          provide: Preferences,
          useValue: {
            value: prefs.asReadonly(),
            patch: (patch: Partial<WorkspacePreferences>) =>
              prefs.update((value) => ({ ...value, ...patch })),
          },
        },
        { provide: PluginInstallations, useValue: { plugins, loading, defaultsSettled } },
      ],
    });
    const i18n = TestBed.inject(I18n);
    TestBed.tick();
    return i18n;
  }

  const choose = (languagePackId: LanguagePackId, language = 'en') => {
    prefs.set({ language, languagePackId });
    TestBed.tick();
  };

  beforeEach(() => {
    root = document.createElement('html');
    prefs.set({ language: 'en', languagePackId: null });
    plugins.set([
      installedPackage(officialPackageText(ENGLISH_PACKAGE_ID)),
      installedPackage(officialPackageText(FRENCH_PACKAGE_ID)),
    ]);
    loading.set(false);
    defaultsSettled.set(false);
  });

  afterEach(() => TestBed.resetTestingModule());

  it('speaks the bundled English with no plugin at all, in t and $localize alike', () => {
    plugins.set([]);
    const i18n = setup();
    expect(i18n.languages()).toEqual([]);
    expect(i18n.t('action.saveShader')).toBe('Save shader');
    expect($localize.locale).toBe('en');
    expect($localize`:@@action.saveShader:Save shader`).toBe('Save shader');
    expect(root.lang).toBe('en');
    expect(root.dir).toBe('ltr');
    expect(i18n.isSelected('fallback-en')).toBe(true);
  });

  it('speaks a chosen pack, with its placeholders filled, in t and $localize alike', () => {
    const i18n = setup();
    i18n.select(FRENCH);
    TestBed.tick();
    expect(prefs()).toEqual({ language: 'fr', languagePackId: FRENCH });
    expect(i18n.locale()).toBe('fr');
    expect(root.lang).toBe('fr');
    expect(i18n.t('action.saveShader')).toBe('Enregistrer le shader');
    expect(i18n.t('notice.shaderNotFound', { name: 'Plasma' })).toBe(
      'Le shader « Plasma » est introuvable',
    );
    expect($localize.locale).toBe('fr');
    expect($localize`:@@notice.shaderNotFound:Shader “${'Plasma'}:name:” was not found`).toBe(
      'Le shader « Plasma » est introuvable',
    );
    expect(i18n.isSelected(FRENCH)).toBe(true);
    expect(i18n.isSelected('fallback-en')).toBe(false);
  });

  it('reads a key a partial pack leaves out in English — the same in t and $localize', () => {
    plugins.update((list) => [...list, installedPackage(spanishText)]);
    const i18n = setup();
    i18n.select(SPANISH);
    TestBed.tick();
    expect(i18n.t('browser.controlMany', { count: 17 })).toBe('17 controles');
    expect(i18n.t('browser.presetMany', { count: 3 })).toBe('3 presets');
    expect($localize`:@@browser.title:Shaders`).toBe('Sombreadores');
    expect($localize`:@@browser.presetMany:${3}:count: presets`).toBe('3 presets');
  });

  it('formats dates, numbers and lists for the language worn, and follows a change at once', () => {
    plugins.update((list) => [...list, installedPackage(spanishText)]);
    const i18n = setup();
    const date = new Date(Date.UTC(2026, 9, 4, 12, 0, 0));
    const options: Intl.DateTimeFormatOptions = { dateStyle: 'long', timeZone: 'UTC' };
    expect(i18n.formatNumber(1234.567)).toBe('1,234.57');
    expect(i18n.formatDate(date, options)).toBe('October 4, 2026');
    expect(i18n.formatList(['A', 'B', 'C'])).toBe('A, B, and C');

    i18n.select(SPANISH);
    TestBed.tick();
    expect(i18n.formatNumber(0.5)).toBe('0,5');
    expect(i18n.formatDate(date, options)).toBe('4 de octubre de 2026');
    expect(i18n.formatList(['A', 'B', 'C'])).toBe('A, B y C');

    i18n.select(FRENCH);
    TestBed.tick();
    expect(i18n.formatList(['A', 'B'])).toBe('A et B');
    expect(i18n.formatDate('not a date')).toBe('');
  });

  it('keeps two packs of the same language apart, by reference, each named by its package', () => {
    plugins.update((list) => [
      ...list,
      installedPackage(spanishText),
      installedPackage(rivalSpanish()),
    ]);
    const i18n = setup();
    const spanish = i18n.languages().filter((entry) => entry.language.locale === 'es');
    expect(spanish.map((entry) => i18n.label(entry))).toEqual([
      'Español (Spanish (test fixture))',
      'Español (Other Spanish)',
    ]);
    // The app's own packs need no credit.
    expect(
      i18n
        .languages()
        .slice(0, 2)
        .map((entry) => i18n.label(entry)),
    ).toEqual(['English', 'Français']);
    i18n.select('plugin:org.example.spanish/spanish');
    TestBed.tick();
    expect(i18n.t('browser.title')).toBe('Shaders (otro)');
    expect(i18n.isSelected(SPANISH)).toBe(false);
  });

  it('falls back to English while the chosen pack is off or gone, and keeps the choice', () => {
    const i18n = setup();
    choose(FRENCH, 'fr');
    expect(i18n.locale()).toBe('fr');

    plugins.update((list) =>
      list.map((p) => (p.id === FRENCH_PACKAGE_ID ? { ...p, active: false } : p)),
    );
    TestBed.tick();
    expect(i18n.locale()).toBe('en');
    expect(i18n.t('action.saveShader')).toBe('Save shader');
    expect($localize.locale).toBe('en');
    expect(i18n.isSelected('fallback-en')).toBe(true);
    expect(prefs().languagePackId).toBe(FRENCH);

    plugins.set([installedPackage(officialPackageText(FRENCH_PACKAGE_ID))]);
    TestBed.tick();
    expect(i18n.locale()).toBe('fr');
  });

  it('ignores a kept command for a language that is no longer active', () => {
    const i18n = setup();
    plugins.set([]);
    i18n.select(FRENCH);
    i18n.select(SPANISH);
    expect(prefs()).toEqual({ language: 'en', languagePackId: null });
    i18n.select('fallback-en');
    expect(prefs()).toEqual({ language: 'en', languagePackId: 'fallback-en' });
  });

  it('migrates a legacy locale once the defaults settle, never onto an inactive pack', () => {
    prefs.set({ language: 'fr', languagePackId: null });
    plugins.set([installedPackage(officialPackageText(FRENCH_PACKAGE_ID), false)]);
    const i18n = setup();
    expect(i18n.locale()).toBe('en');

    defaultsSettled.set(true);
    TestBed.tick();
    expect(prefs().languagePackId).toBeNull();

    plugins.set([installedPackage(officialPackageText(FRENCH_PACKAGE_ID))]);
    TestBed.tick();
    expect(prefs()).toEqual({ language: 'fr', languagePackId: FRENCH });
    expect(i18n.locale()).toBe('fr');

    // Once chosen, nothing migrates again: English bundled stays chosen.
    i18n.select('fallback-en');
    TestBed.tick();
    expect(prefs().languagePackId).toBe('fallback-en');
  });

  it('migrates legacy English onto the English pack, and never selects a pack just installed', () => {
    plugins.update((list) => [...list, installedPackage(spanishText)]);
    defaultsSettled.set(true);
    const i18n = setup();
    expect(prefs()).toEqual({ language: 'en', languagePackId: DEFAULT_LANGUAGE_REFS.en });
    expect(i18n.isSelected(DEFAULT_LANGUAGE_REFS.en)).toBe(true);
    expect(i18n.isSelected(SPANISH)).toBe(false);
  });

  it('on the server, speaks only the bundled English and reads no plugin', () => {
    prefs.set({ language: 'fr', languagePackId: FRENCH });
    const i18n = setup('server');
    expect(i18n.languages()).toEqual([]);
    expect(i18n.locale()).toBe('en');
    expect(i18n.t('action.saveShader')).toBe('Save shader');
  });
});
