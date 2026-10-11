import type { Type } from '@angular/core';

import { App } from './app';
import { satelliteKind, type SatelliteKind } from './output-mode';

/**
 * Each native panel window's shell, loaded lazily so none of them weighs on
 * the workspace's initial bundle. A shell mirrors the main window's session
 * over the session channel and never constructs the workspace's session,
 * routing or startup sequence.
 */
const SATELLITE_SHELLS: Readonly<Partial<Record<SatelliteKind, () => Promise<Type<unknown>>>>> = {
  'bottom-panel': () =>
    import('./ui/bottom-panel/bottom-panel-window').then((m) => m.BottomPanelWindow),
};

/** What the desktop renderer bootstraps: the workspace, or a native panel window's shell. */
export function rootComponent(): Promise<Type<unknown>> {
  const kind = satelliteKind();
  const shell = kind ? SATELLITE_SHELLS[kind] : undefined;
  return shell ? shell() : Promise.resolve(App);
}
