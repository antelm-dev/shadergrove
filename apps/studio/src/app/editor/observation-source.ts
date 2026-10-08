import {
  applyObservationEdits,
  planObservationInsertion,
  sourceIdentity,
  type ObservationCatalogue,
  type ObservationPoint,
} from '@shadergrove/glsl-analysis';
import { expandMacros } from '@shadergrove/shared/glsl-export';
import { locate } from '@shadergrove/shared/project';

import type { CapturedAccepted } from '../rendering/render-inspection';
import type { ObservationRequest } from '../rendering/render-observation';
import { GENERATED_PREFIX } from './glsl-analysis-source';

/**
 * Where a catalogue point lives, and what is sent to the GPU for it — all from
 * the captured accepted program, never from the latest draft.
 *
 * The catalogue is verified against the prepared source: three.js's ESSL prefix
 * followed by the expanded accepted fragment. A point is offered only when its
 * exact UTF-16 offsets resolve to one original document line (the pass, Common
 * or a nested include), on a line `expandMacros` left untouched, in text the
 * accepted program really contains. Anything that cannot be placed that way is
 * refused with a reason, never guessed.
 */

export interface ObservationLocation {
  readonly docId: string;
  readonly docName: string;
  /** 1-based, in the original document. */
  readonly line: number;
  /** 1-based UTF-16 column of the variable's name. */
  readonly column: number;
}

export type MappingRefusal =
  /** The point sits in three.js's generated prefix or a line no document owns. */
  | 'generated'
  /** `expandMacros` rewrote the line, so offsets there do not belong to the document. */
  | 'rewritten'
  /** A `#line` directive makes line numbers mean something else. */
  | 'remapped'
  /** The accepted text at that place is not the variable the catalogue named. */
  | 'mismatch';

export interface MappedPoint {
  readonly point: ObservationPoint;
  readonly location: ObservationLocation;
}

export interface RefusedPoint {
  readonly point: ObservationPoint;
  readonly reason: MappingRefusal;
}

/** The exact text the analysis front end must be given for a captured accepted fragment. */
export function preparedFragment(accepted: CapturedAccepted): string | null {
  // The captured fragment is what three.js received; it must be the expansion of what the
  // documents compose to, or document lines would not describe it.
  return expandMacros(accepted.composedFragment) === accepted.fragment
    ? GENERATED_PREFIX.fragment + accepted.fragment
    : null;
}

const LINE_DIRECTIVE = /^\s*#\s*line\b/m;

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

/** Index of the last element <= `offset`. */
function lineOf(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Resolves every catalogue point of `accepted` to a document place, or says why it cannot. */
export function mapCatalogue(
  accepted: CapturedAccepted,
  catalogue: ObservationCatalogue,
): { mapped: MappedPoint[]; refused: RefusedPoint[] } {
  const mapped: MappedPoint[] = [];
  const refused: RefusedPoint[] = [];
  const source = preparedFragment(accepted);
  const identity = source === null ? null : sourceIdentity(source);
  if (
    source === null ||
    identity?.length !== catalogue.source.length ||
    identity.hash !== catalogue.source.hash
  ) {
    for (const point of catalogue.points) refused.push({ point, reason: 'mismatch' });
    return { mapped, refused };
  }

  const prefixLength = GENERATED_PREFIX.fragment.length;
  const composedLines = accepted.composedFragment.split('\n');
  const expandedLines = accepted.fragment.split('\n');
  const starts = lineStarts(accepted.fragment);
  const remapped = LINE_DIRECTIVE.test(accepted.composedFragment);

  for (const point of catalogue.points) {
    const refuse = (reason: MappingRefusal) => refused.push({ point, reason });
    // The statement, the name and the declarations inserted at the function's start must all be the user's.
    const offsets = [point.span.functionStart, point.span.statement.start, point.span.name.start];
    if (offsets.some((offset) => offset < prefixLength)) {
      refuse('generated');
      continue;
    }
    if (remapped) {
      refuse('remapped');
      continue;
    }
    const nameOffset = point.span.name.start - prefixLength;
    const index = lineOf(starts, nameOffset);
    const column = nameOffset - starts[index] + 1;
    const statementLine = lineOf(starts, point.span.statement.start - prefixLength);
    // Both ends of the statement stay on lines the documents own verbatim.
    const lastLine = lineOf(starts, point.span.insertAt - prefixLength);
    let rewritten = false;
    for (let at = Math.min(statementLine, index); at <= Math.max(lastLine, index); at++) {
      if (composedLines[at] !== expandedLines[at]) rewritten = true;
    }
    if (rewritten) {
      refuse('rewritten');
      continue;
    }
    const origin = locate(accepted.spans, index + 1);
    if (!origin) {
      refuse('generated');
      continue;
    }
    if (composedLines[index]?.slice(column - 1, column - 1 + point.name.length) !== point.name) {
      refuse('mismatch');
      continue;
    }
    mapped.push({
      point,
      location: { docId: origin.docId, docName: origin.docName, line: origin.line, column },
    });
  }
  return { mapped, refused };
}

export type BuildRefusal = 'source' | 'plan';

export type ObservationBuild =
  | {
      readonly ok: true;
      readonly programs: ObservationRequest['programs'];
      readonly prefix: string;
      readonly visitTarget: string;
    }
  | { readonly ok: false; readonly reason: BuildRefusal; readonly message: string };

const publishValue = (type: ObservationPoint['type'], value: string): string => {
  switch (type) {
    case 'float':
      return `vec4(${value}, 0.0, 0.0, 1.0)`;
    case 'vec2':
      return `vec4(${value}, 0.0, 1.0)`;
    case 'vec3':
      return `vec4(${value}, 1.0)`;
    case 'vec4':
      return value;
  }
};

/**
 * The three fragments one measurement draws, from the accepted source: the
 * insertion alone (so the output can be held against the original), the hit
 * marker, and the captured value. Only the declared edits are applied; the
 * original statement is never rewritten.
 */
export function buildObservation(
  accepted: CapturedAccepted,
  catalogue: ObservationCatalogue,
  point: ObservationPoint,
): ObservationBuild {
  const source = preparedFragment(accepted);
  if (source === null) {
    return {
      ok: false,
      reason: 'source',
      message: 'The captured fragment is not the expansion of its documents.',
    };
  }
  const plain = planObservationInsertion(source, catalogue, point.id);
  if (!plain.ok) return { ok: false, reason: 'plan', message: plain.message };
  const { identifiers } = plain.insertion;

  const strip = (text: string): string => text.slice(GENERATED_PREFIX.fragment.length);
  const apply = (publish?: string): string | null => {
    const planned =
      publish === undefined
        ? plain
        : planObservationInsertion(source, catalogue, point.id, { publish });
    if (!planned.ok) return null;
    const out = applyObservationEdits(source, planned.insertion.edits);
    // Every edit lies after the prefix; the fragment given to three.js is what follows it.
    return out.startsWith(GENERATED_PREFIX.fragment) ? strip(out) : null;
  };

  const preserved = apply();
  const hit = apply(`gl_FragColor = vec4(${identifiers.hit} ? 1.0 : 0.0, 0.0, 0.0, 1.0);`);
  const value = apply(`gl_FragColor = ${publishValue(point.type, identifiers.value)};`);
  if (preserved === null || hit === null || value === null) {
    return {
      ok: false,
      reason: 'plan',
      message: 'The insertion could not be planned with a verified entry point.',
    };
  }
  return {
    ok: true,
    programs: { preserved, hit, value },
    prefix: GENERATED_PREFIX.fragment,
    visitTarget: identifiers.visitTarget,
  };
}
