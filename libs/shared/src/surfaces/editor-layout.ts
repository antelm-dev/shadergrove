/**
 * Pure contained-editor split tree: sanitization and immutable mutations.
 * Framework-free. User-state errors return explicit failure results; nothing
 * here throws for malformed input.
 */

import { clamp, finite, oneOf } from '../geometry';
import {
  asSplitNodeId,
  asSurfaceId,
  DEFAULT_EDITOR_GROUP_ID,
  DEFAULT_SPLIT_RATIO,
  editorSurfaceId,
  SPLIT_AXES,
  SPLIT_RATIO_MAX,
  SPLIT_RATIO_MIN,
  type EditorLayoutNode,
  type EditorLeafNode,
  type EditorSplitNode,
  type SplitAxis,
  type SplitNodeId,
  type SurfaceId,
} from './types';

/** Untrusted input deeper than this is treated as corrupt and collapsed. */
const MAX_DEPTH = 16;

export type EditorLayoutResult<Reason extends string> =
  | { ok: true; layout: EditorLayoutNode }
  | { ok: false; reason: Reason };

export function createEditorLeaf(surfaceId: SurfaceId): EditorLeafNode {
  return { kind: 'leaf', surfaceId };
}

/** The layout every workspace starts from: one leaf for the default editor group. */
export function defaultEditorLayout(
  surfaceId: SurfaceId = editorSurfaceId(DEFAULT_EDITOR_GROUP_ID),
): EditorLayoutNode {
  return createEditorLeaf(surfaceId);
}

export function clampSplitRatio(value: unknown): number {
  const ratio = finite(value);
  return ratio === null ? DEFAULT_SPLIT_RATIO : clamp(ratio, SPLIT_RATIO_MIN, SPLIT_RATIO_MAX);
}

/** Leaf surface ids in reading order (first child before second). */
export function editorLeafIds(node: EditorLayoutNode): SurfaceId[] {
  return node.kind === 'leaf'
    ? [node.surfaceId]
    : [...editorLeafIds(node.first), ...editorLeafIds(node.second)];
}

export function editorSplitIds(node: EditorLayoutNode): SplitNodeId[] {
  return node.kind === 'leaf'
    ? []
    : [node.id, ...editorSplitIds(node.first), ...editorSplitIds(node.second)];
}

export function hasEditorLeaf(node: EditorLayoutNode, surfaceId: SurfaceId): boolean {
  return node.kind === 'leaf'
    ? node.surfaceId === surfaceId
    : hasEditorLeaf(node.first, surfaceId) || hasEditorLeaf(node.second, surfaceId);
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Keep a valid unique id; otherwise mint the next free `split:auto:N`, deterministically. */
function claimSplitId(value: unknown, usedIds: Set<string>): SplitNodeId {
  let id = typeof value === 'string' && value.length > 0 ? value : '';
  for (let n = 0; id === '' || usedIds.has(id); n += 1) id = `split:auto:${n}`;
  usedIds.add(id);
  return asSplitNodeId(id);
}

/** Structure only: shape, axis, ratio, split-id uniqueness. Surface membership is a later pass. */
function parseNode(value: unknown, depth: number, usedIds: Set<string>): EditorLayoutNode | null {
  if (depth > MAX_DEPTH) return null;
  const input = asRecord(value);

  if (input['kind'] === 'leaf') {
    const id = input['surfaceId'];
    return typeof id === 'string' && id.length > 0 ? createEditorLeaf(asSurfaceId(id)) : null;
  }
  if (input['kind'] !== 'split') return null;

  const first = parseNode(input['first'], depth + 1, usedIds);
  const second = parseNode(input['second'], depth + 1, usedIds);
  // A split missing a child collapses to the surviving child.
  if (!first || !second) return first ?? second;

  return {
    kind: 'split',
    id: claimSplitId(input['id'], usedIds),
    axis: oneOf<SplitAxis>(input['axis'], SPLIT_AXES, 'horizontal'),
    ratio: clampSplitRatio(input['ratio']),
    first,
    second,
  };
}

/** Drop leaves that are unknown or repeated, collapsing splits that lose a child. */
function pruneNode(
  node: EditorLayoutNode,
  known: ReadonlySet<SurfaceId>,
  seen: Set<SurfaceId>,
): EditorLayoutNode | null {
  if (node.kind === 'leaf') {
    if (!known.has(node.surfaceId) || seen.has(node.surfaceId)) return null;
    seen.add(node.surfaceId);
    return node;
  }
  const first = pruneNode(node.first, known, seen);
  const second = pruneNode(node.second, known, seen);
  if (!first || !second) return first ?? second;
  return { ...node, first, second };
}

function appendLeaf(
  root: EditorLayoutNode,
  surfaceId: SurfaceId,
  usedIds: Set<string>,
): EditorSplitNode {
  return {
    kind: 'split',
    id: claimSplitId(`split:${surfaceId}`, usedIds),
    axis: 'horizontal',
    ratio: DEFAULT_SPLIT_RATIO,
    first: root,
    second: createEditorLeaf(surfaceId),
  };
}

export interface EditorLayoutContext {
  /** Contained editor surfaces that may be leaves (open or closed). */
  known: readonly SurfaceId[];
  /** Open contained editor surfaces: each must appear in the tree exactly once. */
  required: readonly SurfaceId[];
  /** Sole leaf when nothing else survives; must be a known editor surface. */
  fallback: SurfaceId;
}

/**
 * Repair an untrusted tree against the surfaces that actually exist.
 * Deterministic and idempotent: malformed, duplicate, stale or empty input
 * yields a valid tree; every required surface appears exactly once (a missing
 * one is appended as a right-hand sibling at the root).
 */
export function sanitizeEditorLayout(
  value: unknown,
  context: EditorLayoutContext,
): EditorLayoutNode {
  const known = new Set(context.known);
  const parsed = parseNode(value, 0, new Set());
  const seen = new Set<SurfaceId>();
  let root = parsed ? pruneNode(parsed, known, seen) : null;

  const usedIds = new Set<string>(root ? editorSplitIds(root) : []);
  for (const surfaceId of context.required) {
    if (seen.has(surfaceId)) continue;
    seen.add(surfaceId);
    root = root ? appendLeaf(root, surfaceId, usedIds) : createEditorLeaf(surfaceId);
  }

  if (!root) return createEditorLeaf(context.fallback);
  // Appending can push a tree past what the parser accepts; a balanced rebuild
  // keeps the next pass from truncating it again, so repair stays idempotent.
  return editorLayoutDepth(root) > MAX_DEPTH ? balancedLayout(editorLeafIds(root)) : root;
}

function editorLayoutDepth(node: EditorLayoutNode): number {
  return node.kind === 'leaf'
    ? 0
    : 1 + Math.max(editorLayoutDepth(node.first), editorLayoutDepth(node.second));
}

function balancedLayout(
  leaves: readonly SurfaceId[],
  usedIds = new Set<string>(),
): EditorLayoutNode {
  if (leaves.length === 1) return createEditorLeaf(leaves[0]!);
  const middle = Math.ceil(leaves.length / 2);
  return {
    kind: 'split',
    id: claimSplitId('', usedIds),
    axis: 'horizontal',
    ratio: DEFAULT_SPLIT_RATIO,
    first: balancedLayout(leaves.slice(0, middle), usedIds),
    second: balancedLayout(leaves.slice(middle), usedIds),
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export type SplitLeafFailure = 'unknown-leaf' | 'duplicate-surface' | 'duplicate-split-id';

/**
 * Replace a leaf with a split holding the original leaf first and the new
 * leaf second, at the default ratio. `splitId` defaults to `split:<newSurfaceId>`.
 */
export function splitEditorLeaf(
  root: EditorLayoutNode,
  target: SurfaceId,
  newSurfaceId: SurfaceId,
  axis: SplitAxis,
  splitId: SplitNodeId = asSplitNodeId(`split:${newSurfaceId}`),
): EditorLayoutResult<SplitLeafFailure> {
  if (!hasEditorLeaf(root, target)) return { ok: false, reason: 'unknown-leaf' };
  if (hasEditorLeaf(root, newSurfaceId)) return { ok: false, reason: 'duplicate-surface' };
  if (editorSplitIds(root).includes(splitId)) return { ok: false, reason: 'duplicate-split-id' };

  const rewrite = (node: EditorLayoutNode): EditorLayoutNode => {
    if (node.kind === 'leaf') {
      return node.surfaceId === target
        ? {
            kind: 'split',
            id: splitId,
            axis,
            ratio: DEFAULT_SPLIT_RATIO,
            first: node,
            second: createEditorLeaf(newSurfaceId),
          }
        : node;
    }
    return { ...node, first: rewrite(node.first), second: rewrite(node.second) };
  };
  return { ok: true, layout: rewrite(root) };
}

export type CommitRatioFailure = 'unknown-split' | 'invalid-ratio';

/** Store a committed resize. The ratio is clamped so both children stay usable. */
export function commitSplitRatio(
  root: EditorLayoutNode,
  splitId: SplitNodeId,
  ratio: number,
): EditorLayoutResult<CommitRatioFailure> {
  if (finite(ratio) === null) return { ok: false, reason: 'invalid-ratio' };
  if (!editorSplitIds(root).includes(splitId)) return { ok: false, reason: 'unknown-split' };

  const next = clampSplitRatio(ratio);
  const rewrite = (node: EditorLayoutNode): EditorLayoutNode =>
    node.kind === 'leaf'
      ? node
      : {
          ...node,
          ...(node.id === splitId ? { ratio: next } : {}),
          first: rewrite(node.first),
          second: rewrite(node.second),
        };
  return { ok: true, layout: rewrite(root) };
}

export type AdjacentLeafFailure = 'unknown-leaf' | 'sole-leaf';

/** Leaf of a sibling subtree that touches the shared edge. */
function edgeLeaf(node: EditorLayoutNode, side: 'first' | 'second'): SurfaceId {
  return node.kind === 'leaf' ? node.surfaceId : edgeLeaf(node[side], side);
}

function adjacentLeaf(node: EditorLayoutNode, surfaceId: SurfaceId): SurfaceId | null {
  if (node.kind === 'leaf') return null;
  const inFirst = hasEditorLeaf(node.first, surfaceId);
  const inner = adjacentLeaf(inFirst ? node.first : node.second, surfaceId);
  if (inner) return inner;
  // The leaf is this split's direct child: merge toward its sibling's nearest edge.
  return inFirst ? edgeLeaf(node.second, 'first') : edgeLeaf(node.first, 'second');
}

/**
 * Deterministic merge target for closing a leaf: a first child merges into the
 * first leaf of its sibling, a second child into the last leaf of its sibling.
 */
export function findAdjacentEditorLeaf(
  root: EditorLayoutNode,
  surfaceId: SurfaceId,
): { ok: true; surfaceId: SurfaceId } | { ok: false; reason: AdjacentLeafFailure } {
  if (!hasEditorLeaf(root, surfaceId)) return { ok: false, reason: 'unknown-leaf' };
  const target = adjacentLeaf(root, surfaceId);
  return target ? { ok: true, surfaceId: target } : { ok: false, reason: 'sole-leaf' };
}

export type RemoveLeafFailure = 'unknown-leaf' | 'last-leaf';

/** Remove a leaf; its parent split is replaced by the sibling subtree. */
export function removeEditorLeaf(
  root: EditorLayoutNode,
  surfaceId: SurfaceId,
): EditorLayoutResult<RemoveLeafFailure> {
  if (!hasEditorLeaf(root, surfaceId)) return { ok: false, reason: 'unknown-leaf' };
  if (root.kind === 'leaf') return { ok: false, reason: 'last-leaf' };

  const remove = (node: EditorLayoutNode): EditorLayoutNode | null => {
    if (node.kind === 'leaf') return node.surfaceId === surfaceId ? null : node;
    const first = remove(node.first);
    const second = remove(node.second);
    return !first || !second ? (first ?? second) : { ...node, first, second };
  };
  const layout = remove(root);
  return layout ? { ok: true, layout } : { ok: false, reason: 'last-leaf' };
}

export type ReplaceLeafFailure = 'unknown-leaf' | 'duplicate-surface';

/** Point a leaf at a different surface, keeping every split and ratio. */
export function replaceEditorLeaf(
  root: EditorLayoutNode,
  surfaceId: SurfaceId,
  replacement: SurfaceId,
): EditorLayoutResult<ReplaceLeafFailure> {
  if (!hasEditorLeaf(root, surfaceId)) return { ok: false, reason: 'unknown-leaf' };
  if (replacement !== surfaceId && hasEditorLeaf(root, replacement)) {
    return { ok: false, reason: 'duplicate-surface' };
  }

  const rewrite = (node: EditorLayoutNode): EditorLayoutNode =>
    node.kind === 'leaf'
      ? node.surfaceId === surfaceId
        ? createEditorLeaf(replacement)
        : node
      : { ...node, first: rewrite(node.first), second: rewrite(node.second) };
  return { ok: true, layout: rewrite(root) };
}
