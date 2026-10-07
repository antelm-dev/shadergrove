import { beforeAll, expect, it } from 'vitest';

import type { GlslangRuntime } from '../src/worker/runtime';
import { createFrontend, job } from './support/frontend';

let frontend: GlslangRuntime;
beforeAll(async () => {
  frontend = await createFrontend();
});

it('explicitly refuses an unsupported unbraced assignment instead of silently dropping it', () => {
  const source = [
    '#version 300 es',
    'precision highp float;',
    'out vec4 color;',
    'uniform float condition;',
    'void main() {',
    '  float value = 0.0;',
    '  if (condition > 0.0) value = 4.0;',
    '  color = vec4(value);',
    '}',
  ].join('\n');
  const ordinary = frontend.analyze(job(source, 'fragment', 300));
  expect(ordinary.status).toBe('ok');
  expect(ordinary).not.toHaveProperty('observation');
  const result = frontend.analyze({ ...job(source, 'fragment', 300), observe: true });
  if (result.status !== 'ok' || !result.observation) throw new Error('Expected valid catalogue');
  const { points, refusals } = result.observation;
  expect(points.filter((point) => point.name === 'value')).toHaveLength(1);
  expect(points[0]?.kind).toBe('initialized-declaration');
  // The unbraced control statement is outside the supported insertion shapes.
  // Its semantic assignment must still explain why no selectable point exists.
  expect(refusals.some((refusal) => refusal.line === 7)).toBe(true);
});

it('refuses the entire catalogue for a valid line directive with a leading comment', () => {
  const source = [
    '#version 300 es',
    'precision highp float;',
    'out vec4 color;',
    'void main() {',
    '  float before = 1.0;',
    '/* comment */ #line 100',
    '  float after = 2.0;',
    '  color = vec4(before + after);',
    '}',
  ].join('\n');
  const result = frontend.analyze({ ...job(source, 'fragment', 300), observe: true });
  if (result.status !== 'ok' || !result.observation) throw new Error('Expected valid catalogue');
  expect(result.observation.points).toEqual([]);
  expect(result.observation.refusals.map((refusal) => refusal.reason)).toEqual([
    'user-line-directive',
  ]);
});
