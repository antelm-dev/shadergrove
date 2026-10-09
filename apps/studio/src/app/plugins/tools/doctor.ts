import { Component, Injectable, input } from '@angular/core';

import type { AnalyzerToolAdapter, ToolSession } from '../plugin-tools';
import { DoctorPanel } from './doctor-panel';

/**
 * `DoctorPanel`, fetched when an Installed card first shows it: the adapter is
 * registered at startup (menus and palette list the tool), the panel's code is
 * not part of the app's first download.
 */
@Component({
  selector: 'app-doctor-tool',
  imports: [DoctorPanel],
  template: `@defer (on immediate) {
    <app-doctor-panel [session]="session()" />
  }`,
})
export class DoctorTool {
  readonly session = input.required<ToolSession>();
}

/**
 * The host adapter that draws every active `analyzer` contribution — Shader
 * Doctor's among them — as `DoctorPanel`. Registered by the app:
 * `provideToolAdapters([ShaderDoctorAdapter])`. It works on the open draft, so
 * its menu and palette entry is dimmed while none is open.
 */
@Injectable()
export class ShaderDoctorAdapter implements AnalyzerToolAdapter {
  readonly kind = 'analyzer';
  readonly command = { label: 'doctor.command', icon: 'health_and_safety' } as const;
  readonly panel = DoctorTool;
  readonly needsProject = true;
}
