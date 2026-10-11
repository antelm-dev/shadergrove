import type { Type } from '@angular/core';

import { RendererHandle } from '../../rendering/renderer-handle';
import { SurfaceLayoutService } from '../../surfaces/surface-layout';
import { WorkspaceInspectorSession } from '../../ui/inspector/inspector-session';
import { WorkspaceActions } from '../../ui/workspace-actions';
import { OutputSync } from '../output-sync';
import { RoutingCoordinator } from '../routing-coordinator';
import { SessionHost } from '../session-sync/session-host';
import { ShaderStore } from '../shader-store';
import { StartupCoordinator } from '../startup-coordinator';

/** What a panel window must never create: the main window's session and its side effects. */
export const MAIN_WINDOW_ONLY: readonly Type<unknown>[] = [
  ShaderStore,
  StartupCoordinator,
  RoutingCoordinator,
  OutputSync,
  SurfaceLayoutService,
  SessionHost,
  RendererHandle,
  WorkspaceActions,
  WorkspaceInspectorSession,
];

/** Throwing factories for `MAIN_WINDOW_ONLY`: a test fails the moment a panel window asks for one. */
export const forbidMainWindowOnly = (window: string) =>
  MAIN_WINDOW_ONLY.map((token) => ({
    provide: token,
    useFactory: () => {
      throw new Error(`the ${window} window must not create ${token.name}`);
    },
  }));
