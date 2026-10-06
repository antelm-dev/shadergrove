// Exercises the real glslang front end compiled to WASM (dist/), not a mock.
import { beforeAll, describe, expect, it } from 'vitest';
import type { AnalysisDiagnostic, EsslVersion, GlobalSymbol, GlslStage } from '../src/contract';
import type { JobOutcome } from '../src/native-reply';
import { RuntimeFatalError, type GlslangRuntime } from '../src/worker/runtime';
import { createFrontend, job, readCorpus, readManifest } from './support/frontend';

let frontend: GlslangRuntime;

beforeAll(async () => {
  frontend = await createFrontend();
});

function analyze(source: string, stage: GlslStage, version: EsslVersion): JobOutcome {
  return frontend.analyze(job(source, stage, version));
}

function ok(outcome: JobOutcome) {
  if (outcome.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(outcome)}`);
  return outcome;
}

function errors(outcome: JobOutcome): AnalysisDiagnostic[] {
  expect(outcome.status).toBe('invalid-source');
  expect(outcome).not.toHaveProperty('symbols');
  return outcome.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
}

const byName = (globals: readonly GlobalSymbol[], name: string | null) => {
  const found = globals.find((global) => global.name === name);
  if (!found) throw new Error(`missing global ${name}`);
  return found;
};

/** A source that expands to ~10^5 constant nodes from a few hundred bytes. */
function wideExpansion(levels: number): string {
  const lines = ['#version 300 es', 'precision highp float;', 'out vec4 c;', '#define E0 1.0'];
  for (let level = 1; level <= levels; level++) {
    lines.push(
      `#define E${level} ${Array(10)
        .fill(`E${level - 1}`)
        .join(',')}`,
    );
  }
  lines.push(`const float big[] = float[](E${levels});`, 'void main() { c = vec4(big[0]); }');
  return lines.join('\n');
}

describe('build provenance', () => {
  it('runs the pinned glslang commit', async () => {
    const manifest = await readManifest();
    expect(frontend.info.glslangCommit).toBe(manifest.glslang.commit);
    expect(frontend.info.glslangVersion).toBe(manifest.glslang.version);
  });
});

describe('valid ESSL corpus', () => {
  it.each([
    ['essl100-shadergrove.frag', 'fragment', 100],
    ['essl100-three-prefix.vert', 'vertex', 100],
    ['essl300-webgl2.frag', 'fragment', 300],
    ['essl300-webgl2.vert', 'vertex', 300],
  ] as const)('%s analyses cleanly', async (name, stage, version) => {
    const outcome = ok(analyze(await readCorpus(name), stage, version));
    expect(outcome.diagnostics).toEqual([]);
    expect(outcome.symbols.truncated).toBe(false);
  });

  it('reports ESSL 1.00 fragment globals with typed, source-spelled qualifiers', async () => {
    const { symbols } = ok(analyze(await readCorpus('essl100-shadergrove.frag'), 'fragment', 100));
    expect(symbols.globals.map((global) => global.name)).toEqual([
      'iResolution',
      'iTime',
      'iMouse',
      'u_clickData',
      'u_noise',
      'u_timeScale',
      'u_colorCell',
      'u_invert',
      'u_steps',
      'vUv',
      'C_MAX_WAVES',
      'HEX',
    ]);
    expect(byName(symbols.globals, 'u_clickData')).toMatchObject({
      kind: 'uniform',
      qualifier: 'uniform',
      type: { text: 'highp vec3[8]', base: 'vec3', precision: 'highp', arraySizes: [8] },
      declaration: null,
    });
    expect(byName(symbols.globals, 'u_noise').type).toMatchObject({ base: 'sampler2D' });
    expect(byName(symbols.globals, 'u_invert').type).toMatchObject({
      base: 'bool',
      precision: null,
    });
    expect(byName(symbols.globals, 'vUv')).toMatchObject({ kind: 'input', qualifier: 'varying' });
    expect(byName(symbols.globals, 'C_MAX_WAVES')).toMatchObject({
      kind: 'const',
      qualifier: 'const',
    });
  });

  it('reports ESSL 1.00 vertex attributes and varyings', async () => {
    const { symbols } = ok(analyze(await readCorpus('essl100-three-prefix.vert'), 'vertex', 100));
    expect(byName(symbols.globals, 'position')).toMatchObject({
      kind: 'input',
      qualifier: 'attribute',
    });
    expect(byName(symbols.globals, 'vUv')).toMatchObject({ kind: 'output', qualifier: 'varying' });
    expect(byName(symbols.globals, 'normalMatrix').type.base).toBe('mat3');
    // Built-in linkage objects (gl_VertexID, gl_InstanceID) are never user symbols.
    expect(symbols.globals.some((global) => global.name?.startsWith('gl_'))).toBe(false);
  });

  it('accepts free uniforms in ESSL 3.00 and describes blocks, outputs and arrays', async () => {
    const { symbols } = ok(analyze(await readCorpus('essl300-webgl2.frag'), 'fragment', 300));
    expect(byName(symbols.globals, 'iTime')).toMatchObject({
      kind: 'uniform',
      qualifier: 'uniform',
    });
    expect(byName(symbols.globals, 'pc_fragColor')).toMatchObject({
      kind: 'output',
      qualifier: 'out',
      layoutLocation: 0,
    });
    const lights = byName(symbols.globals, 'lights');
    expect(lights.kind).toBe('uniform-block');
    expect(lights.type.base).toBe('Lights');
    expect(lights.type.members?.map((member) => [member.name, member.type.text])).toEqual([
      ['positions', 'highp vec4[2]'],
      ['colors', 'highp vec4[2]'],
    ]);
    // Anonymous block: no instance name, members are globals.
    const anonymous = byName(symbols.globals, null);
    expect(anonymous.type.members?.map((member) => member.name)).toEqual(['exposure']);
    expect(byName(symbols.globals, 'WEIGHTS').type.arraySizes).toEqual([3]);
    expect(byName(symbols.globals, 'g_accumulated')).toMatchObject({
      kind: 'global',
      qualifier: '',
    });
    expect(byName(symbols.globals, 'u_warp').type.base).toBe('mat3');
  });

  it('reports user-function signatures, overloads and parameter qualifiers', async () => {
    const { symbols } = ok(analyze(await readCorpus('essl300-webgl2.frag'), 'fragment', 300));
    const saturate = symbols.functions.filter((fn) => fn.name === 'saturate');
    expect(saturate.map((fn) => fn.signature)).toEqual([
      'highp float saturate(highp float x)',
      'highp vec3 saturate(highp vec3 x)',
    ]);
    expect(saturate.every((fn) => fn.overloadCount === 2)).toBe(true);
    const accumulate = symbols.functions.find((fn) => fn.name === 'accumulate');
    expect(accumulate?.signature).toBe(
      'void accumulate(highp vec3 sampleColor, inout highp vec3 total, out highp float weight)',
    );
    expect(accumulate?.parameters.map((parameter) => parameter.qualifier)).toEqual([
      'in',
      'inout',
      'out',
    ]);
    // glslang attaches the definition to the end of its prototype: line exact,
    // column at the closing parenthesis.
    expect(accumulate?.definition).toMatchObject({ sourceString: '0', line: 35 });
    expect(symbols.functions.map((fn) => fn.name)).toContain('main');
  });

  it('excludes prototypes without a definition', () => {
    const { symbols } = ok(
      analyze(
        'float g(float);\nfloat h(float);\nfloat g(float x) { return x; }\nvoid main() { gl_Position = vec4(g(1.0)); }',
        'vertex',
        100,
      ),
    );
    expect(symbols.functions.map((fn) => fn.name)).toEqual(['g', 'main']);
  });

  it('honours preprocessor conditionals and keeps warnings on success', () => {
    expect(analyze('#if 0\nthis is not glsl\n#endif\nvoid main() {}', 'vertex', 100).status).toBe(
      'ok',
    );
    const outcome = ok(
      analyze(
        '#version 300 es\n#extension GL_EXT_nonexistent : warn\nvoid main() {}',
        'vertex',
        300,
      ),
    );
    expect(outcome.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        token: '#extension',
        location: expect.objectContaining({ line: 2 }),
      }),
    ]);
  });
});

describe('invalid ESSL', () => {
  it('locates an undeclared identifier with 1-based line and UTF-16 column', () => {
    const [error] = errors(
      analyze(
        'precision mediump float;\nuniform float u;\nvoid main() {\n  float x = missing + u;\n  gl_FragColor = vec4(x);\n}',
        'fragment',
        100,
      ),
    );
    expect(error).toEqual({
      severity: 'error',
      phase: 'compile',
      message: 'undeclared identifier',
      token: 'missing',
      location: { sourceString: '0', line: 4, column: 13, byteColumn: 13 },
    });
  });

  it('converts byte columns after non-ASCII text to UTF-16 columns', () => {
    const [error] = errors(analyze('void main() { /* é😀 */ float y = nope; }', 'vertex', 100));
    expect(error?.location).toEqual({ sourceString: '0', line: 1, column: 35, byteColumn: 38 });
  });

  it('refuses UTF-16 columns when #line remaps the source', () => {
    const [error] = errors(analyze('#line 10 3\nvoid main() { float y = nope; }', 'vertex', 100));
    expect(error?.location).toMatchObject({ sourceString: '3', line: 10, column: null });
  });

  it('reports type errors', () => {
    const [error] = errors(
      analyze(
        'precision mediump float;\nvoid main() { float a = vec2(1.0); gl_FragColor = vec4(a); }',
        'fragment',
        100,
      ),
    );
    expect(error?.message).toMatch(/cannot convert/);
  });

  it('requires a float precision in ESSL 1.00 fragment shaders', () => {
    const [error] = errors(
      analyze('void main() { float a = 1.0; gl_FragColor = vec4(a); }', 'fragment', 100),
    );
    expect(error?.message).toMatch(/precision/i);
  });

  it('applies stage-specific built-ins', () => {
    expect(
      errors(analyze('void main() { gl_FragColor = vec4(1.0); }', 'vertex', 100))[0]?.token,
    ).toBe('gl_FragColor');
    expect(
      errors(
        analyze(
          'precision mediump float;\nvoid main() { gl_Position = vec4(1.0); }',
          'fragment',
          100,
        ),
      )[0]?.token,
    ).toBe('gl_Position');
  });

  it('reports link-time errors without a location', () => {
    const [missingMain] = errors(
      analyze('#version 300 es\nprecision highp float;\nout vec4 c;\n', 'fragment', 300),
    );
    expect(missingMain).toMatchObject({ phase: 'link', location: null });
    expect(missingMain?.message).toMatch(/Missing entry point/);
    const [recursion] = errors(
      analyze(
        'precision mediump float;\nfloat f(float x) { return f(x); }\nvoid main() { gl_FragColor = vec4(f(1.0)); }',
        'fragment',
        100,
      ),
    );
    expect(recursion).toMatchObject({ phase: 'link', location: null });
    expect(recursion?.message).toMatch(/^Recursion detected/);
  });

  it('reports #error and forbidden ESSL token pasting', () => {
    expect(
      errors(analyze('#error custom failure\nvoid main() {}', 'vertex', 100))[0],
    ).toMatchObject({
      token: '#error',
      message: 'custom failure',
    });
    expect(errors(analyze('#define P(a) a##1\nvoid main() {}', 'vertex', 100))[0]?.message).toMatch(
      /not supported with this profile: es/,
    );
  });

  it('applies ESSL rules, not Vulkan or SPIR-V rules', () => {
    // A Vulkan target would reject this free uniform; ESSL 3.00 accepts it.
    ok(
      analyze(
        '#version 300 es\nprecision mediump float;\nuniform float u;\nout vec4 c;\nvoid main() { c = vec4(u); }',
        'fragment',
        300,
      ),
    );
    // layout(binding) is ESSL 3.10+, so 3.00 rejects it.
    expect(
      errors(
        analyze(
          '#version 300 es\nprecision mediump float;\nlayout(binding = 0) uniform sampler2D t;\nout vec4 c;\nvoid main() { c = texture(t, vec2(0)); }',
          'fragment',
          300,
        ),
      )[0]?.token,
    ).toBe('binding');
  });
});

describe('malformed and incomplete sources', () => {
  it.each([
    ['missing closing brace', 'void main() {\n  gl_Position = vec4(0.0);\n'],
    ['ends inside a call', 'void main() {\n  float a = foo('],
    ['unterminated comment', 'void main() { /* never closed'],
    ['embedded NUL', 'void main() {}\0garbage'],
    ['binary noise', '\u0001\u0002ÿ void ) ( }'],
  ])('%s yields diagnostics and no symbols', (_name, source) => {
    const found = errors(analyze(source, 'vertex', 100));
    expect(found.length).toBeGreaterThan(0);
  });

  it('reports end-of-input without inventing a column', () => {
    const [error] = errors(analyze('void main() {\n  gl_Position = vec4(0.0);\n', 'vertex', 100));
    expect(error?.location).toMatchObject({ line: 3, column: null, byteColumn: null });
  });

  it('treats an empty source as a missing entry point', () => {
    expect(errors(analyze('', 'fragment', 100))[0]?.message).toMatch(/Missing entry point/);
  });

  it('reports parser exhaustion on extreme nesting as a diagnostic, not a trap', () => {
    const depth = 20_000;
    const source = `precision highp float;\nvoid main() { float a = ${'('.repeat(depth)}1.0${')'.repeat(depth)}; gl_FragColor = vec4(a); }`;
    expect(errors(analyze(source, 'fragment', 100))[0]?.message).toBe('memory exhausted');
    expect(frontend.usable).toBe(true);
  });
});

describe('profiles', () => {
  it.each([
    ['#version 330\nvoid main() {}', 300, { version: 330, profile: 'core' }],
    ['#version 310 es\nvoid main() {}', 300, { version: 310, profile: 'es' }],
    ['#version 300 es\nvoid main() {}', 100, { version: 300, profile: 'es' }],
    ['void main() {}', 300, { version: 100, profile: 'es' }],
  ] as const)('reports %j requested as %i as unsupported-profile', (source, version, detected) => {
    const outcome = analyze(source, 'vertex', version);
    expect(outcome).toMatchObject({ status: 'unsupported-profile', detected });
    expect(outcome).not.toHaveProperty('symbols');
  });
});

describe('native resources', () => {
  it('releases every per-request allocation', async () => {
    const corpus = [
      [await readCorpus('essl100-shadergrove.frag'), 'fragment', 100],
      [await readCorpus('essl100-three-prefix.vert'), 'vertex', 100],
      [await readCorpus('essl300-webgl2.frag'), 'fragment', 300],
      [await readCorpus('essl300-webgl2.vert'), 'vertex', 300],
      ['void main() { broken', 'vertex', 100],
    ] as const;
    for (const [source, stage, version] of corpus) analyze(source, stage, version);
    const before = frontend.heapBytes();
    for (let round = 0; round < 25; round++) {
      for (const [source, stage, version] of corpus) analyze(source, stage, version);
    }
    expect(frontend.heapBytes()).toBe(before);
  });

  it('fails a request that exceeds the memory ceiling and recovers in a fresh runtime', async () => {
    const limited = await createFrontend(40 * 1024 * 1024);
    let failure: unknown;
    try {
      limited.analyze(job(wideExpansion(5), 'fragment', 300));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RuntimeFatalError);
    expect((failure as RuntimeFatalError).reason).toBe('memory-limit');
    expect(limited.usable).toBe(false);
    expect(() => limited.analyze(job('void main() {}', 'vertex', 100))).toThrow(RuntimeFatalError);

    // The same source succeeds under the default ceiling; memory grows but is bounded.
    const fresh = await createFrontend();
    expect(fresh.analyze(job(wideExpansion(5), 'fragment', 300)).status).toBe('ok');
    expect(fresh.memoryBytes()).toBeLessThanOrEqual(256 * 1024 * 1024);
  });

  it('rejects invalid or below-floor ceilings instead of raising them', async () => {
    const { initialBytes } = (await readManifest()).memory;
    for (const bad of [
      initialBytes - 65_536,
      16 * 1024 * 1024,
      0,
      -65_536,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      initialBytes + 1,
    ]) {
      await expect(createFrontend(bad)).rejects.toThrow(RangeError);
    }
  });

  it('accepts an exact-floor ceiling without growing past it, and larger ceilings grow', async () => {
    const { initialBytes } = (await readManifest()).memory;
    const exact = await createFrontend(initialBytes);
    expect(exact.memoryBytes()).toBe(initialBytes);
    expect(exact.analyze(job('void main() {}', 'vertex', 100)).status).toBe('ok');
    expect(exact.memoryBytes()).toBe(initialBytes);
    expect(() => exact.analyze(job(wideExpansion(5), 'fragment', 300))).toThrow(RuntimeFatalError);
    expect(exact.memoryBytes()).toBeLessThanOrEqual(initialBytes);

    const grown = await createFrontend(256 * 1024 * 1024);
    expect(grown.analyze(job(wideExpansion(5), 'fragment', 300)).status).toBe('ok');
    expect(grown.memoryBytes()).toBeGreaterThan(initialBytes);
  });
});
