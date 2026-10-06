import { describe, expect, it, vi } from 'vitest';

import { isPluginCompatible } from '@shadergrove/shared/plugin';
import { APP_VERSION } from '@shadergrove/shared/version';

import { buildOfficialPlugins, buildPackage } from './official-plugins';

describe('official plugin release compatibility', () => {
  it('builds the catalogue and packages for stable and beta 2.x releases', () => {
    buildOfficialPlugins();
    for (const name of [
      'default-themes',
      'language-en',
      'language-fr',
      'shadertoy',
      'wallpaper-engine',
    ]) {
      const { plugin } = buildPackage(name);
      for (const version of [APP_VERSION, '2.1.0', '2.1.0-beta.1']) {
        expect(isPluginCompatible(plugin.manifest, version), `${name} on ${version}`).toBe(true);
      }
      expect(isPluginCompatible(plugin.manifest, '3.0.0'), name).toBe(false);
    }
  });

  it('rejects a release whose bundled packages exclude the app version', async () => {
    vi.resetModules();
    vi.doMock('@shadergrove/shared/version', () => ({ APP_VERSION: '3.0.0' }));
    try {
      const generator = await import('./official-plugins');
      expect(() => generator.buildOfficialPlugins()).toThrow(/excludes app 3\.0\.0/);
    } finally {
      vi.doUnmock('@shadergrove/shared/version');
      vi.resetModules();
    }
  });
});
