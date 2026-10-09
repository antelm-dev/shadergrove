import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideClientHydration, withNoIncrementalHydration } from '@angular/platform-browser';
import { MatIconRegistry } from '@angular/material/icon';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';
import { HttpShaderApi, ShaderApi } from './api/shader-api';
import { authInterceptor } from './auth/auth.interceptor';
import { provideI18n } from './i18n/provide-i18n';
import { provideHostAdapters } from './plugins/host-adapters';
import { provideToolAdapters } from './plugins/plugin-tools';
import { ShaderDoctorAdapter } from './plugins/tools/doctor';
import { PaletteStudioAdapter } from './plugins/tools/palette-adapter';
import { TextureUtilitiesAdapter } from './plugins/tools/textures-adapter';
import { ShadertoyApiProvider } from './plugins/providers/shadertoy-provider';
import { WallpaperWebRuntime } from './rendering/wallpaper-runtime';
import { provideAppThemes } from './themes/provide-app-themes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(routes),
    // Sends cookies with same-origin API calls, and turns a `401` into a
    // sign-in prompt instead of an error the user has to decode.
    provideHttpClient(withInterceptors([authInterceptor])),
    HttpShaderApi,
    { provide: ShaderApi, useExisting: HttpShaderApi },
    provideI18n(),
    // The host halves of the official plugins: what their manifests may name, nothing more.
    provideHostAdapters({
      sourceProviders: [ShadertoyApiProvider],
      exportRuntimes: [WallpaperWebRuntime],
    }),
    // The panels of protocol-4 tools: the app's own, never a package's. Recipes are data and need none.
    provideToolAdapters([ShaderDoctorAdapter, TextureUtilitiesAdapter, PaletteStudioAdapter]),
    // Paints the chosen theme — built-in, or a plugin's once the plugins have loaded.
    provideAppThemes(),
    // Icons are ligatures in the bundled Material Symbols font, not legacy Material Icons.
    provideAppInitializer(() => {
      inject(MatIconRegistry).setDefaultFontSetClass(
        'material-symbols-outlined',
        'mat-ligature-font',
      );
    }),
    // Incremental hydration injects event-replay scripts into SSR HTML. The
    // workspace has no deferred hydration blocks, so keep regular hydration
    // without inline scripts that its script-src 'self' CSP would block.
    provideClientHydration(withNoIncrementalHydration()),
  ],
};
