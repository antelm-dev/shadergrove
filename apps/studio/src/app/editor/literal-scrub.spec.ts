import { beforeAll, describe, expect, it } from 'vitest';

import {
  findScrubbableLiteral,
  formatScrubbed,
  literalValue,
  scrubStep,
  type ScrubLiteral,
} from './literal-scrub';
import { GLSL_LANGUAGE_ID, type MonacoApi } from './monaco-loader';
import { loadMonacoInJsdom } from './testing/jsdom-monaco';

let monaco: MonacoApi;

beforeAll(async () => {
  monaco = await loadMonacoInJsdom();
}, 120_000);

/** The literal at the `|` in `marked`, tokenized by the app's real GLSL tokenizer. */
function at(marked: string): ScrubLiteral | null {
  const column = marked.indexOf('|') + 1;
  const line = marked.replace('|', '');
  return findScrubbableLiteral(line, column, monaco.editor.tokenize(line, GLSL_LANGUAGE_ID)[0]);
}

function literal(marked: string): ScrubLiteral {
  const found = at(marked);
  if (!found) throw new Error(`no literal in ${marked}`);
  return found;
}

describe('findScrubbableLiteral', () => {
  it.each([
    ['float a = 0.|5;', '0.5'],
    ['float a = 0.5|;', '0.5'],
    ['float a = |0.5;', '0.5'],
    ['int n = 1|2;', '12'],
    ['vec2 v = vec2(1.5|f);', '1.5f'],
    ['uint u = 3|u;', '3u'],
    ['float a = .|25;', '.25'],
    ['vec3(0.|1, 0.2, 0.3)', '0.1'],
    ['float a = 1|.;', '1'],
  ])('reads %s as %s', (marked, text) => {
    expect(at(marked)?.text).toBe(text);
  });

  it.each([
    ['a comment', 'float a = 1.0; // 0.|5'],
    ['a block comment', 'float a = /* 0.|5 */ 1.0;'],
    ['an identifier', 'float b = x|1;'],
    ['an identifier, after its digits', 'float b = x1|;'],
    ['a define', '#define K 0.|5'],
    ['an indented directive', '  #  define K 0.|5'],
    ['an exponent float', 'float a = 1.0e|5;'],
    ['an exponent integer', 'float a = 1|e5;'],
    ['a hex integer', 'int a = 0x1|F;'],
    ['an operator', 'a = b +| c;'],
    ['the end of the line', 'a = 1.0;|'],
  ])('ignores %s', (_name, marked) => {
    expect(at(marked)).toBeNull();
  });

  it.each([
    ['a = -0.|5;', true],
    ['-0.|5', true],
    ['b * -0.|5', true],
    ['f(a, -0.|5)', true],
    ['f(-0.|5)', true],
    ['c ? -1.|0 : 1.0', true],
    ['a = b-0.|5;', false],
    ['a = b -0.|5;', false],
    ['a = b - 0.|5;', false],
    ['a = f()-0.|5;', false],
  ])('takes the minus in %s as unary: %s', (marked, signed) => {
    const found = literal(marked);
    expect(found.signed).toBe(signed);
    expect(found.text.startsWith('-')).toBe(signed);
  });

  it('reports a 1-based range that covers the sign and the suffix', () => {
    expect(literal('a = -0.5|f;')).toEqual({
      startColumn: 5,
      endColumn: 10,
      text: '-0.5f',
      kind: 'float',
      decimals: 1,
      suffix: 'f',
      signed: true,
      nonNegative: false,
    });
  });

  it('keeps a value behind a binary minus, and an unsigned one, from going negative', () => {
    expect(literal('a = b-0.|5;').nonNegative).toBe(true);
    expect(literal('a = b - 0.|5;').nonNegative).toBe(false);
    expect(literal('uint u = 3|u;').nonNegative).toBe(true);
  });
});

describe('scrubStep', () => {
  it.each([
    ['0.50', {}, 0.01, 2],
    ['0.50', { shift: true }, 0.1, 2],
    ['0.50', { ctrl: true }, 0.001, 3],
    ['1.0', {}, 0.1, 1],
    ['1.0', { shift: true }, 1, 1],
    ['1.0', { ctrl: true }, 0.01, 2],
    ['1.0', { shift: true, ctrl: true }, 0.1, 2],
    ['3', {}, 1, 0],
    ['3', { shift: true }, 10, 0],
    ['3', { ctrl: true }, 1, 0],
  ])('steps %s with %o by %s at %s decimals', (text, modifiers, step, decimals) => {
    expect(scrubStep(literal(`x = ${text}|;`), modifiers)).toEqual({ step, decimals });
  });
});

describe('formatScrubbed', () => {
  const format = (marked: string, value: number, decimals?: number) =>
    formatScrubbed(literal(marked), value, decimals);

  it.each([
    ['x = 0.5|0;', 0.6, undefined, '0.60'],
    ['x = 0.5|0;', 0.1 + 0.2, undefined, '0.30'],
    ['x = 0.5|0;', 0.6005, 3, '0.601'],
    ['x = 1.5|f;', 1.6, undefined, '1.6f'],
    ['x = 1.5|F;', -2, undefined, '-2.0F'],
    ['x = 3|;', 4.4, undefined, '4'],
    ['x = 3|;', -4, undefined, '-4'],
    ['x = 3|u;', 7, undefined, '7u'],
    ['x = 3|u;', -2, undefined, '0u'],
    ['x = -0.|5;', 0.5, undefined, '0.5'],
    ['x = 0.0|5;', 0.05 - 10 * 0.01, undefined, '-0.05'],
    ['x = b-0.|5;', -0.2, undefined, '0.0'],
    ['x = 0.0|0;', -0.0001, undefined, '0.00'],
    ['x = .|25;', 0.26, undefined, '0.26'],
  ])('writes %s at %s (decimals %s) as %s', (marked, value, decimals, text) => {
    expect(format(marked, value, decimals)).toBe(text);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e25, -1e30, 1e-30])(
    'never writes an exponent or a non-finite value for %s',
    (value) => {
      for (const marked of ['x = 0.|5;', 'x = 3|;', 'x = 1.5|f;']) {
        expect(format(marked, value)).toMatch(/^-?\d+(\.\d+)?[fFuU]?$/);
      }
    },
  );

  it('reads the value a literal starts from, sign included', () => {
    expect(literalValue(literal('x = -0.2|5f;'))).toBe(-0.25);
    expect(literalValue(literal('x = 12|u;'))).toBe(12);
  });
});
