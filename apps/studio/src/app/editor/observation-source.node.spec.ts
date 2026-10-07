// Runs in Node (`pnpm test:analysis`): the real compiled front end produces the
// catalogue, so the mapping is held to real UTF-16 spans, not a stub.
import { beforeAll, describe, expect, it } from 'vitest';

import type { ObservationCatalogue } from '@shadergrove/glsl-analysis';
import { expandMacros } from '@shadergrove/shared/glsl-export';
import {
  DEFAULT_VERTEX,
  addFile,
  composePass,
  createProject,
  imagePass,
  setFileSource,
  setPassSource,
  type ShaderProject,
} from '@shadergrove/shared/project';

import { createFrontend, job } from '../../../../../libs/glsl-analysis/test/support/frontend';
import type { GlslangRuntime } from '../../../../../libs/glsl-analysis/src/worker/runtime';
import type { CapturedAccepted } from '../rendering/render-inspection';
import { GENERATED_PREFIX } from './glsl-analysis-source';
import { buildObservation, mapCatalogue, preparedFragment } from './observation-source';

let frontend: GlslangRuntime;
beforeAll(async () => {
  frontend = await createFrontend();
});

const IMAGE = [
  'precision highp float;',
  'uniform vec2 iResolution;',
  '#include "lib.glsl"',
  'void main() {',
  '  vec3 tint = vec3(helper(iResolution.x));',
  '  gl_FragColor = vec4(tint, 1.0);',
  '}',
  '',
].join('\n');

const LIB = [
  'float helper(float x) {',
  '  float inner = x * 2.0;',
  '  return inner;',
  '}',
  '',
].join('\n');

function project(image: string): ShaderProject {
  let result = createProject(image, DEFAULT_VERTEX);
  result = addFile(result, 'lib.glsl');
  result = setFileSource(result, result.files[0].id, LIB);
  return setPassSource(result, imagePass(result).id, image);
}

function accept(source: ShaderProject, mutate?: (a: CapturedAccepted) => CapturedAccepted) {
  const composed = composePass(source, imagePass(source));
  const accepted: CapturedAccepted = {
    fingerprint: 'fp',
    revision: 1,
    stale: false,
    composedFragment: composed.source,
    fragment: expandMacros(composed.source),
    composedVertex: '',
    vertex: '',
    spans: composed.spans,
  };
  return mutate ? mutate(accepted) : accepted;
}

function catalogueOf(accepted: CapturedAccepted): ObservationCatalogue {
  const prepared = preparedFragment(accepted);
  if (prepared === null) throw new Error('not prepared');
  const outcome = frontend.analyze({ ...job(prepared, 'fragment', 300), observe: true });
  if (outcome.status !== 'ok' || !outcome.observation) {
    throw new Error(`no observation: ${JSON.stringify(outcome).slice(0, 300)}`);
  }
  return outcome.observation;
}

describe('observation source mapping', () => {
  it('maps pass and nested-include points to their original documents and columns', () => {
    const accepted = accept(project(IMAGE));
    const { mapped, refused } = mapCatalogue(accepted, catalogueOf(accepted));
    const inner = mapped.find((entry) => entry.point.name === 'inner');
    const tint = mapped.find((entry) => entry.point.name === 'tint');
    expect(inner?.location).toMatchObject({ docName: 'lib.glsl', line: 2, column: 9 });
    expect(tint?.location).toMatchObject({ line: 5, column: 8 });
    expect(tint?.location.docId).not.toBe(inner?.location.docId);
    // Nothing the user does not own is ever offered.
    const prefix = GENERATED_PREFIX.fragment.length;
    for (const entry of mapped) expect(entry.point.span.name.start).toBeGreaterThanOrEqual(prefix);
    for (const entry of refused) {
      if (entry.point.span.name.start < prefix) expect(entry.reason).toBe('generated');
    }
  });

  it('never offers a statement on a line the macro expander rewrote', () => {
    const source = IMAGE.replace('vec3(helper(iResolution.x))', 'vec3(float(__MAX_WAVES__))');
    const accepted = accept(project(source));
    // The expander really did rewrite that line; offsets there are not the document's.
    expect(accepted.fragment).not.toBe(accepted.composedFragment);
    const { mapped } = mapCatalogue(accepted, catalogueOf(accepted));
    expect(mapped.some((entry) => entry.point.name === 'tint')).toBe(false);
  });

  it('offers no point after a #line directive', () => {
    const accepted = accept(project(IMAGE.replace('void main() {', '#line 40\nvoid main() {')));
    const { mapped, refused } = mapCatalogue(accepted, catalogueOf(accepted));
    expect(mapped).toEqual([]);
    // The catalogue already declines logical line directives; if it ever lists points, the mapping must too.
    for (const entry of refused) expect(['remapped', 'generated']).toContain(entry.reason);
  });

  it('refuses everything when the catalogue is not for this accepted program', () => {
    const accepted = accept(project(IMAGE));
    const other = accept(project(IMAGE.replace('1.0, 1.0', '1.0, 1.0')), (a) => ({
      ...a,
      composedFragment: `${a.composedFragment}// other\n`,
      fragment: `${a.fragment}// other\n`,
    }));
    const { mapped, refused } = mapCatalogue(other, catalogueOf(accepted));
    expect(mapped).toEqual([]);
    expect(refused.every((entry) => entry.reason === 'mismatch')).toBe(true);
  });

  it('is not prepared when the captured fragment is not the expansion of its documents', () => {
    const accepted = accept(project(IMAGE), (a) => ({ ...a, fragment: `${a.fragment}\n// drift` }));
    expect(preparedFragment(accepted)).toBeNull();
  });
});

describe('observation programs', () => {
  const accepted = accept(project(IMAGE));
  const catalogue = () => catalogueOf(accepted);

  it('builds preserved, hit and value programs that only add to the accepted source', () => {
    const cat = catalogue();
    const point = cat.points.find((entry) => entry.name === 'tint');
    expect(point).toBeDefined();
    const built = buildObservation(accepted, cat, point!);
    if (!built.ok) throw new Error(built.message);
    const { preserved, hit, value } = built.programs;
    // The original statement is untouched in all three and the generated prefix is not repeated.
    for (const program of [preserved, hit, value]) {
      expect(program).toContain('vec3 tint = vec3(helper(iResolution.x));');
      expect(program.startsWith(GENERATED_PREFIX.fragment)).toBe(false);
      expect(program).toContain(built.visitTarget);
    }
    expect(preserved).not.toContain('? 1.0 : 0.0');
    expect(hit).toContain('? 1.0 : 0.0');
    expect(value).toMatch(/gl_FragColor = vec4\(sgo\d+_value, 1\.0\);/);
    expect(built.prefix).toBe(GENERATED_PREFIX.fragment);
  });

  it('pads a float point to a vec4 and keeps the include point in the include', () => {
    const cat = catalogue();
    const point = cat.points.find((entry) => entry.name === 'inner')!;
    const built = buildObservation(accepted, cat, point);
    if (!built.ok) throw new Error(built.message);
    expect(built.programs.value).toMatch(/vec4\(sgo\d+_value, 0\.0, 0\.0, 1\.0\)/);
  });

  it('refuses when the captured fragment is not what the documents expand to', () => {
    const drifted = { ...accepted, fragment: `${accepted.fragment}\n// drift` };
    const cat = catalogue();
    const built = buildObservation(drifted, cat, cat.points[0]);
    expect(built).toMatchObject({ ok: false, reason: 'source' });
  });
});
