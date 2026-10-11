import type { Type } from '@angular/core';

import { App } from './app';
import { isBottomPanelWindow } from './output-mode';

/**
 * What the desktop renderer bootstraps: the workspace, or — in the native
 * Problems/Output window — a lazily loaded shell that mirrors the main
 * window's panel and never constructs the workspace's session, routing or
 * startup sequence.
 */
export function rootComponent(): Promise<Type<unknown>> {
  return isBottomPanelWindow()
    ? import('./ui/bottom-panel/bottom-panel-window').then((m) => m.BottomPanelWindow)
    : Promise.resolve(App);
}
