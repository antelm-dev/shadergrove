/// <reference types="@angular/localize" />

import { isDevMode } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';

import { desktopConfig } from './app/app.config.desktop';
import { rootComponent } from './app/root-component';

rootComponent()
  .then((root) => bootstrapApplication(root, desktopConfig))
  .catch((error: unknown) => console.error(error));

// ponytail: dev-only escape probe for the plugin sandbox prototype; remove once hostile tests run in CI.
if (isDevMode()) {
  Object.assign(globalThis, {
    pluginSandboxProbe: () =>
      import('./app/plugins/sandbox-probe').then((m) => m.runSandboxProbe()),
    pluginHostProbe: () => import('./app/plugins/sandbox-probe').then((m) => m.runHostProbe()),
  });
}
