import type { Provider, Type } from '@angular/core';

import { App } from './app';
import { satelliteKind, type SatelliteKind } from './output-mode';

/** What a window bootstraps: its root component, and what its application injector adds. */
export interface WindowRoot {
  readonly component: Type<unknown>;
  readonly providers: readonly Provider[];
}

/**
 * Each native panel window's shell, loaded lazily so none of them weighs on
 * the workspace's initial bundle. A shell mirrors the main window's session
 * over the session channel and never constructs the workspace's session,
 * routing or startup sequence.
 */
const SATELLITE_SHELLS: Readonly<Record<SatelliteKind, () => Promise<WindowRoot>>> = {
  'bottom-panel': () =>
    import('./ui/bottom-panel/bottom-panel-window').then((m) => ({
      component: m.BottomPanelWindow,
      providers: [],
    })),
  inspector: () =>
    import('./ui/inspector/inspector-window').then((m) => ({
      component: m.InspectorWindow,
      providers: m.INSPECTOR_WINDOW_PROVIDERS,
    })),
  editor: () =>
    import('./ui/editor/editor-window').then((m) => ({
      component: m.EditorWindow,
      providers: [],
    })),
};

/** What the desktop renderer bootstraps: the workspace, or a native panel window's shell. */
export function rootComponent(): Promise<WindowRoot> {
  const kind = satelliteKind();
  return kind ? SATELLITE_SHELLS[kind]() : Promise.resolve({ component: App, providers: [] });
}
