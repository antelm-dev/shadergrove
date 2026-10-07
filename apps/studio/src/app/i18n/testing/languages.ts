import { signal, type Provider } from '@angular/core';

import {
  DEFAULT_LANGUAGE_REFS,
  FRENCH_PACKAGE_ID,
  parsePluginPackage,
  type LanguagePackId,
} from '@shadergrove/shared/plugin';

import { PluginInstallations, type InstalledPlugin } from '../../plugins/plugin-installations';
import { officialPackageText } from '../../plugins/testing/official-packages';

/**
 * For tests that render real text: `I18n` speaks the bundled English, and the
 * official French pack exactly as this release ships it is installed and on,
 * so a test can choose it the way a user does.
 */

/** A package as `PluginInstallations` lists it once installed. */
export function installedPackage(text: string, active = true): InstalledPlugin {
  const parsed = parsePluginPackage(text);
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  const id = parsed.value.manifest.id;
  const stored = { id, text, enabled: active, installedAt: '' };
  return { id, stored, plugin: parsed.value, problem: null, active };
}

const french = () => installedPackage(officialPackageText(FRENCH_PACKAGE_ID));

/** The installations `I18n` reads its languages from: the French pack, and nothing to migrate. */
export function provideTestLanguages(): Provider {
  return {
    provide: PluginInstallations,
    useValue: {
      plugins: signal([french()]).asReadonly(),
      loading: signal(false).asReadonly(),
      defaultsSettled: signal(false).asReadonly(),
    },
  };
}

/** The language preferences of someone speaking English (bundled) or French (the official pack). */
export function speaking(locale: 'en' | 'fr'): {
  language: string;
  languagePackId: LanguagePackId;
} {
  return { language: locale, languagePackId: locale === 'fr' ? DEFAULT_LANGUAGE_REFS.fr : null };
}
