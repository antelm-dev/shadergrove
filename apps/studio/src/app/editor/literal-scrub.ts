/**
 * Alt-drag scrubbing of numeric literals in GLSL source: which literal is under
 * the pointer, how far one step moves it, and how the new value is written back.
 *
 * Pure on purpose — no Monaco import. The caller tokenizes (so comments and
 * strings are known) and applies the edit; any editor can reuse the rules.
 */

/** A token as Monaco's `tokenize` reports it: where it starts on the line, and its type. */
export interface LineToken {
  readonly offset: number;
  readonly type: string;
}

export interface ScrubLiteral {
  /** 1-based, inclusive; covers the unary minus when there is one. */
  readonly startColumn: number;
  /** 1-based, exclusive. */
  readonly endColumn: number;
  /** The text the range covers, sign and suffix included. */
  readonly text: string;
  readonly kind: 'float' | 'int';
  readonly decimals: number;
  /** `f`, `F`, `u`, `U`, or empty. */
  readonly suffix: string;
  /** Whether a unary minus belongs to the literal. */
  readonly signed: boolean;
  /**
   * Whether the value may not go below zero: an unsigned literal, or one written
   * straight after a binary minus, where a sign would make `a --1.0`.
   */
  readonly nonNegative: boolean;
}

export interface ScrubModifiers {
  readonly shift?: boolean;
  readonly ctrl?: boolean;
}

/** Horizontal pixels per step. */
export const SCRUB_PIXELS_PER_STEP = 4;

const LITERAL = /^(\d*\.\d+|\d+)([fFuU]?)$/;
const IDENTIFIER_CHAR = /[A-Za-z_]/;
/** What may precede a minus for it to be unary; `undefined` is the start of the line. */
const UNARY_CONTEXT = new Set([...'+-*/%<>=!&|^~?:(,[{;']);

/**
 * The scrubbable literal at a 1-based `column` of `lineText`, or null.
 *
 * `column` is a caret position, so a pointer on a literal's right half reports
 * the column after it; the character on either side of the caret is tried.
 */
export function findScrubbableLiteral(
  lineText: string,
  column: number,
  tokens: readonly LineToken[],
): ScrubLiteral | null {
  if (/^\s*#/.test(lineText)) return null;

  for (const index of [column - 1, column - 2]) {
    const literal = literalAt(lineText, index, tokens);
    if (literal) return literal;
  }
  return null;
}

function literalAt(lineText: string, index: number, tokens: readonly LineToken[]) {
  if (index < 0 || index >= lineText.length) return null;

  const at = tokenAt(tokens, index);
  if (at < 0 || !/^number(\.float)?(\.|$)/.test(tokens[at].type)) return null;

  const start = tokens[at].offset;
  const end = tokens[at + 1]?.offset ?? lineText.length;
  const body = lineText.slice(start, end);

  const match = LITERAL.exec(body);
  if (!match) return null; // exponents, and anything the tokenizer reads differently
  const [, digits, suffix] = match;
  const kind = digits.includes('.') ? 'float' : 'int';
  if (kind === 'float' && /[uU]/.test(suffix)) return null;
  // A leading zero makes an integer octal in GLSL: `010` is 8, and scrubbing it as 10 would lie.
  if (kind === 'int' && /^0\d/.test(digits)) return null;

  if (IDENTIFIER_CHAR.test(lineText[start - 1] ?? '')) return null;
  if (IDENTIFIER_CHAR.test(lineText[end] ?? '')) return null;

  const minus = lineText[start - 1] === '-';
  const signed = minus && isUnaryContext(lineText, start - 1, tokens);
  const from = signed ? start - 1 : start;

  return {
    startColumn: from + 1,
    endColumn: end + 1,
    text: lineText.slice(from, end),
    kind,
    decimals: kind === 'float' ? digits.length - digits.indexOf('.') - 1 : 0,
    suffix,
    signed,
    nonNegative: /[uU]/.test(suffix) || (minus && !signed),
  } satisfies ScrubLiteral;
}

/** The index of the token covering `index`, or -1. */
function tokenAt(tokens: readonly LineToken[], index: number): number {
  let at = -1;
  while (at + 1 < tokens.length && tokens[at + 1].offset <= index) at++;
  return at;
}

/** A minus is unary after an operator, an opening bracket, a separator, a keyword (`return -1.0`) or nothing. */
function isUnaryContext(
  lineText: string,
  minusIndex: number,
  tokens: readonly LineToken[],
): boolean {
  const before = lineText.slice(0, minusIndex).trimEnd();
  if (before === '' || UNARY_CONTEXT.has(before[before.length - 1])) return true;
  const at = tokenAt(tokens, before.length - 1);
  return at >= 0 && /^keyword(\.|$)/.test(tokens[at].type);
}

/** The literal's current value, sign included and suffix ignored. */
export function literalValue(literal: ScrubLiteral): number {
  return Number(literal.text.slice(0, literal.text.length - literal.suffix.length));
}

/**
 * One step for a literal and the decimals to write it with: `10^-decimals` for
 * a float, 1 for an integer; Shift ×10, Ctrl ÷10 (one more decimal). An integer
 * stays an integer, so Ctrl cannot make its step finer than 1.
 */
export function scrubStep(
  literal: ScrubLiteral,
  modifiers: ScrubModifiers = {},
): { step: number; decimals: number } {
  let decimals = literal.decimals;
  if (modifiers.ctrl && literal.kind === 'float') decimals += 1;
  const exponent = -decimals + (modifiers.shift ? 1 : 0);
  return { step: Number((10 ** exponent).toPrecision(12)), decimals };
}

/** Values beyond this would print with an exponent. */
const MAX_MAGNITUDE = 1e20;

/**
 * The literal's text for a new value, keeping its kind, its suffix and (unless
 * told otherwise) its decimal count. Never an exponent, `NaN` or `Infinity`.
 */
export function formatScrubbed(
  literal: ScrubLiteral,
  value: number,
  decimals = literal.decimals,
): string {
  let clean = Number.isFinite(value) ? Number(value.toPrecision(12)) : 0;
  clean = Math.min(MAX_MAGNITUDE, Math.max(-MAX_MAGNITUDE, clean));
  if (literal.nonNegative) clean = Math.max(0, clean);

  const places = literal.kind === 'float' ? Math.max(1, decimals) : 0;
  // `|| 0` turns -0 into 0, so a value that rounds to zero is never written `-0.0`.
  const rounded = Number(clean.toFixed(places)) || 0;
  return rounded.toFixed(places) + literal.suffix;
}
