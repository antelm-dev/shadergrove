import { describe, expect, it } from 'vitest';

import { ENGLISH_MESSAGES, TRANSLATION_KEYS } from '../i18n';
import {
  LANGUAGE_LIMITS,
  canonicalLocale,
  isCompleteLanguage,
  sanitizeLanguagePackId,
  type LanguageContribution,
} from './languages';
import {
  PLUGIN_LIMITS,
  isCodeContribution,
  parsePluginPackage,
  validatePluginPackage,
} from './package';

const spanish = {
  kind: 'language',
  id: 'spanish',
  name: 'Spanish',
  schemaVersion: 1,
  locale: 'es',
  nativeName: 'Español',
  direction: 'ltr',
  messages: { 'menu.file': 'Archivo', 'action.addPluginEffect': 'Añadir efecto: {name}' },
};

function pack(contributions: unknown[] = [spanish], manifest: Record<string, unknown> = {}) {
  return {
    manifest: {
      id: 'dev.example.spanish',
      version: '1.0.0',
      protocolVersion: 3,
      appVersionRange: '>=1.4.0 <2.0.0',
      name: 'Spanish',
      publisher: 'Example',
      license: 'MIT',
      contributions,
      ...manifest,
    },
  };
}

const errors = (input: unknown) => {
  const result = validatePluginPackage(input);
  return result.ok ? [] : result.errors;
};
const withLanguage = (fields: Record<string, unknown>) => pack([{ ...spanish, ...fields }]);

describe('language contributions', () => {
  it('accepts a partial, plain-text dictionary as data, with no code', () => {
    expect(ENGLISH_MESSAGES['action.addPluginEffect']).toContain('{name}');
    const result = validatePluginPackage(pack());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const language = result.value.manifest.contributions[0] as LanguageContribution;
    expect(language).toEqual({ ...spanish });
    expect(isCodeContribution(language)).toBe(false);
    expect(isCompleteLanguage(language)).toBe(false);
    expect(errors({ ...pack(), code: 'x' })[0]).toMatch(/only for importer\/exporter/);
  });

  it('exists from protocol 3 on', () => {
    expect(errors(pack([spanish], { protocolVersion: 2 }))[0]).toMatch(
      /kind "language" needs protocolVersion 3/,
    );
  });

  it('takes a canonical BCP 47 locale and nothing path-like', () => {
    for (const locale of ['es', 'pt-BR', 'zh-Hant-TW', 'gsw']) {
      expect(errors(withLanguage({ locale })), locale).toEqual([]);
    }
    for (const locale of ['ES', 'pt-br', 'pt_BR', '../fr', 'fr/x', 'e', '', 'x'.repeat(40), 7]) {
      expect(errors(withLanguage({ locale }))[0], String(locale)).toMatch(/locale must be/);
    }
    expect(canonicalLocale('en-US')).toBe('en-US');
    expect(canonicalLocale('en-us')).toBeNull();
  });

  it('refuses right-to-left with its reason, and any other direction', () => {
    expect(errors(withLanguage({ direction: 'rtl' }))[0]).toMatch(/"rtl" is not supported yet/);
    expect(errors(withLanguage({ direction: 'auto' }))[0]).toMatch(/direction must be "ltr"/);
  });

  it('refuses unknown fields, schemas and names', () => {
    expect(errors(withLanguage({ font: 'x.woff' }))[0]).toMatch(/font is not a known field/);
    expect(errors(withLanguage({ schemaVersion: 2 }))[0]).toMatch(/not supported/);
    expect(errors(withLanguage({ nativeName: '' }))[0]).toMatch(/nativeName/);
    expect(errors(withLanguage({ nativeName: 'a\nb' }))[0]).toMatch(/nativeName/);
  });

  it('refuses keys the app does not have, dangerous keys and empty dictionaries', () => {
    expect(errors(withLanguage({ messages: { 'menu.nope': 'x' } }))[0]).toMatch(
      /"menu.nope"\] is not a key of this app/,
    );
    expect(
      errors(withLanguage({ messages: JSON.parse('{"__proto__": "x"}') as unknown }))[0],
    ).toMatch(/must not use the key "__proto__"/);
    expect(errors(withLanguage({ messages: { constructor: 'x' } }))[0]).toMatch(/constructor/);
    expect(errors(withLanguage({ messages: {} }))[0]).toMatch(/at least one key/);
    expect(errors(withLanguage({ messages: [] }))[0]).toMatch(/must be an object/);
  });

  it('refuses values that are not plain text', () => {
    for (const value of ['', '  ', 'a\u0000b', 'x'.repeat(LANGUAGE_LIMITS.messageLength + 1), 7]) {
      expect(errors(withLanguage({ messages: { 'menu.file': value } }))[0]).toMatch(/plain text/);
    }
  });

  it('keeps the English placeholders exactly, and no other braces', () => {
    const saved = (value: string) =>
      errors(withLanguage({ messages: { 'action.addPluginEffect': value } }));
    expect(saved('Efecto {name}')).toEqual([]);
    expect(saved('Añadir efecto')[0]).toMatch(/must use the placeholders \{name\}, not \{\}/);
    expect(saved('Añadir {nombre}')[0]).toMatch(/not \{nombre\}/);
    expect(saved('{name} {extra}')[0]).toMatch(/not \{extra, name\}/);
    expect(saved('{name} {{x}}')[0]).toMatch(/braces/);
    expect(saved('{name} ${x}')[0]).toMatch(/placeholders/);
    expect(saved('{ name }')[0]).toMatch(/braces/);
  });

  it('bounds the dictionary on its own, outside the manifest limit', () => {
    // A full dictionary is well over half the manifest limit in some scripts; it does not count there.
    const long = Object.fromEntries(
      TRANSLATION_KEYS.map((key) => [key, ENGLISH_MESSAGES[key].replace(/[^{}\w]/g, 'ж')]),
    );
    expect(JSON.stringify(long).length).toBeGreaterThan(PLUGIN_LIMITS.manifestBytes / 3);
    expect(errors(withLanguage({ messages: long }))).toEqual([]);

    const oversized = Object.fromEntries(
      TRANSLATION_KEYS.slice(0, 400).map((key) => [key, `${'ж'.repeat(400)}`]),
    );
    expect(errors(withLanguage({ messages: oversized }))[0]).toMatch(/messages must be at most/);
  });

  it('reads a complete official dictionary as complete', () => {
    const result = parsePluginPackage(
      JSON.stringify(withLanguage({ locale: 'en', messages: ENGLISH_MESSAGES })),
    );
    expect(
      result.ok &&
        isCompleteLanguage(result.value.manifest.contributions[0] as LanguageContribution),
    ).toBe(true);
  });
});

describe('language preference', () => {
  it('keeps the fallback, a well-formed reference, or nothing', () => {
    expect(sanitizeLanguagePackId('fallback-en')).toBe('fallback-en');
    expect(sanitizeLanguagePackId('plugin:dev.example.spanish/spanish')).toBe(
      'plugin:dev.example.spanish/spanish',
    );
    for (const value of [undefined, null, 'fr', 'plugin:x', 'fallback-fr', 42]) {
      expect(sanitizeLanguagePackId(value)).toBeNull();
    }
  });
});
