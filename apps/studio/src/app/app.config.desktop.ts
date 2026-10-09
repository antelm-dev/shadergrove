import {
  type ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { MatIconRegistry } from '@angular/material/icon';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';
import { DesktopShaderApi } from './desktop/desktop-shader-api';
import { ShaderApi } from './api/shader-api';
import { provideI18n } from './i18n/provide-i18n';
import { provideHostAdapters } from './plugins/host-adapters';
import { provideToolAdapters } from './plugins/plugin-tools';
import { ShaderDoctorAdapter } from './plugins/tools/doctor';
import { PaletteStudioAdapter } from './plugins/tools/palette-adapter';
import { TextureUtilitiesAdapter } from './plugins/tools/textures-adapter';
import { ShadertoyApiProvider } from './plugins/providers/shadertoy-provider';
import { WallpaperWebRuntime } from './rendering/wallpaper-runtime';
import { provideAppThemes } from './themes/provide-app-themes';

export const desktopConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(routes),
    DesktopShaderApi,
    { provide: ShaderApi, useExisting: DesktopShaderApi },
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
  ],
};
