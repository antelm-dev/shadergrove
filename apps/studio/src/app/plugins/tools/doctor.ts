import { Injectable } from '@angular/core';

import type { TranslationKey } from '../../i18n/keys';
import type { AnalyzerToolAdapter } from '../plugin-tools';
import { DoctorPanel } from './doctor-panel';

/**
 * The host adapter that draws every active `analyzer` contribution — Shader
 * Doctor's among them — as `DoctorPanel`. Registered by the app:
 * `provideToolAdapters([ShaderDoctorAdapter])`. It works on the open draft, so
 * its menu and palette entry is dimmed while none is open.
 */
@Injectable()
export class ShaderDoctorAdapter implements AnalyzerToolAdapter {
  readonly kind = 'analyzer';
  readonly command = { label: 'doctor.command' as TranslationKey, icon: 'health_and_safety' };
  readonly panel = DoctorPanel;
  readonly needsProject = true;
}
