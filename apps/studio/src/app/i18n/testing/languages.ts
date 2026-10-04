import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { signal, type Provider } from '@angular/core';

import {
  DEFAULT_LANGUAGE_REFS,
  FRENCH_PACKAGE_ID,
  parsePluginPackage,
  type LanguagePackId,
} from '@shadergrove/shared/plugin';

import { PluginInstallations, type InstalledPlugin } from '../../plugins/plugin-installations';

/**
 * For tests that render real text: `I18n` speaks the bundled English, and the
 * official French pack exactly as this release ships it is installed and on,
 * so a test can choose it the way a user does.
 */
// Bundled with the spec that imports it, `import.meta.dirname` is that spec's folder:
// found by walking up rather than by a fixed number of `..`.
const generated = (() => {
  for (let dir = import.meta.dirname; dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = resolve(dir, 'src/plugins');
    if (existsSync(resolve(candidate, 'catalogue.json'))) return candidate;
  }
  throw new Error('No generated plugins found above ' + import.meta.dirname);
})();

/** The text of a package this release ships, by id. */
export function officialPackageText(id: string): string {
  const catalogue = JSON.parse(readFileSync(resolve(generated, 'catalogue.json'), 'utf8')) as {
    packages: { id: string; file: string }[];
  };
  return readFileSync(
    resolve(generated, catalogue.packages.find((entry) => entry.id === id)!.file),
    'utf8',
  );
}

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
