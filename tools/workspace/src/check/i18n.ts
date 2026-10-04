import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { TRANSLATION_KEYS, placeholderNames } from '@shadergrove/shared/i18n';

import { createLogger } from '../lib/logger.js';
import { root } from '../lib/paths.js';

type Catalog = Record<string, string>;

const log = createLogger('i18n');
const locales = ['en', 'fr'] as const;
const keys: readonly string[] = TRANSLATION_KEYS;
if (keys.length === 0) fail('TRANSLATION_KEYS is empty');

const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
if (duplicates.length > 0) {
  fail(`Duplicate TranslationKey entries:\n${unique(duplicates).map(bullet).join('\n')}`);
}

const catalogs: Record<(typeof locales)[number], Catalog> = Object.fromEntries(
  locales.map((locale) => {
    const path = resolve(root, `i18n/${locale}.json`);
    return [locale, JSON.parse(readFileSync(path, 'utf8'))];
  }),
) as Record<(typeof locales)[number], Catalog>;

const errors: string[] = [];

for (const locale of locales) {
  const catalog = catalogs[locale];
  const catalogKeys = Object.keys(catalog);

  for (const key of keys) {
    if (!(key in catalog)) {
      errors.push(`Missing in i18n/${locale}.json: ${key}`);
      continue;
    }
    if (typeof catalog[key] !== 'string' || catalog[key].trim() === '') {
      errors.push(`Empty value in i18n/${locale}.json: ${key}`);
    }
  }

  for (const key of catalogKeys) {
    if (!keys.includes(key)) {
      errors.push(`Extra key in i18n/${locale}.json (not in TRANSLATION_KEYS): ${key}`);
    }
  }
}

for (const key of keys) {
  const expected = placeholderNames(catalogs.en[key] ?? '');
  for (const locale of locales) {
    if (!(key in catalogs[locale])) continue;
    const actual = placeholderNames(catalogs[locale][key]);
    if (actual.join(',') !== expected.join(',')) {
      errors.push(
        `Placeholder mismatch for ${key} in ${locale}: expected {${expected.join(', ')}} got {${actual.join(', ')}}`,
      );
    }
  }
}

if (errors.length > 0) {
  fail(`i18n check failed (${errors.length}):\n${errors.map(bullet).join('\n')}`);
}

log.info(`i18n ok — ${keys.length} keys × ${locales.length} locales`);

function bullet(line: string): string {
  return `  - ${line}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function fail(message: string): never {
  log.error(message);
  process.exit(1);
}
