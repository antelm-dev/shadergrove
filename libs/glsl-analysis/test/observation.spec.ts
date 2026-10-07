// Real glslang (dist/) catalogue and insertion-contract tests; no compiler mock.
import { beforeAll, describe, expect, it } from 'vitest';
import type {
  EsslVersion,
  GlslStage,
  ObservationCatalogue,
  ObservationPoint,
} from '../src/contract';
import type { JobOutcome } from '../src/native-reply';
import {
  applyObservationEdits,
  mapOriginalOffset,
  MAX_OBSERVATION_POINTS,
  planObservationInsertion,
  sourceIdentity,
} from '../src/observation';
import type { GlslangRuntime } from '../src/worker/runtime';
import { createFrontend, job } from './support/frontend';

let frontend: GlslangRuntime;
beforeAll(async () => {
  frontend = await createFrontend();
});

function observe(
  source: string,
  stage: GlslStage = 'fragment',
  version: EsslVersion = 300,
): ObservationCatalogue {
  const outcome: JobOutcome = frontend.analyze({ ...job(source, stage, version), observe: true });
  if (outcome.status !== 'ok' || !outcome.observation) {
    throw new Error(`expected an observation, got ${JSON.stringify(outcome).slice(0, 400)}`);
  }
  return outcome.observation;
}

const named = (catalogue: ObservationCatalogue, name: string): ObservationPoint[] =>
  catalogue.points.filter((point) => point.name === name);
const reasons = (catalogue: ObservationCatalogue) => catalogue.refusals.map((r) => r.reason);

const BASIC = [
  '#version 300 es',
  'precision highp float;',
  'out vec4 o;',
  'uniform float u;',
  'void main() {',
  '  float a = u * 2.0;',
  '  mediump vec3 v = vec3(a);',
  '  lowp float w = 0.5;',
  '  for (int i = 0; i < 4; i++) {',
  '    float t = float(i) * a;',
  '    a = a + t;',
  '  }',
  '  o = vec4(v, a + w);',
  '}',
  '',
].join('\n');

describe('typed point catalogue', () => {
  it('reports scalar/vector points with effective precision and exact UTF-16 spans', () => {
    const catalogue = observe(BASIC);
    expect(catalogue.truncated).toBe(false);
    const [v] = named(catalogue, 'v');
    expect(v).toMatchObject({
      kind: 'initialized-declaration',
      type: 'vec3',
      precision: 'mediump',
      function: 'main',
      scope: { loopDepth: 0, path: [0] },
      maxVisits: 128,
    });
    expect(named(catalogue, 'w')[0]).toMatchObject({ type: 'float', precision: 'lowp' });
    // A point with no written precision gets the effective (default) one.
    expect(named(catalogue, 'a')[0]).toMatchObject({
      kind: 'initialized-declaration',
      precision: 'highp',
    });

    for (const point of catalogue.points) {
      const { span } = point;
      expect(BASIC.slice(span.name.start, span.name.end)).toBe(point.name);
      expect(BASIC.slice(span.operator.start, span.operator.end)).toBe('=');
      expect(BASIC[span.insertAt - 1]).toBe(';');
      expect(span.insertAt).toBe(span.statement.end);
      expect(BASIC.slice(span.functionStart, span.functionStart + 4)).toBe('void');
    }
  });

  it('distinguishes the braced for-body point and an assignment from its declaration', () => {
    const catalogue = observe(BASIC);
    const [t] = named(catalogue, 't');
    expect(t).toMatchObject({
      kind: 'initialized-declaration',
      scope: { loopDepth: 1, path: [0, 1] },
    });
    const assignment = named(catalogue, 'a').find((point) => point.kind === 'assignment');
    expect(assignment?.scope.loopDepth).toBe(1);
    expect(assignment?.symbolId).toBe(named(catalogue, 'a')[0]?.symbolId);
    // The loop counter is a for-header declaration: not a block statement.
    expect(named(catalogue, 'i')).toEqual([]);
    expect(new Set(catalogue.points.map((point) => point.id)).size).toBe(catalogue.points.length);
  });

  it('refuses a shadowed name instead of guessing which symbol is meant', () => {
    const source = [
      '#version 300 es',
      'precision highp float;',
      'out vec4 o;',
      'void main() {',
      '  float a = 1.0;',
      '  float b = 2.0;',
      '  {',
      '    float a = 3.0;',
      '    o = vec4(a);',
      '  }',
      '  o = vec4(a + b);',
      '}',
    ].join('\n');
    const catalogue = observe(source);
    expect(named(catalogue, 'a')).toEqual([]);
    expect(named(catalogue, 'b')).toHaveLength(1);
    expect(reasons(catalogue).filter((reason) => reason === 'ambiguous-name')).toHaveLength(2);
  });

  it('keeps UTF-16 offsets exact across comments, non-BMP text and CRLF', () => {
    const source = [
      '#version 300 es',
      '// ünïcode 😀 comment with float fake = 1.0;',
      'precision highp float;',
      'out vec4 o;',
      '/* block 😀',
      '   float fake2 = 2.0; */',
      'void main() { /* 😀 */ float é = 1.0; float ok = 2.0; /* 😀😀 */ float last = ok; o = vec4(last); }',
    ].join('\r\n');
    // `é` is not a valid GLSL identifier: the compiler rejects the source, so no catalogue.
    const invalid = frontend.analyze({ ...job(source, 'fragment', 300), observe: true });
    expect(invalid.status).toBe('invalid-source');
    expect(invalid).not.toHaveProperty('observation');

    const fixed = source.replace('é', 'e');
    const catalogue = observe(fixed);
    expect(catalogue.points.map((point) => point.name)).toEqual(['e', 'ok', 'last']);
    for (const point of catalogue.points) {
      expect(fixed.slice(point.span.name.start, point.span.name.end)).toBe(point.name);
      expect(fixed.slice(point.span.operator.start, point.span.operator.end)).toBe('=');
      expect(point.compilerLocation.line).toBe(7);
    }
    // Columns after non-ASCII text differ between UTF-8 bytes and UTF-16 units.
    const last = named(catalogue, 'last')[0] as ObservationPoint;
    expect(last.compilerLocation.byteColumn).toBeGreaterThan(last.compilerLocation.column ?? 0);
  });

  it('refuses unsupported types, lvalues, compound forms and unsafe locations explicitly', () => {
    const source = [
      '#version 300 es',
      'precision highp float;',
      'out vec4 o;',
      'uniform float u;',
      'void main() {',
      '  vec2 p = vec2(1.0);',
      '  p.x = 2.0;',
      '  p += vec2(1.0);',
      '  int k = 1;',
      '  mat2 m = mat2(1.0);',
      '  float arr[2] = float[2](1.0, 2.0);',
      '  float c = 1.0, d = 2.0;',
      '  float e = 0.0;',
      '  if (u > 0.0) e = 4.0;',
      '  for (float f = 0.0; f < 2.0; f += 1.0) { o = vec4(f); }',
      '  o = vec4(p, float(k), c + d + e + arr[1] + m[0][0]);',
      '}',
    ].join('\n');
    const catalogue = observe(source);
    expect(catalogue.points.map((point) => point.name)).toEqual(['p', 'e']);
    expect(named(catalogue, 'p')[0]?.kind).toBe('initialized-declaration');
    expect(new Set(reasons(catalogue))).toEqual(
      new Set([
        'unsupported-lvalue',
        'unsupported-compound-assignment',
        'unsupported-type',
        'unsupported-storage',
        'ambiguous-statement',
        'location-mismatch',
      ]),
    );
  });

  it('refuses macro-generated points and macro-named declarations', () => {
    const source = [
      '#version 300 es',
      'precision highp float;',
      'out vec4 o;',
      '#define SET_X x = 1.0',
      '#define NAME y',
      'void main() {',
      '  float x = 0.0;',
      '  SET_X;',
      '  float NAME = 2.0;',
      '  float z = 3.0;',
      '  o = vec4(x, y, z, 1.0);',
      '}',
    ].join('\n');
    const catalogue = observe(source);
    expect(catalogue.points.map((point) => point.name)).toEqual(['x', 'z']);
    expect(named(catalogue, 'x')[0]?.kind).toBe('initialized-declaration');
    expect(reasons(catalogue)).toContain('location-mismatch');
    expect(catalogue.refusals.length).toBeGreaterThanOrEqual(2);
  });

  it('refuses everything when the user remaps lines with #line', () => {
    const source = BASIC.replace('void main() {', '#line 40\nvoid main() {');
    const catalogue = observe(source);
    expect(catalogue.points).toEqual([]);
    expect(reasons(catalogue)).toEqual(['user-line-directive']);
  });

  it('refuses conditionally compiled statements', () => {
    const source = [
      '#version 300 es',
      'precision highp float;',
      'out vec4 o;',
      'void main() {',
      '  float a = 1.0;',
      '#ifdef SOMETHING',
      '  float b = 2.0;',
      '#endif',
      '  o = vec4(a);',
      '}',
    ].join('\n');
    const catalogue = observe(source);
    expect(catalogue.points.map((point) => point.name)).toEqual(['a']);
  });

  it('caps the catalogue at 128 points and says so', () => {
    const body = Array.from({ length: 200 }, (_, i) => `  float v${i} = u + ${i}.0;`).join('\n');
    const source = `#version 300 es\nprecision highp float;\nout vec4 o;\nuniform float u;\nvoid main() {\n${body}\n  o = vec4(v0);\n}\n`;
    const catalogue = observe(source);
    expect(catalogue.points).toHaveLength(MAX_OBSERVATION_POINTS);
    expect(catalogue.truncated).toBe(true);
  });

  it('works for ESSL 1.00 vertex and fragment stages', () => {
    const fragment = observe(
      'precision mediump float;\nvarying vec2 uv;\nvoid main() {\n  vec2 q = uv * 2.0;\n  gl_FragColor = vec4(q, 0.0, 1.0);\n}\n',
      'fragment',
      100,
    );
    expect(fragment.points[0]).toMatchObject({ name: 'q', type: 'vec2', precision: 'mediump' });
    const vertex = observe(
      'attribute vec3 position;\nvoid main() {\n  vec3 p = position;\n  gl_Position = vec4(p, 1.0);\n}\n',
      'vertex',
      100,
    );
    expect(vertex.points[0]).toMatchObject({ name: 'p', type: 'vec3', precision: 'highp' });
  });
});

describe('ordinary analysis is unchanged', () => {
  it('returns no observation unless asked and the same reply otherwise', () => {
    const ordinary = frontend.analyze(job(BASIC, 'fragment', 300));
    expect(ordinary.status).toBe('ok');
    expect(ordinary).not.toHaveProperty('observation');
    const opted = frontend.analyze({ ...job(BASIC, 'fragment', 300), observe: true });
    expect(opted).toHaveProperty('observation');
    const { observation: _observation, ...rest } = opted as Extract<JobOutcome, { status: 'ok' }>;
    expect(rest).toEqual(ordinary);
    expect(frontend.analyze({ ...job(BASIC, 'fragment', 300), observe: false })).toEqual(ordinary);
  });

  it('returns invalid-source without any partial observation', () => {
    const outcome = frontend.analyze({
      ...job(BASIC.replace('a + w', 'missing'), 'fragment', 300),
      observe: true,
    });
    expect(outcome.status).toBe('invalid-source');
    expect(outcome).not.toHaveProperty('observation');
  });

  it('releases compiler memory across repeated catalogue requests', () => {
    for (let round = 0; round < 3; round++) observe(BASIC);
    const before = frontend.heapBytes();
    for (let round = 0; round < 40; round++) observe(BASIC);
    expect(frontend.heapBytes()).toBe(before);
  });
});

describe('verified insertion contract', () => {
  function pointOf(source: string, name: string, kind?: ObservationPoint['kind']) {
    const catalogue = observe(source);
    const point = catalogue.points.find((p) => p.name === name && (!kind || p.kind === kind));
    if (!point) throw new Error(`no point ${name}`);
    return { catalogue, point };
  }

  it('edits only declared insertions and the result still compiles with the same shape', () => {
    const { catalogue, point } = pointOf(BASIC, 't');
    const result = planObservationInsertion(BASIC, catalogue, point.id);
    if (!result.ok) throw new Error(result.message);
    const { insertion } = result;
    expect(insertion.edits.map((edit) => edit.kind)).toEqual(['declaration', 'capture']);
    const edited = applyObservationEdits(BASIC, insertion.edits);
    // Everything outside the edits is byte-identical, in order.
    let rest = edited;
    let cursor = 0;
    for (const edit of insertion.edits) {
      expect(rest.startsWith(BASIC.slice(cursor, edit.start))).toBe(true);
      rest = rest.slice(edit.start - cursor + edit.text.length);
      cursor = edit.end;
    }
    expect(rest).toBe(BASIC.slice(cursor));
    // The original statement text is intact and read exactly once by the capture.
    expect(edited).toContain('float t = float(i) * a;');
    expect(edited.split(`= ${point.name}; ${insertion.identifiers.hit}`)).toHaveLength(2);
    expect(frontend.analyze(job(edited, 'fragment', 300)).status).toBe('ok');
    // Original offsets map into the edited source.
    const mapped = mapOriginalOffset(insertion.edits, point.span.name.start);
    expect(edited.slice(mapped ?? 0, (mapped ?? 0) + 1)).toBe('t');
    expect(mapOriginalOffset(insertion.edits, point.span.insertAt)).toBe(
      point.span.insertAt + (insertion.edits[0]?.text.length ?? 0),
    );
  });

  it('adds a verified entry wrapper only when publishing is requested', () => {
    const { catalogue, point } = pointOf(BASIC, 'v');
    expect(catalogue.entry).not.toBeNull();
    const withoutPublish = planObservationInsertion(BASIC, catalogue, point.id);
    expect(withoutPublish.ok && withoutPublish.insertion.identifiers.originalMain).toBeNull();
    const withIdentifiers = planObservationInsertion(BASIC, catalogue, point.id, {
      publish: 'o = vec4(1.0);',
    });
    if (!withIdentifiers.ok) throw new Error(withIdentifiers.message);
    const { insertion } = withIdentifiers;
    expect(insertion.edits.map((edit) => edit.kind)).toEqual([
      'declaration',
      'entry-rename',
      'capture',
      'entry-wrapper',
    ]);
    const edited = applyObservationEdits(BASIC, insertion.edits);
    expect(edited).toContain(`void ${insertion.identifiers.originalMain}()`);
    expect(edited).toMatch(/void main\(\) \{ sgo\d+_main\(\); o = vec4\(1\.0\); \}\n$/);
    expect(frontend.analyze(job(edited, 'fragment', 300)).status).toBe('ok');
  });

  it('picks identifiers that occur nowhere in the source', () => {
    const source = BASIC.replace('uniform float u;', 'uniform float u;\n// sgo0_count sgo1_x\n');
    const { catalogue, point } = pointOf(source, 'v');
    const result = planObservationInsertion(source, catalogue, point.id);
    if (!result.ok) throw new Error(result.message);
    expect(result.insertion.identifiers.visitCount).toBe('sgo2_count');
    for (const name of Object.values(result.insertion.identifiers)) {
      if (name) expect(source).not.toContain(name);
    }
  });

  it('rejects stale sources, unknown points and altered points', () => {
    const { catalogue, point } = pointOf(BASIC, 'v');
    const stale = planObservationInsertion(`${BASIC}// edit\n`, catalogue, point.id);
    expect(stale).toMatchObject({ ok: false, reason: 'stale-source' });
    expect(planObservationInsertion(BASIC, catalogue, 'nope')).toMatchObject({
      ok: false,
      reason: 'unknown-point',
    });
    const forged: ObservationCatalogue = {
      ...catalogue,
      points: catalogue.points.map((p) =>
        p.id === point.id ? { ...p, span: { ...p.span, insertAt: p.span.insertAt - 1 } } : p,
      ),
    };
    expect(planObservationInsertion(BASIC, forged, point.id)).toMatchObject({
      ok: false,
      reason: 'point-mismatch',
    });
  });

  it('refuses a wrapper without a unique main and invalid publish text', () => {
    const source = BASIC.replace('void main() {', 'void helper() {}\nvoid main() {\n  helper();');
    const dup = `${source}\nvoid other() { float main2 = 1.0; }\n`;
    const { catalogue, point } = pointOf(dup, 'v');
    expect(
      planObservationInsertion(dup, catalogue, point.id, { publish: '#define X' }),
    ).toMatchObject({ ok: false, reason: 'invalid-publish' });
    const noMain: ObservationCatalogue = { ...catalogue, entry: null };
    expect(
      planObservationInsertion(dup, noMain, point.id, { publish: 'o = vec4(1.0);' }),
    ).toMatchObject({
      ok: false,
      reason: 'entry-unavailable',
    });
  });

  it('binds identity to the exact UTF-16 source', () => {
    expect(sourceIdentity('a😀')).toEqual(sourceIdentity('a😀'));
    expect(sourceIdentity('a😀')).not.toEqual(sourceIdentity('a😁'));
    expect(sourceIdentity('a\r\nb')).not.toEqual(sourceIdentity('a\nb'));
    expect(sourceIdentity('a😀').length).toBe(3);
  });
});
