import { clearTranslations, loadTranslations, ɵ$localize as $localize } from '@angular/localize';

export function toLocalizeTarget(template: string): string {
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => `{$${name}}`);
}

export function catalogToLocalizeTranslations(
  catalog: Readonly<Record<string, string>>,
): Record<string, string> {
  const translations: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(catalog)) {
    translations[key] = toLocalizeTarget(value);
  }
  return translations;
}

export function applyLocalizeCatalog(
  locale: string,
  catalog: Readonly<Record<string, string>>,
): void {
  clearTranslations();
  loadTranslations(catalogToLocalizeTranslations(catalog));
  $localize.locale = locale;
}
