import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { Injectable, PLATFORM_ID, computed, effect, inject, untracked } from '@angular/core';

import { ENGLISH_MESSAGES } from '@shadergrove/shared/i18n';
import {
  DEFAULT_LANGUAGE_REFS,
  FALLBACK_LANGUAGE_ID,
  pluginContributionRef,
  type LanguageContribution,
  type LanguagePackId,
  type PluginContributionRef,
} from '@shadergrove/shared/plugin';

import { PluginInstallations, type InstalledPlugin } from '../plugins/plugin-installations';
import { Preferences } from '../prefs/preferences';
import { type TranslationKey } from './keys';
import { applyLocalizeCatalog } from './localize';

export type TranslationParams = Readonly<Record<string, string | number>>;

/** One language contribution of an active package, with the package that brings it. */
export interface LanguageEntry {
  ref: PluginContributionRef;
  packageId: string;
  packageName: string;
  language: LanguageContribution;
}

/** Every language of every active package of the given profile, in package order. */
export function languageEntries(plugins: readonly InstalledPlugin[]): LanguageEntry[] {
  return plugins.flatMap((installed) => {
    const plugin = installed.plugin;
    if (!installed.active || !plugin) return [];
    return plugin.manifest.contributions.flatMap((contribution) =>
      contribution.kind === 'language'
        ? [
            {
              ref: pluginContributionRef(plugin.manifest.id, contribution.id),
              packageId: plugin.manifest.id,
              packageName: plugin.manifest.name,
              language: contribution,
            },
          ]
        : [],
    );
  });
}

/**
 * What the app says, and in which language.
 *
 * English is bundled with the app and always there: it is what renders on the
 * server, at startup, and whenever the chosen language is not available. Every
 * other language — French included — is a `language` contribution of an
 * active package of the current profile, chosen by reference
 * (`languagePackId`), never by locale: two packages may speak the same one. A
 * chosen language's dictionary is laid over the English, so a key it does not
 * translate reads in English, the same for `t` and for `$localize`. Messages
 * are plain text; only `{name}` placeholders are filled in.
 *
 * Dates, numbers and lists are formatted by the browser's own `Intl` for the
 * language worn — nothing of that comes from a package.
 */
@Injectable({ providedIn: 'root' })
export class I18n {
  private readonly preferences = inject(Preferences);
  private readonly document = inject(DOCUMENT);
  // The server has no plugins: it speaks the bundled English, to every visitor alike.
  private readonly installations = isPlatformBrowser(inject(PLATFORM_ID))
    ? inject(PluginInstallations)
    : null;

  /** The languages on offer: those of the current profile's active packages. */
  readonly languages = computed<readonly LanguageEntry[]>(() =>
    this.installations ? languageEntries(this.installations.plugins()) : [],
  );

  /** The chosen language, while it is active; `null` when the bundled English is spoken. */
  readonly selected = computed<LanguageEntry | null>(() => {
    const id = this.preferences.value().languagePackId;
    return this.languages().find((entry) => entry.ref === id) ?? null;
  });

  /** The locale spoken now: a canonical BCP 47 tag. */
  readonly locale = computed(() => this.selected()?.language.locale ?? 'en');

  private readonly catalog = computed<Readonly<Record<string, string>>>(() => {
    const selected = this.selected();
    return selected ? { ...ENGLISH_MESSAGES, ...selected.language.messages } : ENGLISH_MESSAGES;
  });

  private readonly numberFormats = new Map<string, Intl.NumberFormat>();

  constructor() {
    // Before anything renders: `$localize` must never run without a catalogue.
    applyLocalizeCatalog('en', ENGLISH_MESSAGES);

    effect(() => {
      const locale = this.locale();
      const catalog = this.catalog();
      const root = this.document.documentElement;
      root.lang = locale;
      root.dir = this.selected()?.language.direction ?? 'ltr';
      untracked(() => applyLocalizeCatalog(locale, catalog));
    });

    effect(() => this.migrateLegacyChoice());
  }

  /**
   * Speak a language: a reference, looked up again among the active languages —
   * a menu or palette entry can outlive its package or its profile — and
   * ignored if it is gone; or the bundled English, always there.
   */
  select(id: PluginContributionRef | typeof FALLBACK_LANGUAGE_ID): void {
    if (id === FALLBACK_LANGUAGE_ID) {
      this.preferences.patch({ languagePackId: FALLBACK_LANGUAGE_ID, language: 'en' });
      return;
    }
    const entry = untracked(this.languages).find((candidate) => candidate.ref === id);
    if (!entry) return;
    this.preferences.patch({ languagePackId: id, language: entry.language.locale });
  }

  /** Whether this is the language spoken now; the bundled English when no chosen one is active. */
  isSelected(id: LanguagePackId): boolean {
    const selected = this.selected();
    return id === FALLBACK_LANGUAGE_ID ? selected === null : selected?.ref === id;
  }

  /**
   * How a language is named in a list of them: in itself, and — when another
   * language on offer has the same name, or for a pack other than the app's
   * own — with the package that brings it.
   */
  label(entry: LanguageEntry): string {
    const official = (Object.values(DEFAULT_LANGUAGE_REFS) as string[]).includes(entry.ref);
    const clash = this.languages().some(
      (other) => other !== entry && other.language.nativeName === entry.language.nativeName,
    );
    return official && !clash
      ? entry.language.nativeName
      : `${entry.language.nativeName} (${entry.packageName})`;
  }

  t(key: TranslationKey, params: TranslationParams = {}): string {
    const template = this.catalog()[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
      Object.hasOwn(params, name) ? String(params[name]) : placeholder,
    );
  }

  /** A date and time, as the language worn writes it. */
  formatDate(
    value: string | number | Date,
    options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
  ): string {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(this.locale(), options);
  }

  /** A number, as the language worn writes it: up to two decimals unless `options` say otherwise. */
  formatNumber(
    value: number,
    options: Intl.NumberFormatOptions = { maximumFractionDigits: 2 },
  ): string {
    const locale = this.locale();
    const key = `${locale}|${JSON.stringify(options)}`;
    let format = this.numberFormats.get(key);
    if (!format) {
      format = new Intl.NumberFormat(locale, options);
      this.numberFormats.set(key, format);
    }
    return format.format(value);
  }

  /** `a, b and c`, in the language worn. */
  formatList(items: readonly string[]): string {
    return new Intl.ListFormat(this.locale(), { type: 'conjunction' }).format(items);
  }

  /**
   * Once, after the defaults settle: a preference from before languages were
   * packages (`languagePackId: null`) becomes the official pack of its legacy
   * locale — French for `fr`, English otherwise — once that pack is active.
   * Never onto one that is not: until then the bundled English is spoken and
   * the preference waits.
   */
  private migrateLegacyChoice(): void {
    const installations = this.installations;
    if (!installations?.defaultsSettled() || installations.loading()) return;
    const { languagePackId, language } = this.preferences.value();
    if (languagePackId !== null) return;
    const ref = language === 'fr' ? DEFAULT_LANGUAGE_REFS.fr : DEFAULT_LANGUAGE_REFS.en;
    const entry = this.languages().find((candidate) => candidate.ref === ref);
    if (!entry) return;
    untracked(() =>
      this.preferences.patch({ languagePackId: ref, language: entry.language.locale }),
    );
  }
}
