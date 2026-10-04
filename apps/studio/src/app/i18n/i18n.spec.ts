import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ɵ$localize as $localize } from '@angular/localize';
import { beforeEach, describe, expect, it } from 'vitest';

import { Preferences, type WorkspacePreferences } from '../prefs/preferences';
import { I18nCatalog, type I18nCatalogMap } from './catalog';
import { I18n } from './i18n';

class FakeCatalog extends I18nCatalog {
  constructor(private readonly data: Record<string, I18nCatalogMap>) {
    super();
  }

  override load(locale: 'en' | 'fr'): Promise<I18nCatalogMap> {
    return Promise.resolve(this.data[locale] ?? {});
  }
}

describe('I18n', () => {
  const state = signal({ language: 'en' as string });

  beforeEach(async () => {
    state.set({ language: 'en' });
    TestBed.configureTestingModule({
      providers: [
        I18n,
        {
          provide: I18nCatalog,
          useValue: new FakeCatalog({
            en: {
              'action.saveShader': 'Save shader',
              'notice.shaderNotFound': 'Shader “{name}” was not found',
            },
            fr: {
              'action.saveShader': 'Enregistrer le shader',
              'notice.shaderNotFound': 'Le shader « {name} » est introuvable',
            },
          }),
        },
        {
          provide: Preferences,
          useValue: {
            value: state.asReadonly(),
            patch: (patch: Partial<WorkspacePreferences>) => {
              if (patch.language) state.set({ language: patch.language });
            },
          },
        },
      ],
    });
    await TestBed.inject(I18n).ensureLoaded('en');
  });

  it('translates typed keys in both supported languages', async () => {
    const i18n = TestBed.inject(I18n);

    expect(i18n.t('action.saveShader')).toBe('Save shader');
    i18n.setLocale('fr');
    await i18n.ensureLoaded('fr');
    expect(i18n.t('action.saveShader')).toBe('Enregistrer le shader');
  });

  it('interpolates named values', async () => {
    const i18n = TestBed.inject(I18n);

    i18n.setLocale('fr');
    await i18n.ensureLoaded('fr');
    expect(i18n.t('notice.shaderNotFound', { name: 'Plasma' })).toBe(
      'Le shader « Plasma » est introuvable',
    );
  });

  it('syncs the active catalog into $localize', async () => {
    const i18n = TestBed.inject(I18n);

    expect($localize.locale).toBe('en');
    expect($localize`:@@action.saveShader:Save shader`).toBe('Save shader');

    i18n.setLocale('fr');
    await i18n.ensureLoaded('fr');

    expect($localize.locale).toBe('fr');
    expect($localize`:@@action.saveShader:Save shader`).toBe('Enregistrer le shader');
    expect($localize`:@@notice.shaderNotFound:Shader “${'Plasma'}:name:” was not found`).toBe(
      'Le shader « Plasma » est introuvable',
    );
  });
});
