import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { isPluginCompatible } from '@shadergrove/shared/plugin';
import { DEFAULT_VERTEX, makePass } from '@shadergrove/shared/project';
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

describe('tool packages and template payloads', () => {
  /** A package of protocol-4 kinds in a temporary source folder, built like an official one. */
  function fixture(): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(resolve(tmpdir(), 'sg-tools-'));
    mkdirSync(resolve(dir, 'src'));
    mkdirSync(resolve(dir, 'templates'));
    const manifest = {
      id: 'dev.example.tools',
      version: '1.0.0',
      protocolVersion: 4,
      appVersionRange: '>=2.0.0 <3.0.0',
      name: 'Tools',
      publisher: 'Example',
      license: 'MIT',
      contributions: [
        {
          kind: 'analyzer',
          id: 'doctor',
          name: 'Doctor',
          profiles: ['studio-webgl2/v1'],
        },
        {
          kind: 'assetTool',
          id: 'pack',
          name: 'Pack',
          workflow: 'texture-utilities/v1',
          inputs: ['image'],
          outputs: ['image'],
        },
        {
          kind: 'projectTemplate',
          id: 'plain',
          name: 'Plain',
          description: 'One Image pass.',
          difficulty: 'beginner',
          notes: [],
          provenance: { author: 'Example', license: 'CC0-1.0' },
        },
        {
          kind: 'projectTemplate',
          id: 'another',
          name: 'Another',
          description: 'Another one.',
          difficulty: 'advanced',
          notes: ['n'],
          provenance: { author: 'Example', license: 'CC0-1.0' },
        },
      ],
    };
    const template = {
      project: {
        version: 1,
        vertex: DEFAULT_VERTEX,
        passes: [
          makePass({ id: 'common', kind: 'common', name: 'Common', source: '' }),
          makePass({ id: 'main', kind: 'image', name: 'Image', source: 'void main() {}' }),
        ],
        files: [],
      },
      controls: [],
      render: { postProcessing: { enabled: false, effects: [] } },
      presets: [],
    };
    writeFileSync(resolve(dir, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(resolve(dir, 'listing.json'), JSON.stringify({ description: 'Tools.' }));
    // Written out of order on purpose: the package must not depend on directory order.
    writeFileSync(resolve(dir, 'templates/plain.json'), JSON.stringify(template));
    writeFileSync(resolve(dir, 'templates/another.json'), JSON.stringify(template));
    writeFileSync(
      resolve(dir, 'src/index.ts'),
      [
        'declare const shaderStudio: { handle(m: string, f: (p: unknown) => unknown): void };',
        "shaderStudio.handle('analyzer:doctor', () => ({ findings: [] }));",
        "shaderStudio.handle('assetTool:pack', () => ({ kind: 'image', images: [] }));",
      ].join('\n'),
    );
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it('builds Worker sources and template payloads deterministically', () => {
    const { dir, cleanup } = fixture();
    try {
      const first = buildPackage('tools', dir);
      const second = buildPackage('tools', dir);
      expect(second.text).toBe(first.text);
      expect(first.plugin.code).toContain('analyzer:doctor');
      // The file lists templates in name order, whatever order the manifest or directory has.
      expect(Object.keys((JSON.parse(first.text) as { templates: object }).templates)).toEqual([
        'another',
        'plain',
      ]);
      expect(Object.keys(first.plugin.templates).sort()).toEqual(['another', 'plain']);
      expect(first.plugin.templates['plain']!.project.passes.map((pass) => pass.id)).toEqual([
        'common',
        'main',
      ]);
      expect(first.fileName).toBe('dev.example.tools-1.0.0.sgplugin.json');
    } finally {
      cleanup();
    }
  });

  it('refuses a template with no contribution, a Worker contribution with no source, and forbidden code', () => {
    const { dir, cleanup } = fixture();
    try {
      writeFileSync(resolve(dir, 'templates/ghost.json'), '{}');
      expect(() => buildPackage('tools', dir)).toThrow(/ghost/);
      rmSync(resolve(dir, 'templates/ghost.json'));

      writeFileSync(resolve(dir, 'templates/notes.txt'), 'x');
      expect(() => buildPackage('tools', dir)).toThrow(/must be a \.json file/);
      rmSync(resolve(dir, 'templates/notes.txt'));

      writeFileSync(
        resolve(dir, 'src/index.ts'),
        "declare const fetch: (u: string) => unknown;\nfetch('https://example.com');\n",
      );
      expect(() => buildPackage('tools', dir)).toThrow(/must not use/);
      rmSync(resolve(dir, 'src'), { recursive: true });
      expect(() => buildPackage('tools', dir)).toThrow(/code is required/);
    } finally {
      cleanup();
    }
  });
});
