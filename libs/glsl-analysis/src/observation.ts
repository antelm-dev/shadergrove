/**
 * Private observation boundary: verifies the compiler's candidate points
 * against the exact prepared source and plans the only source edits a later
 * measurement may apply.
 *
 * The compiler (glslang's semantic tree) supplies symbol identity, effective
 * type and precision. It never proves an editable span: TSourceLoc is only a
 * hint, so every point is re-derived from this module's own token scan of the
 * same UTF-16 source and refused unless statement, name, `=` token, brace scope
 * and enclosing function all correspond uniquely. Mapping the prepared source
 * back to editor documents (Common, includes, generated prefixes) stays with
 * the caller, which owns that composition; every range here is in prepared
 * source UTF-16 offsets so the caller can do it.
 *
 * Nothing here claims that a modified program's intermediates equal the
 * original executable's internal values.
 */
import type {
  ObservationCatalogue,
  ObservationEntry,
  ObservationPoint,
  ObservationRefusal,
  ObservationRefusalReason,
  ObservationSourceIdentity,
  ObservationType,
  SourceRange,
} from './contract';
import { SourceLines } from './diagnostics';

/** Upper bound on observation points per reply; more is reported as `truncated`. */
export const MAX_OBSERVATION_POINTS = 128;
/** Upper bound on selectable visits (executions of one point per invocation). */
export const MAX_OBSERVATION_VISITS = 128;

/** JSON produced by `gla_observe`, under the `observation` key. */
export interface NativeObservation {
  points: NativePoint[];
  refusals: { reason: string; line: number; column: number }[];
  pointsTruncated: boolean;
  refusalsTruncated: boolean;
}

export interface NativePoint {
  function: string;
  name: string;
  symbolId: number;
  base: string;
  precision: 'lowp' | 'mediump' | 'highp' | null;
  line: number;
  column: number;
  loopDepth: number;
  conditionalDepth: number;
  header: boolean;
  ambiguousName: boolean;
}

const TYPES: ReadonlySet<string> = new Set(['float', 'vec2', 'vec3', 'vec4']);
const PRECISIONS: ReadonlySet<string> = new Set(['lowp', 'mediump', 'highp']);

/** Two independent 32-bit FNV-1a lanes over UTF-16 code units, plus the length. */
export function sourceIdentity(source: string): ObservationSourceIdentity {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < source.length; i++) {
    const unit = source.charCodeAt(i);
    a = Math.imul(a ^ unit, 0x01000193);
    b = Math.imul(b ^ unit, 0x85ebca6b);
  }
  const hex = (value: number) => (value >>> 0).toString(16).padStart(8, '0');
  return { length: source.length, hash: hex(a) + hex(b) };
}

// ---------------------------------------------------------------------------
// Token scan

interface Token {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly kind: 'id' | 'num' | 'punct';
  /** Open `#if`/`#ifdef`/`#ifndef` blocks at this token. */
  readonly conditional: number;
}

interface Statement {
  /** Token indexes, inclusive; `last` is the terminating `;`. */
  readonly first: number;
  readonly last: number;
  readonly path: readonly number[];
  /** Index into `Scan.functions`. */
  readonly fn: number;
}

interface FunctionHead {
  readonly name: string | null;
  readonly nameIndex: number;
  readonly firstIndex: number;
  readonly openIndex: number;
  closeIndex: number;
}

interface Scan {
  readonly tokens: Token[];
  readonly macros: Set<string>;
  readonly statements: Statement[];
  readonly functions: FunctionHead[];
}

const NUMBER = /0[xX][0-9a-fA-F]+[uU]?|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[fFuU]?/y;
const PUNCT = /<<=|>>=|\+\+|--|&&|\|\||\^\^|==|!=|<=|>=|\+=|-=|\*=|\/=|%=|<<|>>|&=|\|=|\^=|[\s\S]/y;
const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;

function sticky(pattern: RegExp, text: string, at: number): string | null {
  pattern.lastIndex = at;
  const match = pattern.exec(text);
  return match ? match[0] : null;
}

function scan(source: string): Scan {
  const tokens: Token[] = [];
  const macros = new Set<string>();
  let conditional = 0;
  let lineStart = true;
  let i = 0;
  const n = source.length;

  while (i < n) {
    const c = source[i] as string;
    if (c === '\n' || c === '\r') {
      lineStart = true;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\f' || c === '\v') {
      i++;
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n' && source[i] !== '\r') i++;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      i = close < 0 ? n : close + 2;
      continue;
    }
    if (c === '#' && lineStart) {
      // One logical directive line: backslash continuations and comments inside.
      let body = '';
      i++;
      while (i < n) {
        const d = source[i] as string;
        if (d === '\\' && (source[i + 1] === '\n' || source[i + 1] === '\r')) {
          i += source[i + 1] === '\r' && source[i + 2] === '\n' ? 3 : 2;
          continue;
        }
        if (d === '\n' || d === '\r') break;
        if (d === '/' && source[i + 1] === '*') {
          const close = source.indexOf('*/', i + 2);
          i = close < 0 ? n : close + 2;
          body += ' ';
          continue;
        }
        if (d === '/' && source[i + 1] === '/') {
          while (i < n && source[i] !== '\n' && source[i] !== '\r') i++;
          break;
        }
        body += d;
        i++;
      }
      const directive = /^\s*([A-Za-z_]\w*)\s*(.*)$/s.exec(body);
      const keyword = directive?.[1];
      if (keyword === 'define' || keyword === 'undef') {
        const name = /^[A-Za-z_]\w*/.exec(directive?.[2] ?? '');
        if (name) macros.add(name[0]);
      } else if (keyword === 'if' || keyword === 'ifdef' || keyword === 'ifndef') {
        conditional++;
      } else if (keyword === 'endif') {
        conditional = Math.max(0, conditional - 1);
      }
      continue;
    }
    lineStart = false;
    const ident = sticky(IDENT, source, i);
    if (ident) {
      tokens.push({ text: ident, start: i, end: i + ident.length, kind: 'id', conditional });
      i += ident.length;
      continue;
    }
    const number = sticky(NUMBER, source, i);
    if (number) {
      tokens.push({ text: number, start: i, end: i + number.length, kind: 'num', conditional });
      i += number.length;
      continue;
    }
    // PUNCT's final alternative matches any single character, including a lone surrogate.
    const punct = sticky(PUNCT, source, i) ?? c;
    tokens.push({ text: punct, start: i, end: i + punct.length, kind: 'punct', conditional });
    i += punct.length;
  }

  // Structure: brace scopes, function definitions and statement boundaries.
  const statements: Statement[] = [];
  const functions: FunctionHead[] = [];
  const stack: { ordinal: number; fn: number }[] = [];
  let braces = 0;
  let parens = 0;
  let statementStart = 0;
  for (let t = 0; t < tokens.length; t++) {
    const text = (tokens[t] as Token).text;
    if (text === '(' || text === '[') parens++;
    else if (text === ')' || text === ']') parens = Math.max(0, parens - 1);
    else if (parens === 0 && text === '{') {
      let fn = stack.length ? (stack[0] as { fn: number }).fn : -1;
      if (stack.length === 0) {
        fn = functions.length;
        functions.push(functionHead(tokens, statementStart, t));
      }
      stack.push({ ordinal: braces++, fn });
      statementStart = t + 1;
    } else if (parens === 0 && text === '}') {
      if (stack.length === 1)
        (functions[(stack[0] as { fn: number }).fn] as FunctionHead).closeIndex = t;
      stack.pop();
      statementStart = t + 1;
    } else if (parens === 0 && text === ';') {
      if (stack.length > 0) {
        statements.push({
          first: statementStart,
          last: t,
          path: stack.map((scope) => scope.ordinal),
          fn: (stack[0] as { fn: number }).fn,
        });
      }
      statementStart = t + 1;
    }
  }
  return { tokens, macros, statements, functions };
}

/** Reads `type name ( ... )` immediately before a depth-0 `{`; anything else is not a function. */
function functionHead(tokens: Token[], first: number, open: number): FunctionHead {
  const none = (): FunctionHead => ({
    name: null,
    nameIndex: -1,
    firstIndex: first,
    openIndex: open,
    closeIndex: -1,
  });
  if ((tokens[open - 1] as Token | undefined)?.text !== ')') return none();
  let depth = 0;
  for (let t = open - 1; t >= first; t--) {
    const text = (tokens[t] as Token).text;
    if (text === ')') depth++;
    else if (text === '(' && --depth === 0) {
      const name = tokens[t - 1];
      if (t - 1 > first && name?.kind === 'id') {
        return {
          name: name.text,
          nameIndex: t - 1,
          firstIndex: first,
          openIndex: open,
          closeIndex: -1,
        };
      }
      return none();
    }
  }
  return none();
}

// ---------------------------------------------------------------------------
// Statement verification (shared by the catalogue and the insertion planner)

interface StatementShape {
  readonly kind: ObservationPoint['kind'];
  readonly nameIndex: number;
  readonly operatorIndex: number;
}

type Verdict =
  | { readonly ok: true; readonly shape: StatementShape }
  | { readonly ok: false; readonly reason: ObservationRefusalReason; readonly message: string };

const refuse = (reason: ObservationRefusalReason, message: string): Verdict => ({
  ok: false,
  reason,
  message,
});

/**
 * Accepts only `[precision] type name = expr;` and `name = expr;` as one whole
 * statement inside a braced block, with no macro, conditional compilation,
 * comma or second declarator involved.
 */
function verifyStatement(
  scanned: Scan,
  statement: Statement,
  expect: { name: string; type: string; precision: string | null; fn: string },
): Verdict {
  const { tokens, macros, functions } = scanned;
  const head = functions[statement.fn] as FunctionHead;
  if (head.name === null) return refuse('statement-shape', 'The enclosing block is not a function');
  if (head.name !== expect.fn) {
    return refuse('ambiguous-function', `The compiler function ${expect.fn} is not ${head.name}`);
  }
  if (functions.filter((other) => other.name === head.name).length > 1) {
    return refuse('ambiguous-function', `Several definitions are named ${head.name}`);
  }
  if (macros.has(head.name)) return refuse('macro', `${head.name} is also a macro`);
  if ((tokens[head.firstIndex] as Token).conditional > 0) {
    return refuse('conditional-compilation', 'The function is conditionally compiled');
  }

  let operatorIndex = -1;
  let depth = 0;
  for (let t = statement.first; t <= statement.last; t++) {
    const token = tokens[t] as Token;
    if (token.conditional > 0) {
      return refuse('conditional-compilation', 'The statement is conditionally compiled');
    }
    if (token.kind === 'id' && macros.has(token.text)) {
      return refuse('macro', `${token.text} is defined as a macro`);
    }
    if (token.text === '(' || token.text === '[') depth++;
    else if (token.text === ')' || token.text === ']') depth--;
    else if (depth === 0 && token.text === ',') {
      return refuse('compound-declaration', 'Comma-separated declarators or expressions');
    } else if (depth === 0 && token.text === '=' && operatorIndex < 0) operatorIndex = t;
  }
  if (operatorIndex < 0) return refuse('statement-shape', 'No top-level assignment');
  if (operatorIndex + 1 >= statement.last) {
    return refuse('statement-shape', 'The assignment has no expression');
  }

  const left = tokens.slice(statement.first, operatorIndex);
  const [a, b, c] = left as [Token | undefined, Token | undefined, Token | undefined];
  if (left.length === 1 && a?.kind === 'id' && a.text === expect.name) {
    return { ok: true, shape: { kind: 'assignment', nameIndex: statement.first, operatorIndex } };
  }
  const precisionToken = left.length === 3 && a && PRECISIONS.has(a.text) ? a : null;
  const typeToken = precisionToken ? b : left.length === 2 ? a : undefined;
  const nameToken = precisionToken ? c : left.length === 2 ? b : undefined;
  if (
    typeToken &&
    nameToken &&
    typeToken.text === expect.type &&
    TYPES.has(typeToken.text) &&
    nameToken.kind === 'id' &&
    nameToken.text === expect.name &&
    (precisionToken === null ||
      (expect.precision !== null && precisionToken.text === expect.precision))
  ) {
    return {
      ok: true,
      shape: {
        kind: 'initialized-declaration',
        nameIndex: left.length - 1 + statement.first,
        operatorIndex,
      },
    };
  }
  return refuse('statement-shape', 'The statement is not a direct local declaration or assignment');
}

// ---------------------------------------------------------------------------
// Catalogue

const NATIVE_REFUSALS: Record<string, [ObservationRefusalReason, string]> = {
  type: ['unsupported-type', 'Only float, vec2, vec3 and vec4 scalars/vectors can be observed'],
  storage: ['unsupported-storage', 'Only plain local variables can be observed'],
  precision: ['unsupported-precision', 'The compiler resolved no effective precision'],
  lvalue: ['unsupported-lvalue', 'Only a directly named variable can be observed'],
  'compound-assignment': ['unsupported-compound-assignment', 'Compound assignment is not a point'],
  unbraced: ['statement-shape', 'An assignment that is not directly inside a braced block'],
  increment: ['unsupported-increment', 'Increment and decrement are not points'],
};

function wholeSourceRefusal(
  identity: ObservationSourceIdentity,
  reason: ObservationRefusalReason,
  message: string,
): ObservationCatalogue {
  return {
    source: identity,
    points: [],
    refusals: [{ reason, line: null, column: null, message }],
    truncated: false,
    entry: null,
  };
}

function findEntry(scanned: Scan): ObservationEntry | null {
  const { tokens, functions, macros } = scanned;
  const uses = tokens.filter((token) => token.kind === 'id' && token.text === 'main');
  const definition = functions.find((fn) => fn.name === 'main');
  if (uses.length !== 1 || !definition || macros.has('main') || definition.closeIndex < 0) {
    return null;
  }
  const name = tokens[definition.nameIndex] as Token;
  if ((tokens[definition.firstIndex] as Token).conditional > 0) return null;
  return {
    name: { start: name.start, end: name.end },
    end: (tokens[definition.closeIndex] as Token).end,
  };
}

/**
 * Turns the compiler's candidates into verified points and explicit refusals
 * for exactly `source`. A user `#line` makes every compiler location untrustworthy,
 * so the whole catalogue is refused.
 */
export function verifyObservation(source: string, native: NativeObservation): ObservationCatalogue {
  const identity = sourceIdentity(source);
  const lines = new SourceLines(source);
  if (lines.remapped) {
    return wholeSourceRefusal(
      identity,
      'user-line-directive',
      'A #line directive remaps compiler locations; no point can be verified',
    );
  }
  const scanned = scan(source);
  const lineStarts = [0];
  for (const match of source.matchAll(/\r\n|\r|\n/g))
    lineStarts.push(match.index + match[0].length);

  const refusals: ObservationRefusal[] = native.refusals.flatMap((entry) => {
    const mapped = NATIVE_REFUSALS[entry.reason];
    return mapped
      ? [{ reason: mapped[0], line: entry.line, column: entry.column, message: mapped[1] }]
      : [];
  });

  // Pass 1: resolve every compiler hint to a token and statement.
  interface Resolved {
    point: NativePoint;
    statementIndex: number;
    tokenIndex: number;
    column: number;
  }
  const resolved: Resolved[] = [];
  const decline = (point: NativePoint, reason: ObservationRefusalReason, message: string) =>
    refusals.push({ reason, line: point.line, column: point.column, message });
  for (const point of native.points) {
    if (point.header) {
      decline(point, 'loop-header', 'Loop headers are not block statements');
      continue;
    }
    if (point.ambiguousName) {
      decline(
        point,
        'ambiguous-name',
        `${point.name} names more than one symbol in ${point.function}`,
      );
      continue;
    }
    const column = lines.location('0', point.line, point.column).column;
    const lineStart = lineStarts[point.line - 1];
    if (column === null || lineStart === undefined || !TYPES.has(point.base) || !point.precision) {
      decline(point, 'location-mismatch', 'The compiler location is not in the source');
      continue;
    }
    const offset = lineStart + column - 1;
    const tokenIndex = scanned.tokens.findIndex((token) => token.start === offset);
    const statementIndex = scanned.statements.findIndex(
      (statement) => statement.first <= tokenIndex && tokenIndex <= statement.last,
    );
    if (tokenIndex < 0 || statementIndex < 0) {
      decline(point, 'location-mismatch', 'No statement token starts at the compiler location');
      continue;
    }
    resolved.push({ point, statementIndex, tokenIndex, column });
  }

  const perStatement = new Map<number, number>();
  for (const entry of resolved) {
    perStatement.set(entry.statementIndex, (perStatement.get(entry.statementIndex) ?? 0) + 1);
  }
  const points: ObservationPoint[] = [];
  for (const entry of resolved) {
    const { point } = entry;
    if ((perStatement.get(entry.statementIndex) ?? 0) > 1) {
      decline(point, 'ambiguous-statement', 'Several compiler nodes map to one source statement');
      continue;
    }
    const statement = scanned.statements[entry.statementIndex] as Statement;
    const verdict = verifyStatement(scanned, statement, {
      name: point.name,
      type: point.base,
      precision: point.precision,
      fn: point.function,
    });
    if (!verdict.ok) {
      decline(point, verdict.reason, verdict.message);
      continue;
    }
    const { shape } = verdict;
    if (entry.tokenIndex !== shape.operatorIndex && entry.tokenIndex !== shape.nameIndex) {
      decline(point, 'location-mismatch', 'The compiler location is neither the name nor the =');
      continue;
    }
    const tokens = scanned.tokens;
    const nameToken = tokens[shape.nameIndex] as Token;
    const operatorToken = tokens[shape.operatorIndex] as Token;
    const last = tokens[statement.last] as Token;
    const head = scanned.functions[statement.fn] as FunctionHead;
    points.push({
      id: `${identity.hash}:${points.length}`,
      kind: shape.kind,
      name: point.name,
      symbolId: point.symbolId,
      function: point.function,
      type: point.base as ObservationType,
      precision: point.precision as 'lowp' | 'mediump' | 'highp',
      scope: {
        path: statement.path,
        loopDepth: point.loopDepth,
        conditionalDepth: point.conditionalDepth,
      },
      maxVisits: MAX_OBSERVATION_VISITS,
      span: {
        statement: { start: (tokens[statement.first] as Token).start, end: last.end },
        name: { start: nameToken.start, end: nameToken.end },
        operator: { start: operatorToken.start, end: operatorToken.end },
        insertAt: last.end,
        functionStart: (tokens[head.firstIndex] as Token).start,
      },
      compilerLocation: {
        sourceString: '0',
        line: point.line,
        column: entry.column,
        byteColumn: point.column,
      },
    });
  }

  return {
    source: identity,
    points,
    refusals: refusals.slice(0, MAX_OBSERVATION_POINTS),
    truncated: native.pointsTruncated,
    entry: findEntry(scanned),
  };
}

// ---------------------------------------------------------------------------
// Insertion contract

export interface ObservationEdit {
  readonly kind: 'declaration' | 'capture' | 'entry-rename' | 'entry-wrapper';
  /** Replaces `[start, end)` of the original source; `start === end` is a pure insertion. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** Collision-free names introduced by the edits; the original source uses none of them. */
export interface ObservationIdentifiers {
  /** `uniform mediump int`: which visit (1-based) to capture; set by the measurement. */
  readonly visitTarget: string;
  readonly visitCount: string;
  readonly hit: string;
  /** Global of the point's exact effective type and precision; written once, on the target visit. */
  readonly value: string;
  /** The renamed original `main`; null without an entry wrapper. */
  readonly originalMain: string | null;
}

export interface ObservationInsertion {
  readonly pointId: string;
  readonly source: ObservationSourceIdentity;
  readonly identifiers: ObservationIdentifiers;
  /** Ascending, disjoint; the original source outside these ranges is unchanged. */
  readonly edits: readonly ObservationEdit[];
}

export type InsertionRefusalReason =
  | 'stale-source'
  | 'unknown-point'
  | 'point-mismatch'
  | 'entry-unavailable'
  | 'invalid-publish';

export type InsertionPlan =
  | { readonly ok: true; readonly insertion: ObservationInsertion }
  | {
      readonly ok: false;
      readonly reason: InsertionRefusalReason;
      readonly message: string;
    };

export interface InsertionOptions {
  /**
   * Statements run at the end of an entry wrapper, after the original `main`
   * returned, to publish the captured value. Supplying them adds the declared
   * wrapper edits; the caller owns output encoding.
   */
  readonly publish?: string;
}

const fail = (reason: InsertionRefusalReason, message: string): InsertionPlan => ({
  ok: false,
  reason,
  message,
});

function sameRange(a: SourceRange, b: SourceRange): boolean {
  return a.start === b.start && a.end === b.end;
}

/**
 * Plans the edits for one catalogue point. Rechecks that `source` is the exact
 * source the catalogue was verified against and that the point's ranges still
 * delimit the same verified statement, so a stale or altered catalogue cannot
 * produce an edit. The only edits are: one declaration block at the start of
 * the enclosing function, one capture block directly after the statement's
 * `;`, and, only when `publish` is given, the rename of `main` plus an appended
 * wrapper. The original statement is never rewritten, so its expressions run
 * exactly as often as before; the capture only reads the named local.
 */
export function planObservationInsertion(
  source: string,
  catalogue: ObservationCatalogue,
  pointId: string,
  options: InsertionOptions = {},
): InsertionPlan {
  const identity = sourceIdentity(source);
  if (identity.length !== catalogue.source.length || identity.hash !== catalogue.source.hash) {
    return fail('stale-source', 'The source is not the one the catalogue was verified against');
  }
  const point = catalogue.points.find((candidate) => candidate.id === pointId);
  if (!point) return fail('unknown-point', `No verified point ${pointId}`);

  const scanned = scan(source);
  const statementIndex = scanned.statements.findIndex((statement) =>
    sameRange(point.span.statement, {
      start: (scanned.tokens[statement.first] as Token).start,
      end: (scanned.tokens[statement.last] as Token).end,
    }),
  );
  const statement = scanned.statements[statementIndex];
  const verdict = statement
    ? verifyStatement(scanned, statement, {
        name: point.name,
        type: point.type,
        precision: point.precision,
        fn: point.function,
      })
    : null;
  if (!statement || !verdict?.ok) {
    return fail('point-mismatch', 'The point no longer delimits a verified statement');
  }
  const { shape } = verdict;
  const operator = scanned.tokens[shape.operatorIndex] as Token;
  const name = scanned.tokens[shape.nameIndex] as Token;
  const head = scanned.functions[statement.fn] as FunctionHead;
  if (
    shape.kind !== point.kind ||
    !sameRange(point.span.operator, operator) ||
    !sameRange(point.span.name, name) ||
    point.span.insertAt !== (scanned.tokens[statement.last] as Token).end ||
    point.span.functionStart !== (scanned.tokens[head.firstIndex] as Token).start
  ) {
    return fail('point-mismatch', 'The point spans differ from the verified statement');
  }

  let entry: ObservationEntry | null = null;
  if (options.publish !== undefined) {
    if (options.publish.includes('#') || options.publish.trim() === '') {
      return fail(
        'invalid-publish',
        'Publish statements must be non-empty and contain no directive',
      );
    }
    entry = findEntry(scanned);
    if (!entry || !catalogue.entry || !sameRange(entry.name, catalogue.entry.name)) {
      return fail('entry-unavailable', 'There is no unique verified main() to wrap');
    }
  }

  // Smallest prefix that occurs nowhere in the source (comments included).
  let serial = 0;
  while (source.includes(`sgo${serial}_`)) serial++;
  const prefix = `sgo${serial}_`;
  const identifiers: ObservationIdentifiers = {
    visitTarget: `${prefix}target`,
    visitCount: `${prefix}count`,
    hit: `${prefix}hit`,
    value: `${prefix}value`,
    originalMain: entry ? `${prefix}main` : null,
  };

  const edits: ObservationEdit[] = [
    {
      kind: 'declaration',
      start: point.span.functionStart,
      end: point.span.functionStart,
      text:
        `uniform mediump int ${identifiers.visitTarget};\n` +
        `mediump int ${identifiers.visitCount} = 0;\n` +
        `bool ${identifiers.hit} = false;\n` +
        `${point.precision} ${point.type} ${identifiers.value};\n`,
    },
    {
      kind: 'capture',
      start: point.span.insertAt,
      end: point.span.insertAt,
      text:
        ` { ${identifiers.visitCount} = ${identifiers.visitCount} + 1; ` +
        `if (${identifiers.visitCount} == ${identifiers.visitTarget}) ` +
        `{ ${identifiers.value} = ${point.name}; ${identifiers.hit} = true; } }`,
    },
  ];
  if (entry && identifiers.originalMain) {
    edits.push(
      {
        kind: 'entry-rename',
        start: entry.name.start,
        end: entry.name.end,
        text: identifiers.originalMain,
      },
      {
        kind: 'entry-wrapper',
        start: source.length,
        end: source.length,
        text: `\nvoid main() { ${identifiers.originalMain}(); ${options.publish} }\n`,
      },
    );
  }
  edits.sort((x, y) => x.start - y.start);
  return { ok: true, insertion: { pointId, source: identity, identifiers, edits } };
}

/** Applies ascending, disjoint edits; throws if they are not, so a bad plan cannot slip through. */
export function applyObservationEdits(source: string, edits: readonly ObservationEdit[]): string {
  let out = '';
  let cursor = 0;
  for (const edit of edits) {
    if (edit.start < cursor || edit.end < edit.start || edit.end > source.length) {
      throw new RangeError('Observation edits must be ascending, disjoint and inside the source');
    }
    out += source.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return out + source.slice(cursor);
}

/**
 * Maps an offset in the original source to the edited source; null when the
 * offset lies inside a replaced range. Lets a caller keep document mappings.
 */
export function mapOriginalOffset(
  edits: readonly ObservationEdit[],
  offset: number,
): number | null {
  let shift = 0;
  for (const edit of edits) {
    if (edit.end <= offset && !(edit.start === edit.end && edit.start === offset)) {
      shift += edit.text.length - (edit.end - edit.start);
    } else if (edit.start < offset && offset < edit.end) {
      return null;
    }
  }
  return offset + shift;
}
