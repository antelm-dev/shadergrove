import type { AnalysisDiagnostic, CompilerLocation } from './contract';

/** Upper bound on diagnostics per reply; glslang can cascade on broken input. */
export const MAX_DIAGNOSTICS = 200;

const PREFIX = /^(ERROR|WARNING|INTERNAL ERROR|UNIMPLEMENTED|NOTE|UNKNOWN ERROR): (.*)$/;
const LOCATED = /^([^:\s]+):(\d+)(?::(\d+))?: (.*)$/;
const LINKING = /^Linking (?:\w+ )?stages?: (.*)$/;
const SUMMARY = /^\d+ compilation errors?\.\s+No code generated\.$/;

const SEVERITY: Record<string, AnalysisDiagnostic['severity']> = {
  ERROR: 'error',
  'INTERNAL ERROR': 'error',
  UNIMPLEMENTED: 'error',
  'UNKNOWN ERROR': 'error',
  WARNING: 'warning',
  NOTE: 'info',
};

/**
 * True when a real `#line` directive exists: `#` is the first token of a line
 * (only whitespace and comments before it) followed by `line`. Text inside
 * comments never counts.
 */
export function hasLineDirective(source: string): boolean {
  const n = source.length;
  let atLineStart = true;
  for (let i = 0; i < n;) {
    const c = source[i] as string;
    if (c === '\n' || c === '\r') {
      atLineStart = true;
      i++;
    } else if (c === ' ' || c === '\t' || c === '\f' || c === '\v') {
      i++;
    } else if (c === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n' && source[i] !== '\r') i++;
    } else if (c === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      i = close < 0 ? n : close + 2;
    } else if (atLineStart && c === '#') {
      if (/[ \t]*line\b/y.test(source.slice(i + 1, i + 64))) return true;
      atLineStart = false;
      i++;
    } else {
      atLineStart = false;
      i++;
    }
  }
  return false;
}

/**
 * Splits `source` into lines once so compiler byte columns can be converted to
 * UTF-16 columns. Conversion is refused when a `#line` directive is present,
 * because reported lines then no longer index the prepared source.
 */
export class SourceLines {
  private readonly lines: string[];
  readonly remapped: boolean;

  constructor(source: string) {
    this.lines = source.split(/\r\n|\r|\n/);
    this.remapped = hasLineDirective(source);
  }

  location(sourceString: string, line: number, compilerColumn: number | null): CompilerLocation {
    // glslang reports column 0 when it has no column (e.g. at end of input).
    const byteColumn = compilerColumn !== null && compilerColumn > 0 ? compilerColumn : null;
    return {
      sourceString,
      line,
      column: this.utf16Column(sourceString, line, byteColumn),
      byteColumn,
    };
  }

  private utf16Column(
    sourceString: string,
    line: number,
    byteColumn: number | null,
  ): number | null {
    if (byteColumn === null || byteColumn < 1 || this.remapped || sourceString !== '0') return null;
    const text = this.lines[line - 1];
    if (text === undefined) return null;
    // glslang counts bytes; walk code points until the byte offset is reached.
    let bytes = 0;
    let units = 0;
    for (const char of text) {
      if (bytes >= byteColumn - 1) break;
      const codePoint = char.codePointAt(0) ?? 0;
      bytes += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
      units += char.length;
    }
    return bytes >= byteColumn - 1 ? units + 1 : null;
  }
}

function splitToken(text: string): { token: string | null; message: string } {
  // glslang formats located messages as `'<token>' : <reason>`; the token may be empty.
  const close = text.startsWith("'") ? text.indexOf("' : ", 1) : -1;
  if (close < 0) return { token: null, message: text.trim() };
  return { token: text.slice(1, close), message: text.slice(close + 4).trim() };
}

/**
 * Parses a glslang info log (compiled with EShMsgDisplayErrorColumn) into
 * diagnostics. Summary lines and the redundant "compilation terminated" note
 * are dropped; unprefixed continuation lines are appended to the previous
 * message; exact duplicates are removed.
 */
export function parseInfoLog(
  log: string,
  phase: AnalysisDiagnostic['phase'],
  lines: SourceLines,
): { diagnostics: AnalysisDiagnostic[]; truncated: boolean } {
  const diagnostics: AnalysisDiagnostic[] = [];
  const seen = new Set<string>();
  let truncated = false;
  let previous: { message: string } | null = null;
  for (const rawLine of log.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const prefixed = PREFIX.exec(line);
    if (!prefixed) {
      if (previous) previous.message += `\n${line.trim()}`;
      continue;
    }
    const severity = SEVERITY[prefixed[1] as string] ?? 'error';
    const rest = prefixed[2] as string;
    if (SUMMARY.test(rest)) {
      previous = null;
      continue;
    }
    let location: CompilerLocation | null = null;
    let body = rest;
    const located = LOCATED.exec(rest);
    if (located) {
      location = lines.location(
        located[1] as string,
        Number(located[2]),
        located[3] === undefined ? null : Number(located[3]),
      );
      body = located[4] as string;
    } else {
      const linking = LINKING.exec(rest);
      if (linking) body = linking[1] as string;
    }
    const { token, message } = splitToken(body);
    if (token === '' && message === 'compilation terminated') {
      previous = null;
      continue;
    }
    const key = JSON.stringify([severity, phase, location, token, message]);
    if (seen.has(key)) {
      previous = null;
      continue;
    }
    seen.add(key);
    if (diagnostics.length === MAX_DIAGNOSTICS) {
      truncated = true;
      break;
    }
    const diagnostic = { severity, phase, message, token, location };
    diagnostics.push(diagnostic);
    previous = diagnostic;
  }
  return { diagnostics, truncated };
}
