import { Component, Injectable, input } from '@angular/core';

import type { AssetToolAdapter, ToolSession } from '../plugin-tools';
import { textureKey, validateTextureSettings } from './textures-settings';
import { TexturesPanel } from './textures-panel';

/** `TexturesPanel`, fetched when an Installed card first shows it (see `DoctorTool`). */
@Component({
  selector: 'app-textures-tool',
  imports: [TexturesPanel],
  template: `@defer (on immediate) {
    <app-textures-panel [session]="session()" />
  }`,
})
export class TexturesTool {
  readonly session = input.required<ToolSession>();
}

/** Registers the panel for every `texture-utilities/v1` tool (`provideToolAdapters`). */
@Injectable()
export class TextureUtilitiesAdapter implements AssetToolAdapter {
  readonly kind = 'assetTool' as const;
  readonly workflow = 'texture-utilities/v1' as const;
  readonly command = { label: textureKey('command'), icon: 'texture' };
  readonly panel = TexturesTool;
  readonly needsProject = false;

  validateSettings(operation: string, settings: unknown) {
    return validateTextureSettings(operation, settings);
  }
}
