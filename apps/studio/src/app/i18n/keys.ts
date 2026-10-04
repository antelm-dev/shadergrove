export { TRANSLATION_KEYS, type TranslationKey } from '@shadergrove/shared/i18n';

export const SUPPORTED_LOCALES = ['en', 'fr'] as const;
export type AppLocale = (typeof SUPPORTED_LOCALES)[number];
