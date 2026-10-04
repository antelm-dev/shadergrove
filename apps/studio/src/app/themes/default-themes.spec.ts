import { describe, expect, it } from 'vitest';

import { validatePluginPackage, type ThemeContribution } from '@shadergrove/shared/plugin';

import manifest from '../../../../../plugins/official/default-themes/manifest.json';
import { findTheme } from '../editor/editor-themes';

/**
 * The default themes repaint nothing: the editor wears the same Studio Light
 * and Dark it does without them (their UI colours generate the stylesheet's
 * fallback, so those agree by construction).
 */
describe('the default themes pack', () => {
  const result = validatePluginPackage({ manifest });
  if (!result.ok) throw new Error(result.errors.join('; '));
  const themes = result.value.manifest.contributions as ThemeContribution[];

  it('is one Light/Dark pair', () => {
    expect(themes.map(({ id, scheme, variantGroup }) => [id, scheme, variantGroup])).toEqual([
      ['light', 'light', 'default'],
      ['dark', 'dark', 'default'],
    ]);
  });

  it('paints the editor exactly as the built-in Studio themes do', () => {
    for (const theme of themes) {
      const builtin = findTheme(theme.scheme === 'light' ? 'studio-light' : 'studio-dark').palette;
      expect(theme.editor).toEqual(builtin);
    }
  });
});
