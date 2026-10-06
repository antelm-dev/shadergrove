import {
  type EnvironmentProviders,
  inject,
  makeEnvironmentProviders,
  provideAppInitializer,
} from '@angular/core';

import { I18n } from './i18n';

/**
 * Starts the i18n service with the app. English is bundled, so nothing is
 * awaited: the app boots in English at once, and a chosen language follows as
 * soon as the profile's plugins have loaded. Dates and numbers are formatted by
 * `I18n` for the language worn, not by `LOCALE_ID`, which is fixed at startup.
 */
export function provideI18n(): EnvironmentProviders {
  return makeEnvironmentProviders([provideAppInitializer(() => void inject(I18n))]);
}
