import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  APP_VERSION,
  isPluginCompatible,
  parsePluginPackage,
  validateEffectCandidate,
  type EffectCandidate,
  type PluginPackage,
} from '@shadergrove/shared';
import { PluginCallError, PluginHost } from './plugin-host';
import { inProcessStart } from './testing/in-process-sandbox';
import { officialPackageText } from './testing/official-packages';

/**
 * The official ISF plugin, as a user installs it: the package this release's
 * catalogue lists, loaded through the real `PluginHost` and its limits, its
 * code run by an in-process stand-in for the Worker (see
 * `testing/in-process-sandbox`). Compiling and drawing the converted effects
 * is the browser E2E's part.
 */
const fixtures = resolve(import.meta.dirname, '../../../../../plugins/official/isf/fixtures');
const read = (name: string) => readFileSync(resolve(fixtures, name), 'utf8');

function loadPackage(): PluginPackage {
  const parsed = parsePluginPackage(officialPackageText('dev.shadergrove.isf'));
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return parsed.value;
}

const plugin = loadPackage();
const host = () => new PluginHost(plugin, { start: inProcessStart(plugin.code!) });
const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

async function importIsf(text: string): Promise<EffectCandidate> {
  const result = await host().importFile('isf-import', bytes(text));
  const candidate = validateEffectCandidate(result.candidate);
  if (!candidate.ok) throw new Error(candidate.errors.join('; '));
  return candidate.value;
}

async function exportIsf(effect: EffectCandidate): Promise<string> {
  const result = await host().exportEffect('isf-export', effect);
  expect(result.mime).toBe('text/plain');
  return new TextDecoder().decode(result.bytes);
}

const header = (text: string) =>
  JSON.parse(text.slice(2, text.indexOf('*/'))) as Record<string, unknown>;
const isfBody = (text: string) =>
  text
    .slice(text.indexOf('*/') + 2)
    .replace(/^\r?\n/, '')
    .trimEnd();
const markedBody = (source: string) =>
  source.slice(
    source.indexOf('// ---- ISF source ----\n') + '// ---- ISF source ----\n'.length,
    source.indexOf('\n// ---- end of ISF source ----'),
  );

describe('the ISF plugin package', () => {
  it('installs on this app version', () => {
    expect(isPluginCompatible(plugin.manifest, APP_VERSION)).toBe(true);
    expect(plugin.manifest.contributions.map((c) => `${c.kind}:${c.id}`)).toEqual([
      'importer:isf-import',
      'exporter:isf-export',
    ]);
  });
});

describe('importing ISF FX filters', () => {
  it('converts a plain colour filter, keeping its code untouched between the markers', async () => {
    const text = read('tint.fs');
    const effect = await importIsf(text);

    expect(effect.name).toBe('Warm tint');
    expect(effect.controls).toEqual([]);
    expect(markedBody(effect.source)).toBe(isfBody(text).replace(/\r\n/g, '\n'));
    expect(effect.source).toContain('#define main isf_main');
    expect(effect.source).toMatch(/vec4 effect\(vec4 isf_color, vec2 isf_coord\)/);
  });

  it('converts a filter that samples at offset coordinates with time and render size', async () => {
    const effect = await importIsf(read('uv-offset.fs'));

    expect(effect.name).toBe('Wobble');
    expect(effect.source).toContain(
      '#define IMG_NORM_PIXEL(image, coord) texture2D(tDiffuse, coord)',
    );
    expect(effect.source).toContain('#define TIME u_time');
    expect(effect.source).toContain('#define RENDERSIZE u_resolution');
  });

  it('runs a one-pass filter as its first pass, PASSINDEX 0', async () => {
    const header = { ISFVSN: '2', INPUTS: [{ NAME: 'inputImage', TYPE: 'image' }], PASSES: [{}] };
    const effect = await importIsf(
      `/*${JSON.stringify(header)}*/\nvoid main() { gl_FragColor = PASSINDEX == 0 ? IMG_THIS_PIXEL(inputImage) : vec4(0.0); }`,
    );
    expect(effect.source).toContain('#define PASSINDEX 0');
  });

  it("defines the spec's IMG_NORM_THIS_PIXEL and the IMG_THIS_NORM_PIXEL spelling", async () => {
    const effect = await importIsf(read('tint.fs'));
    expect(effect.source).toContain(
      '#define IMG_NORM_THIS_PIXEL(image) texture2D(tDiffuse, isf_uv)',
    );
    expect(effect.source).toContain(
      '#define IMG_THIS_NORM_PIXEL(image) texture2D(tDiffuse, isf_uv)',
    );
  });

  it('chooses a range that keeps the default of a float input without MIN or MAX', async () => {
    const image = { NAME: 'inputImage', TYPE: 'image' };
    const header = {
      ISFVSN: '2',
      INPUTS: [
        image,
        { NAME: 'gain', TYPE: 'float', DEFAULT: 2 },
        { NAME: 'bias', TYPE: 'float', DEFAULT: -3, MAX: 5 },
        { NAME: 'plain', TYPE: 'float' },
      ],
    };
    const effect = await importIsf(
      `/*${JSON.stringify(header)}*/\nvoid main() { gl_FragColor = IMG_THIS_PIXEL(inputImage) * gain; }`,
    );
    expect(effect.controls).toEqual([
      { key: 'gain', type: 'number', default: 2, min: 0, max: 2 },
      { key: 'bias', type: 'number', default: -3, min: -3, max: 5 },
      { key: 'plain', type: 'number', default: 0, min: 0, max: 1 },
    ]);
  });

  it.each([
    {
      labels: ['Mode', 'Mode (2)', 'Mode'],
      options: { Mode: 0, 'Mode (2)': 1, 'Mode (2) 2': 2 },
    },
    {
      labels: ['Mode', 'Mode (4)', 'Mode (4) 2', 'Mode (4) 3', 'Mode'],
      options: { Mode: 0, 'Mode (4)': 1, 'Mode (4) 2': 2, 'Mode (4) 3': 3, 'Mode (4) 4': 4 },
    },
  ])('keeps every long input value when labels collide: $labels', async ({ labels, options }) => {
    const header = {
      ISFVSN: '2',
      INPUTS: [
        { NAME: 'inputImage', TYPE: 'image' },
        {
          NAME: 'mode',
          TYPE: 'long',
          VALUES: labels.map((_, index) => index),
          LABELS: labels,
          DEFAULT: 1,
        },
      ],
    };
    const effect = await importIsf(
      `/*${JSON.stringify(header)}*/\nvoid main() { gl_FragColor = IMG_THIS_PIXEL(inputImage); }`,
    );

    expect(effect.controls).toEqual([{ key: 'mode', type: 'select', default: 1, options }]);
    expect(effect.values).toEqual({ mode: 1 });
  });

  it('turns float, bool, color and long inputs into controls with their defaults', async () => {
    const effect = await importIsf(read('controls.fs'));

    expect(effect.controls).toEqual([
      { key: 'levels', type: 'number', default: 4, min: 2, max: 16, label: 'Levels' },
      { key: 'invert', type: 'boolean', default: false, label: 'Invert' },
      { key: 'tint', type: 'color', default: '#ff8040', label: 'Tint' },
      {
        key: 'channel',
        type: 'select',
        default: 0,
        options: { All: 0, Luma: 1, Red: 2 },
        label: 'Channel',
      },
    ]);
    expect(effect.values).toEqual({ levels: 4, invert: false, tint: '#ff8040', channel: 0 });
    // Each ISF name reaches its control's uniform, as ISF typed it, through a global set
    // before the ISF main, so a declaration of that name (a parameter `vec4 tint`) still
    // compiles.
    expect(effect.source).toContain('float isf_in_levels;\n#define levels isf_in_levels');
    expect(effect.source).toContain('  isf_in_levels = u_levels;');
    expect(effect.source).toContain('vec4 isf_in_tint;\n#define tint isf_in_tint');
    expect(effect.source).toContain('  isf_in_tint = vec4(u_tint, 1.0);');
    expect(effect.source).toContain('int isf_in_channel;\n#define channel isf_in_channel');
    expect(effect.source).toContain('  isf_in_channel = int(u_channel);');
  });
});

describe('exporting and re-importing', () => {
  it('round-trips an imported filter: code, controls, current values and the rest of the header', async () => {
    const original = read('controls.fs').replace('Shadergrove fixture', 'Shadergrove *\\/ fixture');
    const imported = await importIsf(original);
    const tuned = { ...imported, values: { levels: 8, invert: true, tint: '#00ff00', channel: 2 } };

    const exported = await exportIsf(tuned);
    expect(header(exported)).toMatchObject({
      ISFVSN: '2',
      DESCRIPTION: 'Posterize',
      CREDIT: 'Shadergrove */ fixture',
      CATEGORIES: ['Stylize'],
    });
    expect(isfBody(exported)).toBe(isfBody(original).replace(/\r\n/g, '\n'));

    const again = await importIsf(exported);
    expect(again.controls).toEqual(
      imported.controls.map((control) => ({
        ...control,
        default: tuned.values[control.key as keyof typeof tuned.values],
      })),
    );
    expect(again.values).toEqual(tuned.values);
    expect(markedBody(again.source)).toBe(markedBody(imported.source));
  });

  it('exports an effect written here as ISF that imports back with the same controls', async () => {
    const native: EffectCandidate = {
      name: 'Gain & tint',
      source:
        'vec4 effect(vec4 color, vec2 uv) {\n  vec4 shifted = texture2D(tDiffuse, uv + vec2(0.01, 0.0));\n  return vec4(mix(color.rgb, shifted.rgb, 0.5) * u_gain * u_tint, color.a);\n}',
      controls: [
        { key: 'gain', type: 'number', default: 1, min: 0, max: 2 },
        { key: 'tint', type: 'color', default: '#ffffff' },
      ],
      values: { gain: 1.5, tint: '#ff0000' },
    };

    const exported = await exportIsf(native);
    expect(header(exported)['INPUTS']).toEqual([
      { NAME: 'inputImage', TYPE: 'image' },
      { NAME: 'gain', TYPE: 'float', DEFAULT: 1.5, MIN: 0, MAX: 2 },
      { NAME: 'tint', TYPE: 'color', DEFAULT: [1, 0, 0, 1] },
    ]);
    expect(exported).toContain('float isf_u_gain() { return gain; }');
    expect(exported).toContain('#define u_gain isf_u_gain()');
    expect(exported).toContain('#define vUv isf_FragNormCoord');
    expect(exported).toContain(
      'gl_FragColor = effect(IMG_THIS_PIXEL(inputImage), isf_FragNormCoord);',
    );

    const again = await importIsf(exported);
    expect(again.name).toBe('Gain & tint');
    expect(again.controls.map((control) => control.key)).toEqual(['gain', 'tint']);
    expect(again.values).toEqual({ gain: 1.5, tint: '#ff0000' });
    // Its own `effect` is renamed by the preprocessor so the wrapper's can exist.
    expect(again.source).toContain('#define effect isf_inner_effect');
  });

  it('round-trips comment terminators in an effect name and control label', async () => {
    const native: EffectCandidate = {
      name: 'A */ B',
      source: 'vec4 effect(vec4 color, vec2 uv) { return color * u_gain; }',
      controls: [
        { key: 'gain', type: 'number', default: 1, min: 0, max: 2, label: 'Gain */ label' },
      ],
      values: {},
    };

    const again = await importIsf(await exportIsf(native));
    expect(again.name).toBe(native.name);
    expect(again.controls).toEqual(native.controls);
  });

  it('refuses to export a select whose values are not integers, as an ISF long needs', async () => {
    await expect(
      exportIsf({
        name: 'Halves',
        source: 'vec4 effect(vec4 color, vec2 uv) { return color * u_amount; }',
        controls: [
          { key: 'amount', type: 'select', default: 0.5, options: { Half: 0.5, More: 1.5 } },
        ],
        values: {},
      }),
    ).rejects.toThrow(/integer/);
  });

  it.each([
    'inputImage',
    'u_time',
    'u_gain',
    'rgb',
    'float',
    'texture2D',
    'inline',
    'defined',
    'texture',
    'round',
    'viewMatrix',
  ])('refuses to export a control named %s, which ISF or the plugin reserves', async (key) => {
    await expect(
      exportIsf({
        name: 'Clash',
        source: `vec4 effect(vec4 color, vec2 uv) { return color * u_${key}; }`,
        controls: [{ key, type: 'number', default: 1, min: 0, max: 2 }],
        values: {},
      }),
    ).rejects.toThrow(/reserved/);
  });

  it('reads a control through a global function, so a parameter of the same name cannot shadow it', async () => {
    const exported = await exportIsf({
      name: 'Tint',
      source: 'vec4 effect(vec4 color, vec2 uv) { return vec4(color.rgb * u_color, color.a); }',
      controls: [{ key: 'color', type: 'color', default: '#ffffff' }],
      values: {},
    });
    expect(exported).toContain('vec3 isf_u_color() { return color.rgb; }');
    expect(exported).toContain('#define u_color isf_u_color()');
    expect(exported.indexOf('isf_u_color() {')).toBeLessThan(exported.lastIndexOf('vec4 effect('));
  });
});

describe('what the ISF plugin refuses, with a reason', () => {
  const isf = (
    json: Record<string, unknown>,
    body = 'void main() { gl_FragColor = IMG_THIS_PIXEL(inputImage); }',
  ) => `/*${JSON.stringify(json)}*/\n${body}`;
  const image = { NAME: 'inputImage', TYPE: 'image' };
  const failure = (text: string) =>
    host()
      .importFile('isf-import', bytes(text))
      .then(
        () => 'imported',
        (error: Error) => error.message,
      );

  it.each([
    ['a generator', isf({ ISFVSN: '2', INPUTS: [] }), /generator/],
    [
      'a transition',
      isf({ ISFVSN: '2', INPUTS: [image, { NAME: 'startImage', TYPE: 'image' }] }),
      /transition/,
    ],
    [
      'an audio input',
      isf({ ISFVSN: '2', INPUTS: [image, { NAME: 'wave', TYPE: 'audio' }] }),
      /audio/,
    ],
    [
      'a point2D input',
      isf({ ISFVSN: '2', INPUTS: [image, { NAME: 'centre', TYPE: 'point2D' }] }),
      /point2D/,
    ],
    [
      'an event input',
      isf({ ISFVSN: '2', INPUTS: [image, { NAME: 'bang', TYPE: 'event' }] }),
      /event/,
    ],
    ['several passes', isf({ ISFVSN: '2', INPUTS: [image], PASSES: [{}, {}] }), /Multi-pass/],
    [
      'a persistent buffer',
      isf({ ISFVSN: '2', INPUTS: [image], PASSES: [{ TARGET: 'acc', PERSISTENT: true }] }),
      /Persistent/,
    ],
    [
      'a pass with its own size',
      isf({ ISFVSN: '2', INPUTS: [image], PASSES: [{ WIDTH: '$WIDTH/2', HEIGHT: '$HEIGHT/2' }] }),
      /WIDTH or HEIGHT/,
    ],
    [
      'imported images',
      isf({ ISFVSN: '2', INPUTS: [image], IMPORTED: { noise: { PATH: 'noise.png' } } }),
      /IMPORTED/,
    ],
    ['an ISF 1 file', isf({ INPUTS: [image] }), /ISF 1/],
    ['an unknown version', isf({ ISFVSN: '3', INPUTS: [image] }), /version "3"/],
    [
      'a reserved input name',
      isf({ ISFVSN: '2', INPUTS: [image, { NAME: 'time', TYPE: 'float' }] }),
      /reserved/,
    ],
    [
      'an input named float, a GLSL keyword',
      isf({ ISFVSN: '2', INPUTS: [image, { NAME: 'float', TYPE: 'float' }] }),
      /reserved/,
    ],
    [
      'an input named sin, a GLSL built-in function',
      isf({ ISFVSN: '2', INPUTS: [image, { NAME: 'sin', TYPE: 'float' }] }),
      /reserved/,
    ],
    [
      'an input named texture, a GLSL ES 3.00 sampling function',
      isf({ ISFVSN: '2', INPUTS: [image, { NAME: 'texture', TYPE: 'float' }] }),
      /reserved/,
    ],
    [
      'an input named round, a GLSL ES 3.00 built-in function',
      isf({ ISFVSN: '2', INPUTS: [image, { NAME: 'round', TYPE: 'float' }] }),
      /reserved/,
    ],
    [
      'an input named viewMatrix, a three.js prefix uniform',
      isf({ ISFVSN: '2', INPUTS: [image, { NAME: 'viewMatrix', TYPE: 'float' }] }),
      /reserved/,
    ],
    [
      'an input named inline, a GLSL future reserved word',
      isf({ ISFVSN: '2', INPUTS: [image, { NAME: 'inline', TYPE: 'float' }] }),
      /reserved/,
    ],
    [
      'an input named like an app uniform',
      isf({ ISFVSN: '2', INPUTS: [image, { NAME: 'u_time', TYPE: 'float' }] }),
      /reserved/,
    ],
    [
      'an input named r, a vector component',
      isf(
        { ISFVSN: '2', INPUTS: [image, { NAME: 'r', TYPE: 'float' }] },
        'void main() { vec4 c = IMG_THIS_PIXEL(inputImage); gl_FragColor = vec4(c.r * r, c.gba); }',
      ),
      /vector swizzle/,
    ],
    [
      'an input named xy, a vector swizzle',
      isf({ ISFVSN: '2', INPUTS: [image, { NAME: 'xy', TYPE: 'float' }] }),
      /vector swizzle/,
    ],
    [
      'an input named stpq, a vector swizzle',
      isf({ ISFVSN: '2', INPUTS: [image, { NAME: 'stpq', TYPE: 'float' }] }),
      /vector swizzle/,
    ],
    [
      'a long without VALUES',
      isf({ ISFVSN: '2', INPUTS: [image, { NAME: 'mode', TYPE: 'long' }] }),
      /VALUES/,
    ],
    [
      'a float whose MIN is not below MAX',
      isf({ ISFVSN: '2', INPUTS: [image, { NAME: 'k', TYPE: 'float', MIN: 1, MAX: 1 }] }),
      /MIN/,
    ],
    ['a header that is not JSON', '/*{ nope */\nvoid main() {}', /not valid JSON/],
    ['a file with no header', 'void main() {}', /must start with/],
  ])('refuses %s', async (_what, text, reason) => {
    expect(await failure(text)).toMatch(reason);
  });

  it('refuses a file that is not UTF-8 text', async () => {
    const latin1 = new Uint8Array([0x2f, 0x2a, 0xff, 0xfe]).buffer;
    await expect(host().importFile('isf-import', latin1)).rejects.toThrow(/not UTF-8/);
  });

  it('refuses a file over the size its manifest allows before the plugin sees it', async () => {
    const tooBig = new ArrayBuffer(262_145);
    await expect(host().importFile('isf-import', tooBig)).rejects.toMatchObject({
      code: 'input-too-large',
    } satisfies Partial<PluginCallError>);
  });
});
