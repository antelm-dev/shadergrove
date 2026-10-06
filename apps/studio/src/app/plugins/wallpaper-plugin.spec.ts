import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  APP_VERSION,
  isPluginCompatible,
  parsePluginPackage,
  type PluginPackage,
  type ProjectExportInput,
  type ShaderControl,
  type TextureChannelPayloads,
} from '@shadergrove/shared';
import { DEFAULT_VERTEX, makePass, type ShaderProject } from '@shadergrove/shared/project';
import { WALLPAPER_PLAYER, assembleWallpaper } from '../rendering/wallpaper-runtime';
import { PluginHost } from './plugin-host';
import { ZipDownloadWriter } from './project-delivery';
import { inProcessStart } from './testing/in-process-sandbox';

/**
 * The Wallpaper Engine package as the catalogue ships it, run through the real
 * `PluginHost`, then assembled by the host's `wallpaper-web/v1` runtime. The
 * parity reference for the rendered passes is what the built-in HTML export
 * produced for this same project, frozen in `legacy-passes.json` when it was
 * removed in favour of the plugin.
 */
const root = resolve(import.meta.dirname, '../../../../..');
const parsed = parsePluginPackage(
  readFileSync(
    resolve(root, 'apps/studio/src/plugins/dev.shadergrove.wallpaper-engine-1.0.2.sgplugin.json'),
    'utf8',
  ),
);
if (!parsed.ok) throw new Error(parsed.errors.join('; '));
const plugin: PluginPackage = parsed.value;
const host = () => new PluginHost(plugin, { start: inProcessStart(plugin.code!) });

function project(): ShaderProject {
  const buffer = makePass({
    id: 'buffer-a',
    kind: 'buffer',
    name: 'Buffer A',
    slot: 'A',
    source: 'void main() { gl_FragColor = texture2D(iChannel0, vUv) * u_speed_rate; }',
    channels: [
      { kind: 'buffer', passId: 'buffer-a', feedback: true },
      { kind: 'none' },
      { kind: 'none' },
      { kind: 'none' },
    ],
  });
  const image = makePass({
    id: 'image',
    kind: 'image',
    name: 'Image',
    source:
      '#include "palette.glsl"\nvoid main() { float edge = fwidth(vUv.x); gl_FragColor = texture2D(iChannel0, vUv) * tint() * edge; }',
    channels: [
      { kind: 'buffer', passId: buffer.id, feedback: false },
      { kind: 'texture', slot: 0 },
      { kind: 'none' },
      { kind: 'none' },
    ],
  });
  return {
    version: 1,
    vertex: DEFAULT_VERTEX,
    passes: [
      image,
      makePass({
        id: 'common',
        kind: 'common',
        name: 'Common',
        source: 'float commonValue() { return 1.0; }',
      }),
      buffer,
    ],
    files: [
      {
        id: 'palette',
        name: 'palette.glsl',
        source: 'vec4 tint() { return vec4(commonValue()); }',
      },
    ],
  };
}

const controls: ShaderControl[] = [
  { key: 'speed_rate', label: 'Speed', type: 'number', default: 1, min: 0, max: 4, step: 0.05 },
  { key: 'glow', type: 'boolean', default: false },
  { key: 'tint', label: 'Tint', type: 'color', default: '#ff8000' },
  { key: 'mode', label: 'Mode', type: 'select', default: 0, options: { Calm: 0, Storm: 2 } },
  { key: 'speedRate', type: 'number', default: 0.5, min: 0, max: 1 },
];
const params = { speed_rate: 2.5, glow: true, tint: '#00ff00', mode: 2, speedRate: 0.25 };

const channels: TextureChannelPayloads = [
  {
    ext: 'png',
    width: 1,
    height: 1,
    wrap: 'repeat',
    filter: 'nearest',
    flipY: true,
    data: 'AQIDBA==',
  },
  { ext: null, width: 0, height: 0, wrap: 'clamp', filter: 'linear', flipY: true, data: null },
  { ext: null, width: 0, height: 0, wrap: 'clamp', filter: 'linear', flipY: true, data: null },
  { ext: null, width: 0, height: 0, wrap: 'clamp', filter: 'linear', flipY: true, data: null },
];

function snapshot(overrides: Partial<ProjectExportInput> = {}): ProjectExportInput {
  return {
    name: 'Neon / Rain',
    author: 'Ada',
    project: project(),
    controls,
    params,
    channels: channels.map(({ data, ...meta }) => ({ ...meta, present: data !== null })),
    postProcessingActive: false,
    ...overrides,
  };
}

const textures = [{ slot: 0, ext: 'png', bytes: new Uint8Array([1, 2, 3, 4]) }];
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const playerProject = (html: string) =>
  JSON.parse(
    html.slice(
      html.indexOf('window.__SHADERGROVE_WALLPAPER__ = ') +
        'window.__SHADERGROVE_WALLPAPER__ = '.length,
      html.indexOf(';</script>'),
    ),
  ) as {
    passes: { id: string; fragment: string }[];
    controls: { key: string; uniform: string; type: string }[];
    params: Record<string, unknown>;
    uniforms: { uniform: string; kind: string }[];
    channels: { path: string | null }[];
  };

async function exportAndAssemble(input = snapshot()) {
  const result = await host().exportProject('wallpaper-engine', input);
  const output = assembleWallpaper(result.data, textures);
  if (!output.ok) throw new Error(output.errors.join('; '));
  const file = (path: string) =>
    decode(output.value.files.find((entry) => entry.path === path)!.bytes);
  return {
    result,
    output: output.value,
    html: file('index.html'),
    json: JSON.parse(file('project.json')),
  };
}

describe('the Wallpaper Engine plugin package', () => {
  it('is a protocol-2 project exporter for this app, targeting wallpaper-web/v1', () => {
    expect(isPluginCompatible(plugin.manifest, APP_VERSION)).toBe(true);
    expect(plugin.manifest.contributions).toEqual([
      expect.objectContaining({ kind: 'projectExporter', runtime: 'wallpaper-web/v1' }),
    ]);
  });

  it('renders the same passes as the built-in export did, in the same order', async () => {
    const { html, output } = await exportAndAssemble();
    const legacyPasses = (
      JSON.parse(
        readFileSync(
          resolve(root, 'plugins/official/wallpaper-engine/fixtures/legacy-passes.json'),
          'utf8',
        ),
      ) as { passes: { id: string; fragment: string }[] }
    ).passes;
    const player = playerProject(html);
    expect(player.passes.map(({ id, fragment }) => ({ id, fragment }))).toEqual(
      legacyPasses.map(({ id, fragment }) => ({ id, fragment })),
    );
    expect(player.passes.map((pass) => pass.id)).toEqual(['buffer-a', 'image']);
    expect(player.channels[0]!.path).toBe('data:image/png;base64,AQIDBA==');
    expect(player.channels[1]!.path).toBeNull();
    expect(output.stem).toBe('Neon-Rain');
    expect(output.files.map((file) => file.path)).toEqual(['index.html', 'project.json']);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('writes matching project.json properties, listener keys and current-draft defaults', async () => {
    const { html, json } = await exportAndAssemble();
    expect(json).toMatchObject({ file: 'index.html', type: 'web', title: 'Neon / Rain' });
    const properties = json.general.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(properties)).toEqual([
      'ssspeedrate',
      'ssglow',
      'sstint',
      'ssmode',
      'ssspeedrate2',
    ]);
    expect(properties['ssspeedrate']).toMatchObject({
      type: 'slider',
      text: 'Speed',
      value: 2.5,
      min: 0,
      max: 4,
      step: 0.05,
      precision: 2,
      fraction: true,
      order: 0,
    });
    expect(properties['ssglow']).toMatchObject({ type: 'bool', value: true });
    expect(properties['sstint']).toMatchObject({ type: 'color', value: '0 1 0' });
    expect(properties['ssmode']).toMatchObject({
      type: 'combo',
      value: '2',
      options: [
        { label: 'Calm', value: '0' },
        { label: 'Storm', value: '2' },
      ],
    });

    const player = playerProject(html);
    expect(player.controls).toEqual([
      { key: 'ssspeedrate', uniform: 'speed_rate', type: 'slider' },
      { key: 'ssglow', uniform: 'glow', type: 'bool' },
      { key: 'sstint', uniform: 'tint', type: 'color' },
      { key: 'ssmode', uniform: 'mode', type: 'combo' },
      { key: 'ssspeedrate2', uniform: 'speedRate', type: 'slider' },
    ]);
    expect(player.params).toEqual({
      speed_rate: 2.5,
      glow: true,
      tint: '0 1 0',
      mode: 2,
      speedRate: 0.25,
    });
    expect(html).toContain('window.wallpaperPropertyListener');
  });

  it('renders every control at its draft value, even past the property limit', async () => {
    const many: ShaderControl[] = Array.from({ length: 65 }, (_, index) => ({
      key: `c${index}`,
      type: 'number',
      default: 0,
      min: 0,
      max: 10,
    }));
    const values = Object.fromEntries(many.map((control) => [control.key, 7]));
    const { result, html, json } = await exportAndAssemble(
      snapshot({ controls: many, params: values }),
    );
    const player = playerProject(html);
    expect(player.params['c64']).toBe(7);
    expect(Object.keys(json.general.properties)).toHaveLength(64);
    expect(json.general.properties).not.toHaveProperty('ssc64');
    expect(result.warnings.join(' ')).toMatch(/at most 64 properties; 1 more control\(s\) keep/);
  });

  it('keeps an exact select value, and leaves out a property that could not hold it', async () => {
    const select: ShaderControl[] = [
      { key: 'mode', type: 'select', default: 0, options: { Zero: 0, Tiny: 1e-7 } },
      { key: 'odd', type: 'select', default: 0, options: { Zero: 0, One: 1 } },
    ];
    const { result, html, json } = await exportAndAssemble(
      snapshot({ controls: select, params: { mode: 1e-7, odd: 0.5 } }),
    );
    const player = playerProject(html);
    expect(player.params).toEqual({ mode: 1e-7, odd: 0.5 });
    expect(json.general.properties['ssmode']).toMatchObject({
      type: 'combo',
      value: '1e-7',
      options: [
        { label: 'Zero', value: '0' },
        { label: 'Tiny', value: '1e-7' },
      ],
    });
    expect(json.general.properties).not.toHaveProperty('ssodd');
    expect(result.warnings.join(' ')).toMatch(/1 control\(s\) have a value .*: odd\./);
  });

  it('keeps the post-processing warning, and escapes a hostile title', async () => {
    const { result, html } = await exportAndAssemble(
      snapshot({ name: '</script><script>alert(1)</script>', postProcessingActive: true }),
    );
    expect(result.warnings).toEqual([
      'Post-processing is not included; the exported wallpaper renders the shader passes without it.',
    ]);
    expect(html).not.toContain('<script>alert(1)');
    expect(html.match(/<script>/g)).toHaveLength(2);
  });

  it('refuses plugin data that tries to supply markup or wire unknown passes', () => {
    const valid = {
      title: 'x',
      vertex: '',
      passes: [
        {
          id: 'image',
          name: 'Image',
          kind: 'image',
          fragment: 'void main() {}',
          channels: [{ kind: 'none' }, { kind: 'none' }, { kind: 'none' }, { kind: 'none' }],
          resolution: { mode: 'viewport', scale: 1, width: 512, height: 512 },
          filter: 'linear',
          wrap: 'clamp',
        },
      ],
      uniforms: [],
      properties: [],
      channels: [],
    };
    expect(assembleWallpaper(valid, []).ok).toBe(true);
    expect(assembleWallpaper({ ...valid, template: '<html>' }, []).ok).toBe(false);
    expect(
      assembleWallpaper(
        {
          ...valid,
          passes: [
            {
              ...valid.passes[0],
              channels: [
                { kind: 'buffer', passId: 'ghost', feedback: false },
                { kind: 'none' },
                { kind: 'none' },
                { kind: 'none' },
              ],
            },
          ],
        },
        [],
      ).ok,
    ).toBe(false);
  });

  it('keeps the player self-contained and coercing what Wallpaper Engine sends', () => {
    expect(() => new Function(WALLPAPER_PLAYER)).not.toThrow();
    expect(WALLPAPER_PLAYER).not.toMatch(/https?:\/\//);
    expect(WALLPAPER_PLAYER).toContain('coerce(control.type, property.value');
  });

  it('delivers a browser ZIP under one folder, and stops when cancelled', async () => {
    const { output } = await exportAndAssemble();
    const downloads: { blob: Blob; name: string }[] = [];
    const writer = new ZipDownloadWriter((blob, name) => downloads.push({ blob, name }));
    await expect(writer.write(output, new AbortController().signal)).resolves.toEqual({
      status: 'written',
      where: 'Neon-Rain.zip',
    });
    const bytes = new Uint8Array(await downloads[0]!.blob.arrayBuffer());
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text).toContain('Neon-Rain/index.html');
    expect(text).toContain('Neon-Rain/project.json');

    const controller = new AbortController();
    controller.abort();
    await expect(writer.write(output, controller.signal)).rejects.toThrow();
    expect(downloads).toHaveLength(1);
  });
});
