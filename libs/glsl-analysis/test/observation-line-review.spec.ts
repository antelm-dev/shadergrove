import { beforeAll, expect, it } from 'vitest';

import { SourceLines } from '../src/diagnostics';
import type { GlslangRuntime } from '../src/worker/runtime';
import { createFrontend, job } from './support/frontend';

let frontend: GlslangRuntime;
beforeAll(async () => {
  frontend = await createFrontend();
});

it.each([
  ['comment between hash and directive name', '# /* directive trivia */ line 100'],
  ['continued directive name', '#li\\\nne 100'],
])('refuses compiler-accepted line remapping with %s', (_name, directive) => {
  const source = [
    '#version 300 es',
    'precision highp float;',
    'out vec4 color;',
    'void main() {',
    '  float before = 1.0;',
    directive,
    '  float after = 2.0;',
    '  color = vec4(before + after);',
    '}',
  ].join('\n');
  const ordinary = frontend.analyze(job(source, 'fragment', 300));
  expect(ordinary.status).toBe('ok');
  const result = frontend.analyze({ ...job(source, 'fragment', 300), observe: true });
  if (result.status !== 'ok' || !result.observation) throw new Error('Expected valid catalogue');
  expect.soft(new SourceLines(source).remapped).toBe(true);
  expect(result.observation.points).toEqual([]);
  expect(result.observation.refusals.map((refusal) => refusal.reason)).toEqual([
    'user-line-directive',
  ]);
});

it('keeps an escaped-newline comment from becoming a real line directive', () => {
  const source = [
    '#version 300 es',
    'precision highp float;',
    'out vec4 color;',
    'void main() {',
    '// continued comment \\',
    '#line 100',
    '  float value = 1.0;',
    '  color = vec4(value);',
    '}',
  ].join('\n');
  const ordinary = frontend.analyze(job(source, 'fragment', 300));
  expect(ordinary.status).toBe('ok');
  const diagnostic = frontend.analyze(
    job(source.replace('vec4(value)', 'vec4(missing)'), 'fragment', 300),
  );
  expect(diagnostic.status).toBe('invalid-source');
  // Native diagnostic line 8 proves #line stayed inside the continued comment.
  expect(diagnostic.diagnostics.some((entry) => entry.location?.line === 8)).toBe(true);
  const result = frontend.analyze({ ...job(source, 'fragment', 300), observe: true });
  if (result.status !== 'ok' || !result.observation) throw new Error('Expected valid catalogue');
  expect.soft(new SourceLines(source).remapped).toBe(false);
  expect(result.observation.points.map((point) => point.name)).toEqual(['value']);
});
