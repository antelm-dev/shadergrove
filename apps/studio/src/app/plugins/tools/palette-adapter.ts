import { Component, Injectable, input } from '@angular/core';

import type { AssetToolAdapter, ToolSession } from '../plugin-tools';
import { paletteKey, validatePaletteSettings } from './palette-settings';
import { PalettePanel } from './palette-panel';

/** `PalettePanel`, fetched when an Installed card first shows it (see `DoctorTool`). */
@Component({
  selector: 'app-palette-tool',
  imports: [PalettePanel],
  template: `@defer (on immediate) {
    <app-palette-panel [session]="session()" />
  }`,
})
export class PaletteTool {
  readonly session = input.required<ToolSession>();
}

/** Registers the panel for every `palette-studio/v1` tool (`provideToolAdapters`). */
@Injectable()
export class PaletteStudioAdapter implements AssetToolAdapter {
  readonly kind = 'assetTool' as const;
  readonly workflow = 'palette-studio/v1' as const;
  readonly command = { label: paletteKey('command'), icon: 'palette' };
  readonly panel = PaletteTool;
  readonly needsProject = false;

  validateSettings(operation: string, settings: unknown) {
    return validatePaletteSettings(operation, settings);
  }
}
