/**
 * A `language` contribution (protocol 3): the app's text in one language, as
 * plain data. No script, markup, font, URL or locale data comes from the
 * package — only messages for the app's own translation keys, each plain text
 * with the `{name}` placeholders its English text uses.
 *
 * ```json
 * { "kind": "language", "id": "spanish", "name": "Spanish",
 *   "schemaVersion": 1, "locale": "es", "nativeName": "Español",
 *   "direction": "ltr", "messages": { "menu.file": "Archivo", ... } }
 * ```
 *
 * A dictionary may be partial: a key it leaves out reads in English. Dates and
 * numbers are formatted by the host's own `Intl` for `locale`, which is a
 * canonical BCP 47 tag, never a path. Right-to-left layout is not supported
 * yet, so `direction` is `ltr` and an `rtl` pack is refused with that reason.
 */
import {
  ENGLISH_MESSAGES,
  TRANSLATION_KEYS,
  hasOnlyNamedPlaceholders,
  isTranslationKey,
  placeholderNames,
  type TranslationKey,
} from '../i18n';
import { isCleanString, isRecord } from '../validate/primitives';
import { fail, ok, type Result } from '../validate/result';
import { isPluginContributionRef, type PluginContributionRef } from './refs';
import { utf8Bytes } from './utf8';

export const LANGUAGE_SCHEMA_VERSION = 1;

export const LANGUAGE_LIMITS = {
  localeLength: 35,
  nativeNameLength: 64,
  messageLength: 1000,
  /** UTF-8 bytes of one contribution's `messages`, which do not count toward the manifest's own limit. */
  messagesBytes: 256 * 1024,
} as const;

export type LanguageMessages = Partial<Record<TranslationKey, string>>;

export interface LanguageContribution {
  kind: 'language';
  id: string;
  name: string;
  schemaVersion: typeof LANGUAGE_SCHEMA_VERSION;
  /** Canonical BCP 47, as `Intl.getCanonicalLocales` writes it: `es`, `pt-BR`. */
  locale: string;
  /** The language's name in itself: `Español`. */
  nativeName: string;
  direction: 'ltr';
  messages: LanguageMessages;
}

const LANGUAGE_KEYS = [
  'kind',
  'id',
  'name',
  'schemaVersion',
  'locale',
  'nativeName',
  'direction',
  'messages',
];
const LOCALE_SHAPE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * The canonical form of a BCP 47 tag, or `null` when it is not one — or not
 * already in that form: a package states its locale exactly, the host never
 * guesses what it meant.
 */
export function canonicalLocale(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > LANGUAGE_LIMITS.localeLength) return null;
  if (!LOCALE_SHAPE.test(value)) return null;
  try {
    return Intl.getCanonicalLocales(value)[0] === value ? value : null;
  } catch {
    return null;
  }
}

/**
 * Validate the language-specific fields of a contribution whose `kind`, `id`
 * and `name` the package validator has already checked.
 */
export function validateLanguageFields(
  input: Record<string, unknown>,
  at: string,
  base: { id: string; name: string },
): Result<LanguageContribution> {
  const unknownKey = Object.keys(input).find((key) => !LANGUAGE_KEYS.includes(key));
  if (unknownKey) return fail(`${at}.${unknownKey} is not a known field`);
  if (input['schemaVersion'] !== LANGUAGE_SCHEMA_VERSION) {
    return fail(
      `${at}.schemaVersion ${String(input['schemaVersion'])} is not supported (this app reads ${LANGUAGE_SCHEMA_VERSION})`,
    );
  }
  const locale = canonicalLocale(input['locale']);
  if (!locale) return fail(`${at}.locale must be a canonical BCP 47 tag like "es" or "pt-BR"`);
  const nativeName = input['nativeName'];
  if (
    !isCleanString(nativeName) ||
    nativeName.trim() === '' ||
    nativeName.length > LANGUAGE_LIMITS.nativeNameLength
  ) {
    return fail(
      `${at}.nativeName must be 1–${LANGUAGE_LIMITS.nativeNameLength} characters of plain text`,
    );
  }
  const direction = input['direction'];
  if (direction === 'rtl') {
    return fail(`${at}.direction "rtl" is not supported yet: this app lays out left-to-right only`);
  }
  if (direction !== 'ltr') return fail(`${at}.direction must be "ltr"`);

  const messages = validateMessages(input['messages'], `${at}.messages`);
  if (!messages.ok) return messages;
  return ok({
    kind: 'language',
    ...base,
    schemaVersion: LANGUAGE_SCHEMA_VERSION,
    locale,
    nativeName,
    direction,
    messages: messages.value,
  });
}

function validateMessages(input: unknown, at: string): Result<LanguageMessages> {
  if (!isRecord(input)) return fail(`${at} must be an object`);
  if (utf8Bytes(JSON.stringify(input)) > LANGUAGE_LIMITS.messagesBytes) {
    return fail(`${at} must be at most ${LANGUAGE_LIMITS.messagesBytes} bytes`);
  }
  const keys = Object.keys(input);
  if (keys.length === 0) return fail(`${at} must translate at least one key`);
  const messages: LanguageMessages = {};
  for (const key of keys) {
    if (DANGEROUS_KEYS.has(key)) return fail(`${at} must not use the key "${key}"`);
    // A key this build has no English for is as unknown as one it never had.
    const english = ENGLISH_MESSAGES[key as TranslationKey] as string | undefined;
    if (!isTranslationKey(key) || english === undefined) {
      return fail(`${at}["${key}"] is not a key of this app`);
    }
    const value = input[key];
    if (
      !isCleanString(value) ||
      value.trim() === '' ||
      value.length > LANGUAGE_LIMITS.messageLength
    ) {
      return fail(
        `${at}["${key}"] must be 1–${LANGUAGE_LIMITS.messageLength} characters of plain text`,
      );
    }
    if (!hasOnlyNamedPlaceholders(value)) {
      return fail(`${at}["${key}"] may only use braces for {name} placeholders`);
    }
    const expected = placeholderNames(english).join(', ');
    const actual = placeholderNames(value).join(', ');
    if (actual !== expected) {
      return fail(`${at}["${key}"] must use the placeholders {${expected}}, not {${actual}}`);
    }
    messages[key] = value;
  }
  return ok(messages);
}

/** Whether a dictionary translates every key: what an official pack must. */
export function isCompleteLanguage(contribution: LanguageContribution): boolean {
  return TRANSLATION_KEYS.every((key) => contribution.messages[key] !== undefined);
}

// ---------------------------------------------------------------------------
// The app's language preference
// ---------------------------------------------------------------------------

/**
 * Which language the app speaks: one language contribution by reference, or
 * `fallback-en`, the English bundled with the app that needs no package.
 * `null` is a preference saved before languages became packages, still to be
 * migrated once from its legacy locale.
 */
export type LanguagePackId = 'fallback-en' | PluginContributionRef | null;

export const FALLBACK_LANGUAGE_ID = 'fallback-en';

export function sanitizeLanguagePackId(value: unknown): LanguagePackId {
  if (value === FALLBACK_LANGUAGE_ID) return FALLBACK_LANGUAGE_ID;
  return isPluginContributionRef(value) ? value : null;
}
