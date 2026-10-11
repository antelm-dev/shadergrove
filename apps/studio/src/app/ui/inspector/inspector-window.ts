import { Component, inject, type Provider } from '@angular/core';

import { WELL_KNOWN_SURFACE_IDS } from '@shadergrove/shared/surfaces';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { SessionMirror } from '../../workspace/session-sync/session-mirror';
import { SatelliteControls } from '../layout/satellite-controls';
import { SatelliteTitlebar } from '../layout/satellite-titlebar';
import { InspectorPanel } from './inspector-panel';
import { InspectorSession } from './inspector-session';
import { RemoteInspectorSession } from './remote-inspector-session';

/**
 * Bootstrapped with the inspector's window: every panel in it — and every
 * dialog they open, which resolves from the application injector — sees the
 * mirrored session, never the main window's.
 */
export const INSPECTOR_WINDOW_PROVIDERS: Provider[] = [
  RemoteInspectorSession,
  { provide: InspectorSession, useExisting: RemoteInspectorSession },
];

/**
 * The whole page of the inspector's native window, bootstrapped in place of
 * `App` (see `rootComponent`). The same inspector as in the workspace, on a
 * mirror of the main window's session: it holds no store of its own.
 */
@Component({
  selector: 'app-root',
  imports: [InspectorPanel, SatelliteControls, SatelliteTitlebar, TranslatePipe],
  template: `
    <app-satellite-titlebar
      [surfaceId]="surfaceId"
      [panel]="'workspace.inspector' | translate"
      closeLabel="inspector.closeWindow"
    />
    <app-inspector-panel>
      <app-satellite-controls
        inspectorWindowControls
        [surfaceId]="surfaceId"
        dockIcon="dock_to_right"
        closeLabel="inspector.closeWindow"
      />
    </app-inspector-panel>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
      background: var(--mat-sys-surface-container-low);
      color: var(--mat-sys-on-surface);
    }

    app-inspector-panel {
      flex: 1;
      min-height: 0;
    }
  `,
})
export class InspectorWindow {
  protected readonly surfaceId = WELL_KNOWN_SURFACE_IDS.inspector;

  constructor() {
    inject(SessionMirror).start('inspector');
  }
}
