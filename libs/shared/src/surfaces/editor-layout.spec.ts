import { describe, expect, it } from 'vitest';

import {
  clampSplitRatio,
  commitSplitRatio,
  defaultEditorLayout,
  editorLeafIds,
  findAdjacentEditorLeaf,
  removeEditorLeaf,
  replaceEditorLeaf,
  sanitizeEditorLayout,
  splitEditorLeaf,
} from './editor-layout';
import { roundTripLayout } from './migration';
import { createDefaultSurface, sanitizeLayoutPreferences } from './sanitize';
import {
  asEditorGroupId,
  asSplitNodeId,
  DEFAULT_EDITOR_GROUP_ID,
  editorSurfaceId,
  SPLIT_RATIO_MAX,
  SPLIT_RATIO_MIN,
  type EditorLayoutNode,
  type EditorSplitNode,
  type SurfaceRecord,
} from './types';

const A = editorSurfaceId(DEFAULT_EDITOR_GROUP_ID);
const B = editorSurfaceId(asEditorGroupId('editor-group:b'));
const C = editorSurfaceId(asEditorGroupId('editor-group:c'));
const D = editorSurfaceId(asEditorGroupId('editor-group:d'));

const leaf = (surfaceId: typeof A) => ({ kind: 'leaf' as const, surfaceId });
const split = (
  id: string,
  first: EditorLayoutNode,
  second: EditorLayoutNode,
  axis: 'horizontal' | 'vertical' = 'horizontal',
  ratio = 0.5,
): EditorSplitNode => ({ kind: 'split', id: asSplitNodeId(id), axis, ratio, first, second });

function editor(groupId: string, open = true): SurfaceRecord {
  const group = asEditorGroupId(groupId);
  return createDefaultSurface('editor', {
    id: editorSurfaceId(group),
    open,
    chrome: { kind: 'editor', editorGroupId: group },
  });
}

/** A (first) | B above C (second). */
const THREE: EditorLayoutNode = split('s1', leaf(A), split('s2', leaf(B), leaf(C), 'vertical'));

const context = (ids = [A, B, C]) => ({ known: ids, required: ids, fallback: A });

describe('sanitizeEditorLayout', () => {
  it.each([[null], [undefined], [42], ['tree'], [[]], [{}], [{ kind: 'wat' }], [{ kind: 'leaf' }]])(
    'recovers corrupt input %j to the default leaf',
    (value) => {
      expect(sanitizeEditorLayout(value, { known: [A], required: [A], fallback: A })).toEqual(
        leaf(A),
      );
    },
  );

  it('keeps a valid tree untouched', () => {
    expect(sanitizeEditorLayout(THREE, context())).toEqual(THREE);
  });

  it('is idempotent and survives a JSON round-trip', () => {
    const messy = {
      kind: 'split',
      id: '',
      axis: 'diagonal',
      ratio: 'wide',
      first: { kind: 'split', id: 'x', first: leaf(A), second: leaf(A) },
      second: leaf(B),
    };
    const once = sanitizeEditorLayout(messy, context([A, B]));
    expect(sanitizeEditorLayout(once, context([A, B]))).toEqual(once);
    expect(sanitizeEditorLayout(JSON.parse(JSON.stringify(once)), context([A, B]))).toEqual(once);
  });

  it('defaults a bad axis and ratio and mints a deterministic split id', () => {
    const out = sanitizeEditorLayout(
      { kind: 'split', axis: 7, ratio: Number.NaN, first: leaf(A), second: leaf(B) },
      context([A, B]),
    );
    expect(out).toEqual(split('split:auto:0', leaf(A), leaf(B), 'horizontal', 0.5));
  });

  it('re-ids duplicate split ids deterministically', () => {
    const out = sanitizeEditorLayout(
      split('dup', split('dup', leaf(A), leaf(B)), leaf(C)),
      context(),
    ) as EditorSplitNode;
    // Ids are claimed children-first, so the inner split keeps 'dup'.
    expect((out.first as EditorSplitNode).id).toBe('dup');
    expect(out.id).toBe('split:auto:0');
  });

  it.each([
    [0, SPLIT_RATIO_MIN],
    [-3, SPLIT_RATIO_MIN],
    [0.05, SPLIT_RATIO_MIN],
    [0.35, 0.35],
    [0.95, SPLIT_RATIO_MAX],
    [Number.POSITIVE_INFINITY, 0.5],
    ['0.3', 0.5],
  ])('clamps ratio %j to %j', (ratio, expected) => {
    expect(clampSplitRatio(ratio)).toBe(expected);
    const out = sanitizeEditorLayout(
      { ...split('s', leaf(A), leaf(B)), ratio },
      context([A, B]),
    ) as EditorSplitNode;
    expect(out.ratio).toBe(expected);
  });

  it('repairs duplicate leaves, keeping the first occurrence', () => {
    const out = sanitizeEditorLayout(
      split('s1', leaf(A), split('s2', leaf(A), leaf(B))),
      context([A, B]),
    );
    expect(out).toEqual(split('s1', leaf(A), leaf(B)));
    expect(editorLeafIds(out)).toEqual([A, B]);
  });

  it('drops stale and unknown leaves and collapses their splits', () => {
    const out = sanitizeEditorLayout(
      split('s1', leaf(A), split('s2', leaf(D), leaf(B))),
      context([A, B]),
    );
    expect(out).toEqual(split('s1', leaf(A), leaf(B)));
  });

  it('collapses a split with a missing or invalid child', () => {
    expect(
      sanitizeEditorLayout(
        { kind: 'split', id: 's', first: leaf(B), second: { kind: 'leaf', surfaceId: 5 } },
        context([A, B]),
      ),
    ).toEqual(split('split:' + A, leaf(B), leaf(A)));
  });

  it('appends an open surface missing from the tree exactly once', () => {
    const out = sanitizeEditorLayout(leaf(A), context([A, B, C]));
    expect(editorLeafIds(out)).toEqual([A, B, C]);
    expect(sanitizeEditorLayout(out, context([A, B, C]))).toEqual(out);
  });

  it('keeps closed known editors but never requires them', () => {
    const closedKept = sanitizeEditorLayout(split('s', leaf(A), leaf(B)), {
      known: [A, B],
      required: [A],
      fallback: A,
    });
    expect(editorLeafIds(closedKept)).toEqual([A, B]);
    const closedNotAdded = sanitizeEditorLayout(leaf(A), {
      known: [A, B],
      required: [A],
      fallback: A,
    });
    expect(editorLeafIds(closedNotAdded)).toEqual([A]);
  });

  it('treats absurdly deep input as corrupt instead of overflowing', () => {
    let deep: unknown = leaf(B);
    for (let i = 0; i < 5000; i += 1) deep = { kind: 'split', first: deep, second: leaf(A) };
    const out = sanitizeEditorLayout(deep, context([A, B]));
    expect(editorLeafIds(out).sort()).toEqual([A, B].sort());
  });

  it('stays idempotent when repair would push a tree past the depth limit', () => {
    const ids = Array.from({ length: 18 }, (_, i) =>
      editorSurfaceId(asEditorGroupId(`editor-group:${i}`)),
    );
    // A left-leaning chain of depth 16 over 17 surfaces, with one more open editor to append.
    let chain: EditorLayoutNode = leaf(ids[0]!);
    for (let i = 1; i < 17; i += 1) chain = split(`s${i}`, chain, leaf(ids[i]!));
    const ctx = { known: ids, required: ids, fallback: ids[0]! };

    const once = sanitizeEditorLayout(chain, ctx);
    expect(editorLeafIds(once)).toEqual(ids);
    expect(sanitizeEditorLayout(once, ctx)).toEqual(once);
  });
});

describe('sanitizeLayoutPreferences editorLayout', () => {
  it('generates one default leaf when no tree is stored', () => {
    expect(sanitizeLayoutPreferences({ version: 1 }).editorLayout).toEqual(leaf(A));
  });

  it('keeps every open contained editor exactly once, even against a bad tree', () => {
    const layout = sanitizeLayoutPreferences({
      version: 2,
      surfaces: [editor('editor-group:default'), editor('editor-group:b')],
      zOrder: [],
      editorLayout: split('s', leaf(A), split('t', leaf(A), leaf(D))),
    });
    expect(editorLeafIds(layout.editorLayout).sort()).toEqual([A, B].sort());
  });

  it('never places a native editor surface in the tree', () => {
    const native = createDefaultSurface('editor', {
      id: B,
      chrome: { kind: 'editor', editorGroupId: asEditorGroupId('editor-group:b') },
      placement: { host: 'native', bounds: { x: 0, y: 0, width: 800, height: 600 } },
    });
    const layout = sanitizeLayoutPreferences({
      surfaces: [editor('editor-group:default'), native],
      editorLayout: split('s', leaf(A), leaf(B)),
    });
    expect(layout.editorLayout).toEqual(leaf(A));
  });

  it('round-trips a split layout through JSON unchanged', () => {
    const layout = sanitizeLayoutPreferences({
      surfaces: ['editor-group:default', 'editor-group:b', 'editor-group:c'].map((id) =>
        editor(id),
      ),
      editorLayout: THREE,
    });
    expect(layout.editorLayout).toEqual(THREE);
    expect(roundTripLayout(layout)).toEqual(layout);
  });
});

describe('splitEditorLeaf', () => {
  it('replaces the leaf with a split holding it first and the new leaf second', () => {
    const result = splitEditorLeaf(leaf(A), A, B, 'vertical');
    expect(result).toEqual({
      ok: true,
      layout: split(`split:${B}`, leaf(A), leaf(B), 'vertical'),
    });
  });

  it('splits a nested leaf and leaves the rest alone', () => {
    const result = splitEditorLeaf(THREE, C, D, 'horizontal', asSplitNodeId('s3'));
    expect(result).toEqual({
      ok: true,
      layout: split('s1', leaf(A), split('s2', leaf(B), split('s3', leaf(C), leaf(D)), 'vertical')),
    });
  });

  it('reports user-state failures instead of throwing', () => {
    expect(splitEditorLeaf(leaf(A), D, B, 'horizontal')).toEqual({
      ok: false,
      reason: 'unknown-leaf',
    });
    expect(splitEditorLeaf(THREE, A, B, 'horizontal')).toEqual({
      ok: false,
      reason: 'duplicate-surface',
    });
    expect(splitEditorLeaf(THREE, A, D, 'horizontal', asSplitNodeId('s2'))).toEqual({
      ok: false,
      reason: 'duplicate-split-id',
    });
  });

  it('does not mutate its input', () => {
    const before = JSON.stringify(THREE);
    splitEditorLeaf(THREE, A, D, 'vertical');
    expect(JSON.stringify(THREE)).toBe(before);
  });
});

describe('commitSplitRatio', () => {
  it('commits a clamped ratio to the named split only', () => {
    const result = commitSplitRatio(THREE, asSplitNodeId('s2'), 0.99);
    expect(result).toEqual({
      ok: true,
      layout: split('s1', leaf(A), split('s2', leaf(B), leaf(C), 'vertical', SPLIT_RATIO_MAX)),
    });
    const low = commitSplitRatio(THREE, asSplitNodeId('s1'), -1);
    expect(low.ok && (low.layout as EditorSplitNode).ratio).toBe(SPLIT_RATIO_MIN);
  });

  it('rejects non-finite ratios and unknown splits', () => {
    expect(commitSplitRatio(THREE, asSplitNodeId('s1'), Number.NaN)).toEqual({
      ok: false,
      reason: 'invalid-ratio',
    });
    expect(commitSplitRatio(THREE, asSplitNodeId('nope'), 0.5)).toEqual({
      ok: false,
      reason: 'unknown-split',
    });
  });
});

describe('findAdjacentEditorLeaf', () => {
  it('picks the nearest leaf of the sibling deterministically', () => {
    // A is a first child: merge into the first leaf of its sibling subtree.
    expect(findAdjacentEditorLeaf(THREE, A)).toEqual({ ok: true, surfaceId: B });
    // B is a first child inside s2: its sibling is C.
    expect(findAdjacentEditorLeaf(THREE, B)).toEqual({ ok: true, surfaceId: C });
    // C is a second child: merge into the last leaf of its sibling, B.
    expect(findAdjacentEditorLeaf(THREE, C)).toEqual({ ok: true, surfaceId: B });
  });

  it('merges a second child into the last leaf of a nested first sibling', () => {
    const tree = split('s1', split('s2', leaf(A), leaf(B)), leaf(C));
    expect(findAdjacentEditorLeaf(tree, C)).toEqual({ ok: true, surfaceId: B });
    expect(findAdjacentEditorLeaf(tree, A)).toEqual({ ok: true, surfaceId: B });
  });

  it('fails explicitly for a sole or unknown leaf', () => {
    expect(findAdjacentEditorLeaf(leaf(A), A)).toEqual({ ok: false, reason: 'sole-leaf' });
    expect(findAdjacentEditorLeaf(THREE, D)).toEqual({ ok: false, reason: 'unknown-leaf' });
  });
});

describe('removeEditorLeaf', () => {
  it('replaces the parent split with the sibling subtree', () => {
    expect(removeEditorLeaf(THREE, A)).toEqual({
      ok: true,
      layout: split('s2', leaf(B), leaf(C), 'vertical'),
    });
    expect(removeEditorLeaf(THREE, B)).toEqual({ ok: true, layout: split('s1', leaf(A), leaf(C)) });
  });

  it('rejects removing the last leaf or an unknown leaf', () => {
    expect(removeEditorLeaf(defaultEditorLayout(), A)).toEqual({ ok: false, reason: 'last-leaf' });
    expect(removeEditorLeaf(THREE, D)).toEqual({ ok: false, reason: 'unknown-leaf' });
  });

  it('collapses down to a single leaf after repeated removals', () => {
    const first = removeEditorLeaf(THREE, A);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = removeEditorLeaf(first.layout, B);
    expect(second).toEqual({ ok: true, layout: leaf(C) });
  });
});

describe('replaceEditorLeaf', () => {
  it('swaps one leaf and keeps geometry', () => {
    expect(replaceEditorLeaf(THREE, C, D)).toEqual({
      ok: true,
      layout: split('s1', leaf(A), split('s2', leaf(B), leaf(D), 'vertical')),
    });
  });

  it('rejects unknown targets and duplicate replacements', () => {
    expect(replaceEditorLeaf(THREE, D, C)).toEqual({ ok: false, reason: 'unknown-leaf' });
    expect(replaceEditorLeaf(THREE, A, B)).toEqual({ ok: false, reason: 'duplicate-surface' });
    expect(replaceEditorLeaf(THREE, A, A)).toEqual({ ok: true, layout: THREE });
  });
});
