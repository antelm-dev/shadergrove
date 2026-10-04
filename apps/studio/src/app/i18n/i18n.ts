import { DOCUMENT } from '@angular/common';
import { Injectable, computed, effect, inject, signal } from '@angular/core';

import { Preferences } from '../prefs/preferences';
import { I18nCatalog, type I18nCatalogMap } from './catalog';
import { type AppLocale, type TranslationKey } from './keys';
import { applyLocalizeCatalog } from './localize';

export { SUPPORTED_LOCALES, type AppLocale } from './keys';
export type TranslationParams = Readonly<Record<string, string | number>>;

export const LANGUAGE_OPTIONS: ReadonlyArray<{
  value: AppLocale;
  labelKey: TranslationKey;
}> = [
  { value: 'en', labelKey: 'language.english' },
  { value: 'fr', labelKey: 'language.french' },
];

@Injectable({ providedIn: 'root' })
export class I18n {
  private readonly preferences = inject(Preferences);
  private readonly document = inject(DOCUMENT);
  private readonly source = inject(I18nCatalog);
  private readonly catalogs = signal<Partial<Record<AppLocale, I18nCatalogMap>>>({});
  private readonly inflight = new Map<AppLocale, Promise<void>>();

  readonly locale = computed<AppLocale>(() =>
    this.preferences.value().language === 'fr' ? 'fr' : 'en',
  );

  constructor() {
    effect(() => {
      const locale = this.locale();
      this.document.documentElement.lang = locale;
      this.syncLocalize();
    });

    effect(() => {
      void this.ensureLoaded(this.locale());
    });
  }

  setLocale(locale: AppLocale): void {
    this.preferences.patch({ language: locale });
  }

  ensureLoaded(locale: AppLocale): Promise<void> {
    const loads = [this.loadOne(locale)];
    if (locale !== 'en') loads.push(this.loadOne('en'));
    return Promise.all(loads).then(() => {
      this.syncLocalize();
    });
  }

  private syncLocalize(): void {
    const locale = this.locale();
    const catalog = this.catalogs()[locale] ?? this.catalogs().en;
    if (catalog) applyLocalizeCatalog(locale, catalog);
  }

  private loadOne(locale: AppLocale): Promise<void> {
    if (this.catalogs()[locale]) return Promise.resolve();
    const pending = this.inflight.get(locale);
    if (pending) return pending;

    const load = this.source
      .load(locale)
      .then((catalog) => {
        this.catalogs.update((current) => ({ ...current, [locale]: catalog }));
      })
      .finally(() => this.inflight.delete(locale));

    this.inflight.set(locale, load);
    return load;
  }

  t(key: TranslationKey, params: TranslationParams = {}): string {
    const locale = this.locale();
    const template = this.catalogs()[locale]?.[key] ?? this.catalogs().en?.[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
      Object.hasOwn(params, name) ? String(params[name]) : placeholder,
    );
  }
}
