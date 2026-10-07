import { describe, expect, it } from 'vitest';

import { DEFAULT_RENDER } from '../model';
import { DEFAULT_VERTEX } from '../project/defaults';
import { makePass } from '../project/factory';
import type { RenderPass, ShaderProject } from '../project/types';
import { PLUGIN_LIMITS, parsePluginPackage, validatePluginPackage } from './package';
import {
  ASSET_WORKFLOWS,
  CAPABILITY_PROFILES,
  CAPABILITY_PROFILE_IDS,
  PALETTE_FORMAT,
  TOOL_LIMITS,
  capabilityProfile,
  instantiateProjectTemplate,
  prepareAnalyzerInput,
  prepareAssetToolInput,
  sourceFingerprint,
  validateAnalyzerReport,
  validateAssetToolOutput,
  validatePalette,
  byteLengthOf,
  type AnalyzerContribution,
  type AssetToolContribution,
  type RgbaSource,
} from './package';

// --- Fixtures -----------------------------------------------------------------

const analyzer: AnalyzerContribution = {
  kind: 'analyzer',
  id: 'doctor',
  name: 'Doctor',
  profiles: ['studio-webgl2/v1', 'wallpaper-web/v1'],
};
const textureTool: AssetToolContribution = {
  kind: 'assetTool',
  id: 'pack',
  name: 'Pack',
  workflow: 'texture-utilities/v1',
  inputs: ['image'],
  outputs: ['image'],
};
const paletteTool: AssetToolContribution = {
  kind: 'assetTool',
  id: 'palette',
  name: 'Palette',
  workflow: 'palette-studio/v1',
  inputs: ['image', 'palette'],
  outputs: ['palette', 'effect'],
};

/** A feedback project: buffer A samples itself, the image samples A. */
function feedbackProject(): ShaderProject {
  const buffer: RenderPass = makePass({
    id: 'trail',
    kind: 'buffer',
    name: 'Trails',
    slot: 'A',
    source: 'void main() {}\n// two\n// three',
    channels: [
      { kind: 'buffer', passId: 'trail', feedback: true },
      { kind: 'none' },
      { kind: 'none' },
      { kind: 'none' },
    ],
  });
  const image = makePass({
    id: 'main',
    kind: 'image',
    name: 'Image',
    source: 'void main() {}',
    channels: [
      { kind: 'buffer', passId: 'trail', feedback: false },
      { kind: 'none' },
      { kind: 'none' },
      { kind: 'none' },
    ],
  });
  const common = makePass({ id: 'common', kind: 'common', name: 'Common', source: '' });
  return {
    version: 1,
    vertex: DEFAULT_VERTEX,
    passes: [common, buffer, image],
    files: [{ id: 'shared', name: 'shared.glsl', source: 'float k = 1.0;' }],
  };
}

const control = { key: 'speed', type: 'number', label: 'Speed', default: 1, min: 0, max: 4 };

function templatePayload(overrides: Record<string, unknown> = {}) {
  return {
    project: feedbackProject(),
    controls: [control],
    render: {
      postProcessing: {
        enabled: true,
        effects: [
          { type: 'vignette', instanceId: 'v1', enabled: true, settings: {} },
          { type: 'bloom', instanceId: 'b1', enabled: false, settings: {} },
        ],
      },
    },
    presets: [
      { id: 'fast', name: 'Fast', createdAt: '2026-01-01T00:00:00.000Z', values: { speed: 3 } },
    ],
    ...overrides,
  };
}

const templateContribution = {
  kind: 'projectTemplate',
  id: 'trails',
  name: 'Trails',
  description: 'A feedback buffer smearing its own last frame.',
  difficulty: 'intermediate',
  notes: ['Feedback is a buffer reading the frame it drew last tick.'],
  provenance: { author: 'Example', license: 'CC0-1.0' },
};

function pkg(
  contributions: unknown[],
  extra: Record<string, unknown> = {},
  protocolVersion = 4,
): Record<string, unknown> {
  return {
    manifest: {
      id: 'dev.example.tools',
      version: '1.0.0',
      protocolVersion,
      appVersionRange: '>=2.0.0 <3.0.0',
      name: 'Tools',
      publisher: 'Example',
      license: 'MIT',
      contributions,
    },
    ...extra,
  };
}

const CODE = 'shaderStudio.handle("analyzer:doctor", () => ({}));';
const errors = (input: unknown) => {
  const result = validatePluginPackage(input);
  return result.ok ? [] : result.errors;
};

/** `width × height` RGBA bytes filled by `fill`. */
function plane(
  width: number,
  height: number,
  overrides: Partial<RgbaSource> = {},
  fill = (i: number) => i % 251,
): RgbaSource {
  const bytes = new Uint8Array(width * height * 4);
  for (let i = 0; i < bytes.length; i++) bytes[i] = fill(i);
  return {
    width,
    height,
    orientation: 'top-left',
    alpha: 'straight',
    usage: 'data',
    rgba: bytes.buffer,
    ...overrides,
  };
}

const failure = <T>(result: { ok: boolean; value?: T; code?: string; errors?: string[] }) =>
  result.ok ? 'ok' : `${result.code}: ${result.errors?.[0]}`;

// --- Manifests ----------------------------------------------------------------

describe('protocol 4 manifests', () => {
  it('accepts the three new kinds, with code only where a Worker is needed', () => {
    expect(validatePluginPackage(pkg([analyzer, textureTool], { code: CODE })).ok).toBe(true);
    const templated = validatePluginPackage(
      pkg([templateContribution], { templates: { trails: templatePayload() } }),
    );
    expect(templated.ok).toBe(true);
    if (templated.ok) {
      expect(Object.keys(templated.value.templates)).toEqual(['trails']);
      expect(templated.value.code).toBeUndefined();
    }
  });

  it('keeps protocols 1–3 and refuses the new kinds under them, and any later protocol', () => {
    for (const protocolVersion of [1, 2, 3]) {
      expect(errors(pkg([analyzer], { code: CODE }, protocolVersion))[0]).toMatch(
        /needs protocolVersion 4/,
      );
      expect(errors(pkg([templateContribution], { templates: {} }, protocolVersion))[0]).toMatch(
        /needs protocolVersion 4/,
      );
    }
    expect(errors(pkg([analyzer], { code: CODE }, 5))[0]).toMatch(/protocolVersion 5/);
    // A protocol-1 effect package parses exactly as before: no templates, nothing new required.
    const old = validatePluginPackage({
      manifest: {
        id: 'dev.example.old',
        version: '1.0.0',
        protocolVersion: 1,
        appVersionRange: '>=1.0.0',
        name: 'Old',
        publisher: 'Example',
        license: 'MIT',
        contributions: [{ kind: 'effect', id: 'tint', name: 'Tint', controls: [] }],
      },
      glsl: { tint: 'vec4 effect(vec4 c, vec2 uv) { return c; }' },
    });
    expect(old.ok && old.value.templates).toEqual({});
  });

  it('refuses unknown fields, workflows and profiles instead of ignoring them', () => {
    const bad = (contribution: unknown, extra: Record<string, unknown> = { code: CODE }) =>
      errors(pkg([contribution], extra))[0];
    expect(bad({ ...analyzer, url: 'https://x' })).toMatch(/url is not a known field/);
    expect(bad({ ...textureTool, mime: 'x' })).toMatch(/mime is not a known field/);
    expect(bad({ ...textureTool, workflow: 'custom/v1' })).toMatch(/not a supported workflow/);
    expect(bad({ ...analyzer, profiles: ['webgpu/v9'] })).toMatch(/not a registered capability/);
    expect(bad({ ...analyzer, profiles: [] })).toMatch(/profiles/);
    expect(bad({ ...analyzer, profiles: ['studio-webgl2/v1', 'studio-webgl2/v1'] })).toMatch(
      /repeat/,
    );
    // A workflow's declared kinds must sit inside what the host workflow allows.
    expect(bad({ ...textureTool, outputs: ['palette'] })).toMatch(/outputs must be among image/);
    expect(bad({ ...paletteTool, inputs: ['image', 'palette', 'x'] })).toMatch(/inputs/);
    expect(
      bad({ ...templateContribution, difficulty: 'expert' }, { templates: { trails: {} } }),
    ).toMatch(/difficulty/);
    expect(
      bad({ ...templateContribution, extra: 1 }, { templates: { trails: templatePayload() } }),
    ).toMatch(/extra is not a known field/);
  });

  it('needs code for Worker contributions and refuses it for templates alone', () => {
    expect(errors(pkg([analyzer]))[0]).toMatch(/code is required/);
    expect(errors(pkg([textureTool]))[0]).toMatch(/code is required/);
    expect(
      errors(
        pkg([templateContribution], { code: CODE, templates: { trails: templatePayload() } }),
      )[0],
    ).toMatch(/code is only for/);
  });

  it('keeps `workflow` ids and `profile` ids in step with the host tables', () => {
    expect(Object.keys(ASSET_WORKFLOWS)).toEqual(['texture-utilities/v1', 'palette-studio/v1']);
    for (const id of CAPABILITY_PROFILE_IDS) {
      expect(CAPABILITY_PROFILES[id].id).toBe(id);
      expect(id.endsWith(`/v${CAPABILITY_PROFILES[id].version}`)).toBe(true);
    }
    expect(capabilityProfile('nope')).toBeNull();
  });
});

describe('template payloads', () => {
  const packaged = (payload: unknown, contribution: unknown = templateContribution) =>
    errors(pkg([contribution], { templates: { trails: payload } }))[0];

  it('keeps one validated payload per template, normalised by the bundle validators', () => {
    const result = validatePluginPackage(
      pkg([templateContribution], { templates: { trails: templatePayload() } }),
    );
    if (!result.ok) throw new Error(result.errors.join());
    const payload = result.value.templates['trails']!;
    expect(payload.project.passes.map((pass) => pass.id)).toEqual(['common', 'trail', 'main']);
    expect(payload.controls[0]!.default).toBe(1);
    expect(payload.presets[0]!.values).toEqual({ speed: 3 });
    expect(payload.render.postProcessing.effects).toHaveLength(2);
  });

  it('refuses textures, dangling references, unknown fields and a missing or surplus entry', () => {
    const project = feedbackProject();
    const withBinding = (binding: unknown) => ({
      ...project,
      passes: project.passes.map((pass) =>
        pass.kind === 'image' ? { ...pass, channels: [binding, ...pass.channels.slice(1)] } : pass,
      ),
    });
    expect(
      packaged(templatePayload({ project: withBinding({ kind: 'texture', slot: 0 }) })),
    ).toMatch(/must not bind a texture/);
    expect(
      packaged(
        templatePayload({
          project: withBinding({ kind: 'buffer', passId: 'ghost', feedback: false }),
        }),
      ),
    ).toMatch(/pass that does not exist/);
    expect(packaged(templatePayload({ network: 'https://x' }))).toMatch(/network is not a known/);
    expect(packaged(templatePayload({ project: { passes: [] } }))).toMatch(/passes/);
    // An incomplete project (no Common pass) is refused, not completed with a random id.
    const incomplete = feedbackProject();
    incomplete.passes = incomplete.passes.filter((pass) => pass.kind !== 'common');
    expect(packaged(templatePayload({ project: incomplete }))).toMatch(/must be complete/);
    expect(errors(pkg([templateContribution], {}))[0]).toMatch(/templates\["trails"\] is required/);
    expect(
      errors(
        pkg([templateContribution], { templates: { trails: templatePayload(), other: {} } }),
      )[0],
    ).toMatch(/other/);
    expect(errors(pkg([templateContribution], { templates: [] }))[0]).toMatch(/templates/);
  });

  it('refuses a template over its size limit and a bad control or preset', () => {
    const big = feedbackProject();
    big.vertex = 'x'.repeat(TOOL_LIMITS.templatePayloadBytes);
    expect(packaged(templatePayload({ project: big }))).toMatch(/at most/);
    expect(
      packaged(templatePayload({ controls: [{ key: 'time', type: 'number', default: 1 }] })),
    ).toMatch(/controls|reserved/);
  });

  it('instantiates with fresh identities and the same graph, twice', () => {
    const parsed = validatePluginPackage(
      pkg([templateContribution], { templates: { trails: templatePayload() } }),
    );
    if (!parsed.ok) throw new Error(parsed.errors.join());
    const payload = parsed.value.templates['trails']!;
    let n = 0;
    const fresh = (prefix: string) => `${prefix}-n${++n}`;
    const a = instantiateProjectTemplate(payload, fresh);
    const b = instantiateProjectTemplate(payload, fresh);

    const ids = (copy: typeof a) => [
      ...copy.project.passes.map((pass) => pass.id),
      ...copy.project.files.map((file) => file.id),
      ...copy.render.postProcessing.effects.map((effect) => effect.instanceId),
    ];
    const original = [
      ...payload.project.passes.map((pass) => pass.id),
      ...payload.project.files.map((file) => file.id),
      ...payload.render.postProcessing.effects.map((effect) => effect.instanceId),
    ];
    const all = [...ids(a), ...ids(b), ...original];
    expect(new Set(all).size).toBe(all.length);

    // The feedback edge still points at the pass it pointed at: the copy's own buffer.
    const [, buffer, image] = a.project.passes;
    expect(buffer!.channels[0]).toEqual({ kind: 'buffer', passId: buffer!.id, feedback: true });
    expect(image!.channels[0]).toEqual({ kind: 'buffer', passId: buffer!.id, feedback: false });
    // The source is untouched and the copy shares no structure with it.
    expect(payload.project.passes[1]!.id).toBe('trail');
    a.project.passes[1]!.source = 'changed';
    expect(payload.project.passes[1]!.source).not.toBe('changed');
    expect(buffer!.source).toBe('changed');
    expect(a.controls).toEqual(payload.controls);
    expect(DEFAULT_RENDER.postProcessing.effects[0]!.instanceId).toBe('bloom');
  });
});

// --- Palette ------------------------------------------------------------------

describe('palette JSON', () => {
  const palette = {
    format: PALETTE_FORMAT,
    name: ' Sunset ',
    colors: ['#FF8000', '#001122'],
    gradient: {
      interpolation: 'oklab',
      stops: [
        { position: 0, color: '#FF8000' },
        { position: 0.5, color: '#001122' },
        { position: 0.5, color: '#00ff00' },
      ],
    },
  };

  it('round-trips through JSON, lowercasing and trimming', () => {
    const first = validatePalette(palette);
    if (!first.ok) throw new Error(first.errors.join());
    expect(first.value.name).toBe('Sunset');
    expect(first.value.colors).toEqual(['#ff8000', '#001122']);
    const again = validatePalette(JSON.parse(JSON.stringify(first.value)));
    expect(again).toEqual(first);
  });

  it('refuses everything outside the frozen shape', () => {
    const bad = (value: unknown) => {
      const result = validatePalette(value);
      return result.ok ? 'ok' : result.errors[0];
    };
    expect(bad({ ...palette, format: 'x' })).toMatch(/format/);
    expect(bad({ ...palette, extra: 1 })).toMatch(/extra/);
    expect(bad({ ...palette, colors: Array(9).fill('#000000') })).toMatch(/at most 8/);
    expect(bad({ ...palette, colors: ['red'] })).toMatch(/#rrggbb/);
    expect(bad({ ...palette, colors: ['#fff'] })).toMatch(/#rrggbb/);
    expect(bad({ ...palette, name: '' })).toMatch(/name/);
    expect(bad({ ...palette, colors: [], gradient: undefined })).toMatch(/colors or a gradient/);
    const stops = (list: unknown[], interpolation = 'srgb') => ({
      ...palette,
      gradient: { interpolation, stops: list },
    });
    expect(bad(stops([{ position: 0, color: '#000000' }]))).toMatch(/2 to 8/);
    expect(
      bad(
        stops([
          { position: 0.6, color: '#000000' },
          { position: 0.2, color: '#ffffff' },
        ]),
      ),
    ).toMatch(/not decrease/);
    expect(
      bad(
        stops([
          { position: 0, color: '#000000' },
          { position: 1.5, color: '#ffffff' },
        ]),
      ),
    ).toMatch(/0 to 1/);
    expect(
      bad(
        stops(
          [
            { position: 0, color: '#000000' },
            { position: 1, color: '#ffffff' },
          ],
          'hsl',
        ),
      ),
    ).toMatch(/interpolation/);
    expect(bad(stops(Array(9).fill({ position: 0, color: '#000000' })))).toMatch(/2 to 8/);
  });
});

// --- Asset tool input ---------------------------------------------------------

describe('prepareAssetToolInput', () => {
  const request = (planes: RgbaSource[], extra: Record<string, unknown> = {}) => ({
    operation: 'pack',
    planes,
    ...extra,
  });

  it('copies each plane, leaving the host buffer attached and the copy transferable', () => {
    const source = plane(4, 3);
    const original = source.rgba as ArrayBuffer;
    const before = new Uint8Array(original).slice();
    const result = prepareAssetToolInput(textureTool, request([source], { settings: { gain: 2 } }));
    if (!result.ok) throw new Error(result.errors.join());
    const sent = result.value.input.planes[0]!;
    expect(sent.rgba).not.toBe(original);
    expect(result.value.transfer).toEqual([sent.rgba]);
    expect(original.byteLength).toBe(48);
    expect(new Uint8Array(sent.rgba)).toEqual(before);
    // Transferring the copy leaves the host's own buffer alone.
    structuredClone(result.value.input, { transfer: result.value.transfer });
    expect(sent.rgba.byteLength).toBe(0);
    expect(original.byteLength).toBe(48);
    expect(new Uint8Array(original)).toEqual(before);
    expect(result.value.input).toMatchObject({
      workflow: 'texture-utilities/v1',
      operation: 'pack',
      preview: false,
      settings: { gain: 2 },
    });
  });

  it('counts a typed-array view by its own bytes, never its buffer, and copies only that window', () => {
    const big = new Uint8Array(1024);
    big.forEach((_, i) => (big[i] = i % 256));
    // 2×2 RGBA is 16 bytes, found at offset 100 of a 1 KiB buffer.
    const view = new Uint8ClampedArray(big.buffer, 100, 16);
    expect(byteLengthOf(view)).toBe(16);
    expect(byteLengthOf(big.buffer)).toBe(1024);
    const result = prepareAssetToolInput(textureTool, request([{ ...plane(2, 2), rgba: view }]));
    if (!result.ok) throw new Error(result.errors.join());
    expect(result.value.input.planes[0]!.rgba.byteLength).toBe(16);
    expect(new Uint8Array(result.value.input.planes[0]!.rgba)).toEqual(big.slice(100, 116));
    // A view as long as its whole buffer is wrong for a smaller plane: only the window counts.
    expect(
      failure(
        prepareAssetToolInput(
          textureTool,
          request([{ ...plane(2, 2), rgba: new Uint8Array(big.buffer, 0, 1024) }]),
        ),
      ),
    ).toMatch(/input-invalid: .*1024 bytes; 2×2 RGBA is 16/);
    // Shared memory is not an ArrayBuffer and cannot be copied-from or transferred.
    expect(
      failure(
        prepareAssetToolInput(
          textureTool,
          request([{ ...plane(1, 1), rgba: new Uint8Array(new SharedArrayBuffer(4)) }]),
        ),
      ),
    ).toMatch(/must be an ArrayBuffer/);
  });

  it('enforces the exact RGBA length and the dimension limits at their boundaries', () => {
    const exact = plane(TOOL_LIMITS.planeDimension, TOOL_LIMITS.planeDimension);
    expect(prepareAssetToolInput(textureTool, request([exact])).ok).toBe(true);
    const short = { ...plane(2, 2), rgba: new ArrayBuffer(15) };
    const long = { ...plane(2, 2), rgba: new ArrayBuffer(17) };
    expect(failure(prepareAssetToolInput(textureTool, request([short])))).toMatch(
      /input-invalid: .*15 bytes; 2×2 RGBA is 16/,
    );
    expect(failure(prepareAssetToolInput(textureTool, request([long])))).toMatch(/17 bytes/);
    const tall = { ...plane(1, 1), height: TOOL_LIMITS.planeDimension + 1 };
    expect(failure(prepareAssetToolInput(textureTool, request([tall])))).toMatch(
      /input-too-large: .*height must be at most 1024/,
    );
    expect(
      failure(prepareAssetToolInput(textureTool, request([{ ...plane(1, 1), width: 0 }]))),
    ).toMatch(/input-invalid/);
    expect(
      failure(prepareAssetToolInput(textureTool, request([{ ...plane(1, 1), width: 1.5 }]))),
    ).toMatch(/input-invalid/);
  });

  it('allows four planes of 1024×1024 and refuses a fifth, within 16 MiB of pixels', () => {
    const full = Array.from({ length: 4 }, () => plane(1024, 1024, {}, () => 0));
    const result = prepareAssetToolInput(textureTool, request(full));
    if (!result.ok) throw new Error(result.errors.join());
    expect(result.value.bytes).toBeGreaterThanOrEqual(TOOL_LIMITS.pixelInputBytes);
    expect(result.value.bytes).toBeLessThanOrEqual(TOOL_LIMITS.inputBytes);
    expect(failure(prepareAssetToolInput(textureTool, request([...full, plane(1, 1)])))).toMatch(
      /input-too-large: at most 4 planes/,
    );
  });

  it('limits a preview to 256×256 and treats a full-resolution job the same otherwise', () => {
    expect(
      prepareAssetToolInput(textureTool, request([plane(256, 256)], { preview: true })).ok,
    ).toBe(true);
    expect(
      failure(prepareAssetToolInput(textureTool, request([plane(257, 1)], { preview: true }))),
    ).toMatch(/input-too-large: .*width must be at most 256/);
    expect(prepareAssetToolInput(textureTool, request([plane(257, 1)])).ok).toBe(true);
  });

  it('refuses inputs the contribution does not declare, hostile settings and a mislabelled alpha', () => {
    expect(
      failure(prepareAssetToolInput(textureTool, request([plane(1, 1)], { palette: {} }))),
    ).toMatch(/takes no palette/);
    expect(
      failure(prepareAssetToolInput(textureTool, request([], { operation: 'Pack!' }))),
    ).toMatch(/operation/);
    const hostile = [
      { buffer: new ArrayBuffer(8) },
      { view: new Uint8Array(4) },
      { fn: () => 1 },
      { n: Number.NaN },
      { nested: new Map() },
    ];
    for (const settings of hostile) {
      expect(failure(prepareAssetToolInput(textureTool, request([], { settings })))).toMatch(
        /input-invalid: settings must be a plain JSON object/,
      );
    }
    expect(
      failure(
        prepareAssetToolInput(textureTool, request([], { settings: { text: 'x'.repeat(70_000) } })),
      ),
    ).toMatch(/input-too-large: settings/);
    expect(
      failure(prepareAssetToolInput(textureTool, request([plane(2, 2, { alpha: 'opaque' })]))),
    ).toMatch(/declared opaque/);
    expect(
      prepareAssetToolInput(
        textureTool,
        request([plane(2, 2, { alpha: 'opaque' }, (i) => (i % 4 === 3 ? 255 : 7))]),
      ).ok,
    ).toBe(true);
    expect(
      failure(
        prepareAssetToolInput(textureTool, request([{ ...plane(1, 1), usage: 'albedo' as never }])),
      ),
    ).toMatch(/usage/);
    expect(
      failure(prepareAssetToolInput(textureTool, request([{ ...plane(1, 1), extra: 1 } as never]))),
    ).toMatch(/extra is not a known field/);
  });

  it('validates a palette input where the workflow takes one', () => {
    const good = {
      format: PALETTE_FORMAT,
      name: 'P',
      colors: ['#000000', '#ffffff'],
    };
    const result = prepareAssetToolInput(paletteTool, request([plane(2, 2)], { palette: good }));
    expect(result.ok && result.value.input.palette).toEqual(good);
    expect(
      failure(
        prepareAssetToolInput(paletteTool, request([], { palette: { ...good, colors: ['x'] } })),
      ),
    ).toMatch(/input-invalid/);
  });
});

// --- Asset tool output --------------------------------------------------------

describe('validateAssetToolOutput', () => {
  const image = (width: number, height: number, extra: Record<string, unknown> = {}) => ({
    name: 'packed',
    ...plane(width, height),
    ...extra,
  });
  const imageOutput = (images: unknown[], extra: Record<string, unknown> = {}) => ({
    kind: 'image',
    images,
    ...extra,
  });

  it('accepts exact images, keeping their buffers and a bounded metadata object', () => {
    const output = imageOutput([image(2, 2)], { metadata: { channels: ['r', 'g', 'b', 'a'] } });
    const result = validateAssetToolOutput(output, textureTool);
    if (!result.ok) throw new Error(result.errors.join());
    expect(result.value.kind).toBe('image');
    if (result.value.kind === 'image') {
      expect(result.value.images[0]!.rgba.byteLength).toBe(16);
      expect(result.value.metadata).toEqual({ channels: ['r', 'g', 'b', 'a'] });
    }
  });

  it('refuses views, objects standing in for buffers and wrong lengths', () => {
    const view = new Uint8Array(16);
    expect(
      failure(validateAssetToolOutput(imageOutput([image(2, 2, { rgba: view })]), textureTool)),
    ).toMatch(/output-invalid: .*must be an ArrayBuffer/);
    expect(
      failure(
        validateAssetToolOutput(
          imageOutput([image(2, 2, { rgba: { 0: 1, length: 16 } })]),
          textureTool,
        ),
      ),
    ).toMatch(/output-invalid/);
    expect(
      failure(
        validateAssetToolOutput(
          imageOutput([image(2, 2, { rgba: new ArrayBuffer(15) })]),
          textureTool,
        ),
      ),
    ).toMatch(/output-invalid: .*15 bytes/);
    expect(
      failure(validateAssetToolOutput(imageOutput([image(2, 2, { name: '' })]), textureTool)),
    ).toMatch(/name/);
  });

  it('bounds one image to 4 MiB raw, the count to four, and metadata to 64 KiB', () => {
    const atLimit = image(1024, 1024);
    expect((atLimit.rgba as ArrayBuffer).byteLength).toBe(TOOL_LIMITS.imageBytes);
    expect(validateAssetToolOutput(imageOutput([atLimit]), textureTool).ok).toBe(true);
    const over = image(1024, 1025);
    expect(failure(validateAssetToolOutput(imageOutput([over]), textureTool))).toMatch(
      /output-too-large: .*4194304 raw bytes/,
    );
    expect(
      failure(
        validateAssetToolOutput(
          imageOutput(Array.from({ length: 5 }, () => image(1, 1))),
          textureTool,
        ),
      ),
    ).toMatch(/output-too-large: at most 4 images/);
    expect(
      failure(
        validateAssetToolOutput(
          imageOutput([image(1, 1)], { metadata: { note: 'x'.repeat(TOOL_LIMITS.metadataBytes) } }),
          textureTool,
        ),
      ),
    ).toMatch(/output-too-large: metadata/);
    // Four images at the per-image limit are the 16 MiB aggregate, and stay valid.
    const four = Array.from({ length: 4 }, () => image(1024, 1024));
    expect(validateAssetToolOutput(imageOutput(four), textureTool).ok).toBe(true);
  });

  it('refuses buffers smuggled into metadata and unknown fields', () => {
    expect(
      failure(
        validateAssetToolOutput(
          imageOutput([image(1, 1)], { metadata: { raw: new ArrayBuffer(4) } }),
          textureTool,
        ),
      ),
    ).toMatch(/output-invalid: metadata must be a plain JSON object/);
    expect(
      failure(validateAssetToolOutput(imageOutput([image(1, 1)], { files: [] }), textureTool)),
    ).toMatch(/files is not a known field/);
  });

  it('accepts only the kinds the contribution declared, each validated', () => {
    expect(failure(validateAssetToolOutput({ kind: 'palette', palette: {} }, textureTool))).toMatch(
      /does not declare a palette output/,
    );
    expect(failure(validateAssetToolOutput({ kind: 'script' }, textureTool))).toMatch(/kind/);
    expect(failure(validateAssetToolOutput('nope', textureTool))).toMatch(/object/);
    expect(failure(validateAssetToolOutput(imageOutput([image(1, 1)]), paletteTool))).toMatch(
      /does not declare a image output/,
    );
    const palette = { format: PALETTE_FORMAT, name: 'P', colors: ['#000000'] };
    expect(validateAssetToolOutput({ kind: 'palette', palette }, paletteTool).ok).toBe(true);
    expect(
      failure(
        validateAssetToolOutput(
          { kind: 'palette', palette: { ...palette, colors: ['x'] } },
          paletteTool,
        ),
      ),
    ).toMatch(/output-invalid/);
    const effect = {
      name: 'Map',
      source: 'vec4 effect(vec4 c, vec2 uv) { return c; }',
      controls: [],
      values: {},
    };
    expect(validateAssetToolOutput({ kind: 'effect', effect }, paletteTool).ok).toBe(true);
    expect(
      failure(
        validateAssetToolOutput({ kind: 'effect', effect: { ...effect, script: 1 } }, paletteTool),
      ),
    ).toMatch(/script/);
  });
});

// --- Analyzer -----------------------------------------------------------------

describe('analyzer calls', () => {
  const channels = Array.from({ length: 4 }, () => ({
    present: false,
    ext: null,
    width: 0,
    height: 0,
    wrap: 'clamp' as const,
    filter: 'linear' as const,
    flipY: false,
  }));
  const base = () => ({
    profileId: 'studio-webgl2/v1',
    revision: 'fp1:abc',
    name: 'Trails',
    project: feedbackProject(),
    controls: [],
    params: {},
    channels,
    postProcessingActive: false,
  });
  const prepared = () => {
    const result = prepareAnalyzerInput(analyzer, base());
    if (!result.ok) throw new Error(result.errors.join());
    return result.value;
  };
  const report = (findings: unknown[], extra: Record<string, unknown> = {}) => ({
    profile: 'studio-webgl2/v1',
    targetVersion: 1,
    revision: 'fp1:abc',
    checkedRules: ['limits.passes'],
    uncheckedRules: ['glsl.semantics'],
    findings,
    ...extra,
  });
  const finding = (extra: Record<string, unknown> = {}) => ({
    ruleId: 'limits.passes',
    severity: 'warning',
    message: 'Too many passes for this target.',
    confidence: 'certain',
    coverage: 'structural',
    targetVersion: 1,
    ...extra,
  });

  it('sends a host-selected profile and a copy of the snapshot', () => {
    const request = base();
    const input = prepareAnalyzerInput(analyzer, request);
    if (!input.ok) throw new Error(input.errors.join());
    expect(input.value.profile).toEqual(CAPABILITY_PROFILES['studio-webgl2/v1']);
    request.project.passes[0]!.source = 'mutated after the call';
    expect(input.value.project.passes[0]!.source).not.toBe('mutated after the call');
  });

  it('refuses an unregistered or undeclared profile, a bad revision and an oversize snapshot', () => {
    expect(failure(prepareAnalyzerInput(analyzer, { ...base(), profileId: 'webgpu/v1' }))).toMatch(
      /not registered/,
    );
    expect(
      failure(prepareAnalyzerInput({ ...analyzer, profiles: ['wallpaper-web/v1'] }, base())),
    ).toMatch(/no rules for studio-webgl2\/v1/);
    expect(failure(prepareAnalyzerInput(analyzer, { ...base(), revision: '' }))).toMatch(
      /revision/,
    );
    const huge = base();
    huge.project.vertex = 'x'.repeat(TOOL_LIMITS.analyzerInputBytes);
    expect(failure(prepareAnalyzerInput(analyzer, huge))).toMatch(/input-too-large/);
    const cyclic = base();
    (cyclic.project.files[0] as unknown as Record<string, unknown>)['self'] = cyclic.project;
    expect(failure(prepareAnalyzerInput(analyzer, cyclic))).toMatch(/input-invalid/);
  });

  it('validates findings and their locations against the snapshot it was sent', () => {
    const input = prepared();
    const located = (location: unknown) =>
      failure(validateAnalyzerReport(report([finding({ location })]), input));
    // trail has three lines ("void main() {}", "// two", "// three").
    expect(located({ kind: 'pass', id: 'trail', line: 3, column: 9 })).toBe('ok');
    expect(located({ kind: 'pass', id: 'trail', line: 4 })).toMatch(/outside the document \(1–3\)/);
    expect(located({ kind: 'pass', id: 'trail', line: 0 })).toMatch(/outside the document/);
    expect(located({ kind: 'pass', id: 'trail', line: 1.5 })).toMatch(/outside the document/);
    expect(located({ kind: 'pass', id: 'trail', line: 2, column: 99 })).toMatch(/column 99/);
    expect(located({ kind: 'pass', id: 'ghost', line: 1 })).toMatch(/not in the project/);
    expect(located({ kind: 'file', id: 'shared', line: 1 })).toBe('ok');
    expect(located({ kind: 'file', id: 'trail', line: 1 })).toMatch(/not in the project/);
    expect(located({ kind: 'vertex', line: 1, column: 1 })).toBe('ok');
    expect(located({ kind: 'vertex', line: 1, id: 'main' })).toMatch(/only line and column/);
    expect(located({ kind: 'shader', line: 1 })).toMatch(/kind must be/);
    // A structural finding names the binding instead of inventing a line.
    expect(located({ kind: 'binding', passId: 'trail', channel: 0 })).toBe('ok');
    expect(located({ kind: 'binding', passId: 'trail', channel: 4 })).toMatch(/0–3/);
    expect(located({ kind: 'binding', passId: 'ghost', channel: 0 })).toMatch(/not in the project/);
    expect(located({ kind: 'binding', passId: 'trail', channel: 0, line: 2 })).toMatch(
      /only passId/,
    );
    // A project-level finding has no location at all.
    expect(failure(validateAnalyzerReport(report([finding()]), input))).toBe('ok');
  });

  it('refuses another revision, profile or version, malformed findings and too many of them', () => {
    const input = prepared();
    const bad = (value: unknown) => failure(validateAnalyzerReport(value, input));
    expect(bad(report([], { revision: 'fp1:other' }))).toMatch(/another source revision/);
    expect(bad(report([], { profile: 'wallpaper-web/v1' }))).toMatch(/another capability profile/);
    expect(bad(report([], { targetVersion: 2 }))).toMatch(/another target version/);
    expect(bad(report([finding({ targetVersion: 2 })]))).toMatch(/targetVersion/);
    expect(bad(report([finding({ severity: 'fatal' })]))).toMatch(/severity/);
    expect(bad(report([finding({ coverage: 'partial' })]))).toMatch(/coverage/);
    expect(bad(report([finding({ ruleId: 'Bad Rule' })]))).toMatch(/ruleId/);
    expect(bad(report([finding({ message: '' })]))).toMatch(/message/);
    expect(bad(report([finding({ message: 'x'.repeat(301) })]))).toMatch(/message/);
    expect(bad(report([finding({ fix: 'rm -rf' })]))).toMatch(/fix is not a known field/);
    expect(bad(report([], { extra: 1 }))).toMatch(/extra is not a known field/);
    expect(bad(report([], { checkedRules: ['limits.passes', 'limits.passes'] }))).toMatch(
      /repeats/,
    );
    expect(bad('nope')).toMatch(/object/);
    const exactly = Array.from({ length: TOOL_LIMITS.findings }, () => finding());
    expect(bad(report(exactly))).toBe('ok');
    expect(bad(report([...exactly, finding()]))).toMatch(/output-too-large: .*at most 100/);
  });

  it('keeps the severity, confidence and coverage a report states', () => {
    const input = prepared();
    const result = validateAnalyzerReport(
      report([
        finding({ severity: 'error', coverage: 'checked' }),
        finding({
          ruleId: 'glsl.semantics',
          severity: 'info',
          coverage: 'unchecked',
          confidence: 'possible',
        }),
      ]),
      input,
    );
    if (!result.ok) throw new Error(result.errors.join());
    expect(result.value.findings.map((f) => [f.severity, f.coverage, f.confidence])).toEqual([
      ['error', 'checked', 'certain'],
      ['info', 'unchecked', 'possible'],
    ]);
    expect(result.value.uncheckedRules).toEqual(['glsl.semantics']);
  });
});

// --- Fingerprint --------------------------------------------------------------

describe('sourceFingerprint', () => {
  it('is stable across key order and changes with any content', () => {
    const a = sourceFingerprint({ x: 1, y: [1, 2, { z: 'q' }] });
    expect(sourceFingerprint({ y: [1, 2, { z: 'q' }], x: 1 })).toBe(a);
    expect(a).toMatch(/^fp1:[0-9a-f]{16}$/);
    for (const other of [
      { x: 2, y: [1, 2, { z: 'q' }] },
      { x: 1, y: [2, 1, { z: 'q' }] },
      { x: 1, y: [1, 2, { z: 'r' }] },
      { x: 1, y: [1, 2, { z: 'q' }], w: null },
    ]) {
      expect(sourceFingerprint(other)).not.toBe(a);
    }
    expect(sourceFingerprint(feedbackProject())).toBe(sourceFingerprint(feedbackProject()));
  });
});

// --- Compatibility ------------------------------------------------------------

describe('limits shared with earlier protocols', () => {
  it('keeps the existing package, code and Worker time limits', () => {
    expect(PLUGIN_LIMITS.packageBytes).toBe(1024 * 1024);
    expect(PLUGIN_LIMITS.callTimeoutMs).toBe(10_000);
    expect(parsePluginPackage('{"manifest":1}').ok).toBe(false);
    expect(TOOL_LIMITS.outputBytes).toBeGreaterThan(TOOL_LIMITS.outputPixelBytes);
  });
});
