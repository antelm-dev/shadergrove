import { describe, expect, it } from 'vitest';

import { LIMITS } from '../validate/limits';
import {
  PLUGIN_LIMITS,
  effectContributionCandidate,
  validateEffectCandidate,
  isPluginCompatible,
  parsePluginPackage,
  validatePluginPackage,
} from './package';

const importer = {
  kind: 'importer',
  id: 'isf-import',
  name: 'ISF',
  mime: [],
  extensions: ['.fs'],
  maxInputBytes: 1000,
  maxOutputBytes: 1000,
  params: [{ key: 'gain', type: 'number', default: 1, min: 0, max: 2 }],
};
const effect = {
  kind: 'effect',
  id: 'tint',
  name: 'Tint',
  controls: [{ key: 'amount', type: 'number', default: 0.5, min: 0, max: 1 }],
};

function pkg(overrides: Record<string, unknown> = {}, manifest: Record<string, unknown> = {}) {
  return {
    manifest: {
      id: 'dev.example.pack',
      version: '1.0.0',
      protocolVersion: 1,
      appVersionRange: '>=1.4.0 <2.0.0',
      name: 'Pack',
      publisher: 'Example',
      license: 'MIT',
      contributions: [effect, importer],
      ...manifest,
    },
    code: 'shaderStudio.handle("importer:isf-import", () => ({ candidate: {} }));',
    glsl: { tint: 'vec4 effect(vec4 c, vec2 uv) { return c; }' },
    ...overrides,
  };
}

const errors = (input: unknown) => {
  const result = validatePluginPackage(input);
  return result.ok ? [] : result.errors;
};

describe('validatePluginPackage', () => {
  it('accepts a valid package', () => {
    const result = validatePluginPackage(pkg());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.glsl['tint']).toContain('effect');
  });

  it('accepts a declarative effect without code', () => {
    const { code: _code, ...noCode } = pkg({}, { contributions: [effect] });
    expect(validatePluginPackage(noCode).ok).toBe(true);
  });

  it('rejects an unknown kind, protocol version and field before activation', () => {
    expect(errors(pkg({}, { contributions: [{ ...effect, kind: 'macro' }] }))[0]).toMatch(
      /kind "macro"/,
    );
    expect(errors(pkg({}, { protocolVersion: 5 }))[0]).toMatch(
      /protocolVersion 5 is not supported/,
    );
    expect(errors(pkg({}, { scripts: { postinstall: 'x' } }))[0]).toMatch(/scripts/);
    expect(errors(pkg({ assets: [] }))[0]).toMatch(/assets/);
    expect(errors(pkg({}, { contributions: [{ ...importer, url: 'https://x' }] }))[0]).toMatch(
      /url/,
    );
  });

  it('rejects duplicate ids, bad MIME/extension and missing or surplus code and GLSL', () => {
    expect(errors(pkg({}, { contributions: [effect, effect] }))[0]).toMatch(/duplicated/);
    expect(
      errors(
        pkg({}, { contributions: [{ ...importer, mime: ['Text/Plain'], extensions: [] }] }),
      )[0],
    ).toMatch(/mime/);
    expect(errors(pkg({}, { contributions: [{ ...importer, extensions: ['fs'] }] }))[0]).toMatch(
      /extensions/,
    );
    expect(errors(pkg({}, { contributions: [{ ...importer, extensions: [] }] }))[0]).toMatch(
      /at least one/,
    );
    expect(errors(pkg({ code: undefined }))[0]).toMatch(/code is required/);
    expect(errors(pkg({ glsl: {} }))[0]).toMatch(/glsl\["tint"\]/);
    expect(errors(pkg({ glsl: { tint: 'x', other: 'y' } }))[0]).toMatch(/other/);
  });

  it('rejects invalid params, too many controls and out-of-range bounds', () => {
    const bad = { ...importer, params: [{ key: 'a', type: 'number', default: 5, min: 0, max: 1 }] };
    expect(errors(pkg({}, { contributions: [bad] }))[0]).toMatch(/params/);
    const many = Array.from({ length: PLUGIN_LIMITS.effectControls + 1 }, (_, i) => ({
      key: `c${i}`,
      type: 'boolean',
      default: false,
    }));
    expect(errors(pkg({}, { contributions: [{ ...effect, controls: many }] }))[0]).toMatch(
      /at most 16/,
    );
    const huge = { ...importer, maxInputBytes: PLUGIN_LIMITS.fileBytes + 1 };
    expect(errors(pkg({}, { contributions: [huge] }))[0]).toMatch(/maxInputBytes/);
  });

  it('rejects oversize manifest, code and GLSL', () => {
    expect(errors(pkg({}, { name: 'x'.repeat(PLUGIN_LIMITS.manifestBytes) }))[0]).toMatch(
      /manifest/,
    );
    expect(errors(pkg({ code: 'x'.repeat(PLUGIN_LIMITS.codeBytes + 1) }))[0]).toMatch(/code/);
    expect(errors(pkg({ glsl: { tint: 'x'.repeat(PLUGIN_LIMITS.glslBytes + 1) } }))[0]).toMatch(
      /glsl/,
    );
  });
});

describe('parsePluginPackage', () => {
  it('refuses an oversize file before parsing it', () => {
    const big = new Uint8Array(PLUGIN_LIMITS.packageBytes + 1);
    expect(parsePluginPackage(big)).toEqual({
      ok: false,
      errors: [expect.stringMatching(/at most/)],
    });
  });

  it('refuses non-JSON and invalid UTF-8', () => {
    expect(parsePluginPackage('{nope').ok).toBe(false);
    expect(parsePluginPackage(new Uint8Array([0xff, 0xfe])).ok).toBe(false);
  });

  it('reads UTF-8 bytes', () => {
    const bytes = new TextEncoder().encode(JSON.stringify(pkg()));
    expect(parsePluginPackage(bytes).ok).toBe(true);
  });
});

describe('isPluginCompatible', () => {
  const manifest = (range: string) => ({ ...pkg().manifest, appVersionRange: range }) as never;

  it('checks every comparator, independent of the protocol version', () => {
    expect(isPluginCompatible(manifest('>=1.4.0 <2.0.0'), '1.4.0')).toBe(true);
    expect(isPluginCompatible(manifest('>=1.4.0 <2.0.0'), '2.0.0')).toBe(false);
    expect(isPluginCompatible(manifest('>=1.5.0'), '1.4.9')).toBe(false);
    expect(isPluginCompatible(manifest('1.4.0'), '1.4.0')).toBe(true);
    expect(isPluginCompatible(manifest('>=1.4.0'), 'garbage')).toBe(false);
  });

  it('treats a beta as the release it leads to', () => {
    expect(isPluginCompatible(manifest('>=2.0.0'), '2.0.0-beta.1')).toBe(true);
    expect(isPluginCompatible(manifest('>=1.5.0 <2.0.0'), '2.0.0-beta.1')).toBe(false);
  });
});

describe('validateEffectCandidate', () => {
  const candidate = {
    name: '  Gain ',
    source: 'vec4 effect(vec4 c, vec2 uv) { return c * u_gain; }',
    controls: [{ key: 'gain', type: 'number', default: 1, min: 0, max: 2 }],
    values: { gain: 9, rogue: 1 },
  };

  it('accepts a candidate, trimming its name and sanitizing its values', () => {
    expect(validateEffectCandidate(candidate)).toEqual({
      ok: true,
      value: { ...candidate, name: 'Gain', values: { gain: 2 } },
    });
  });

  it('refuses what a saved custom effect would refuse', () => {
    const errorOf = (input: unknown) => {
      const result = validateEffectCandidate(input);
      return result.ok ? '' : result.errors.join();
    };
    expect(errorOf({ ...candidate, source: '' })).toMatch(/source/);
    expect(
      errorOf({ ...candidate, source: 'x'.repeat(LIMITS.customEffectSourceLength + 1) }),
    ).toMatch(/at most/);
    expect(
      errorOf({ ...candidate, controls: [{ key: 'time', type: 'boolean', default: true }] }),
    ).toMatch(/reserved/);
    expect(errorOf({ ...candidate, script: 'x' })).toMatch(/script/);
    expect(errorOf('nope')).toMatch(/object/);
  });

  it('turns an effect contribution into a candidate with default values', () => {
    const parsed = validatePluginPackage(pkg());
    if (!parsed.ok) throw new Error(parsed.errors.join());
    const contribution = parsed.value.manifest.contributions[0]!;
    if (contribution.kind !== 'effect') throw new Error('expected the effect');
    expect(effectContributionCandidate(parsed.value, contribution)).toEqual({
      name: 'Tint',
      source: 'vec4 effect(vec4 c, vec2 uv) { return c; }',
      controls: effect.controls,
      values: { amount: 0.5 },
    });
  });
});
