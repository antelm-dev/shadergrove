import { describe, expect, it } from 'vitest';
import { MAX_DIAGNOSTICS, parseInfoLog, SourceLines } from './diagnostics';

const lines = (source = 'void main() {}\n') => new SourceLines(source);

describe('parseInfoLog', () => {
  it('parses located errors with columns and drops glslang summaries', () => {
    const log = [
      "ERROR: 0:1:6: 'main' : redefinition ",
      "ERROR: 0:1: '' : compilation terminated ",
      'ERROR: 2 compilation errors.  No code generated.',
      '',
    ].join('\n');
    expect(parseInfoLog(log, 'compile', lines()).diagnostics).toEqual([
      {
        severity: 'error',
        phase: 'compile',
        message: 'redefinition',
        token: 'main',
        location: { sourceString: '0', line: 1, column: 6, byteColumn: 6 },
      },
    ]);
  });

  it('parses link messages without a location', () => {
    const log =
      'ERROR: Linking fragment stage: Missing entry point: Each stage requires one entry point\n';
    expect(parseInfoLog(log, 'link', lines()).diagnostics).toEqual([
      {
        severity: 'error',
        phase: 'link',
        message: 'Missing entry point: Each stage requires one entry point',
        token: null,
        location: null,
      },
    ]);
  });

  it('maps severities, keeps continuation lines and removes duplicates', () => {
    const log = [
      "WARNING: 0:1:1: '#extension' : extension not supported: X",
      "WARNING: 0:1:1: '#extension' : extension not supported: X",
      'NOTE: something',
      '  more detail',
      'INTERNAL ERROR: boom',
    ].join('\n');
    const { diagnostics } = parseInfoLog(log, 'compile', lines());
    expect(diagnostics.map((diagnostic) => [diagnostic.severity, diagnostic.message])).toEqual([
      ['warning', 'extension not supported: X'],
      ['info', 'something\nmore detail'],
      ['error', 'boom'],
    ]);
  });

  it('caps the number of diagnostics', () => {
    const log = Array.from(
      { length: MAX_DIAGNOSTICS + 5 },
      (_, i) => `ERROR: 0:${i + 1}: 'x' : e`,
    ).join('\n');
    const result = parseInfoLog(log, 'compile', lines());
    expect(result.diagnostics).toHaveLength(MAX_DIAGNOSTICS);
    expect(result.truncated).toBe(true);
  });
});

describe('SourceLines', () => {
  it('converts UTF-8 byte columns to UTF-16 columns', () => {
    const source = 'a\n/*é😀*/x\n';
    // "x" follows 2 + 2 + 4 + 2 = 10 bytes, or 2 + 1 + 2 + 2 = 7 UTF-16 units.
    expect(lines(source).location('0', 2, 11)).toEqual({
      sourceString: '0',
      line: 2,
      column: 8,
      byteColumn: 11,
    });
  });

  it('returns null columns it cannot derive', () => {
    expect(lines().location('0', 1, 0)).toMatchObject({ column: null, byteColumn: null });
    expect(lines().location('0', 9, 1).column).toBeNull();
    expect(lines().location('2', 1, 1).column).toBeNull();
    expect(lines('#line 4\nvoid main() {}').location('0', 4, 1).column).toBeNull();
  });
});
