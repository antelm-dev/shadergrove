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
