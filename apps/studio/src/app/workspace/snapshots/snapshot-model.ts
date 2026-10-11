import type { ShaderControl, ShaderParams, TextureChannels } from '@shadergrove/shared/model';
import { sanitizeParams } from '@shadergrove/shared/validate';

import type { ShaderDraft } from '../state/document-state';
import { parseControls } from '../state/controls-schema';

/**
 * One pinned moment of a shader's session: the source, controls, values and
 * render settings the user had, plus the frame they were looking at.
 *
 * Deep-frozen and held in memory only. Texture bytes, the library thumbnail and
 * shader metadata (name, description, presets) are deliberately not captured:
 * `channels` is the slot metadata, so a restore can never touch a texture.
 */
export interface SessionSnapshot {
  readonly id: string;
  readonly shaderId: string;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  /** The record's revision when the snapshot was taken. */
  readonly revision: number;
  readonly draft: Readonly<ShaderDraft>;
  readonly params: Readonly<ShaderParams>;
  readonly channels: TextureChannels;
  /** PNG at drawing-buffer size, for compare. */
  readonly frame: Blob;
  /** Object URL of the 240×135 thumbnail; revoked when the snapshot is dropped. */
  readonly thumbnailUrl: string;
  readonly label?: string;
}

/** The live state a snapshot is measured against. */
export interface SnapshotSubject {
  readonly draft: Readonly<ShaderDraft>;
  readonly params: Readonly<ShaderParams>;
}

export interface RestoreSubject extends SnapshotSubject {
  /** The controls the live state is using; the fallback when the snapshot's own config does not parse. */
  readonly controls: readonly ShaderControl[];
}

export interface RestorePlan {
  /** A fresh, mutable copy: `patchDraft` hands it straight to the editor. */
  readonly draftPatch: ShaderDraft;
  readonly params: ShaderParams;
}

/**
 * What applying `snapshot` would write. Pure: the caller applies `draftPatch`
 * through `patchDraft` and `params` through the validated params path.
 *
 * Params are re-validated against the snapshot's own controls, because that is
 * the schema the restored draft will be using.
 */
export function planRestore(snapshot: SessionSnapshot, current: RestoreSubject): RestorePlan {
  const controls = parseControls(snapshot.draft.controlsText) ?? current.controls;
  return {
    draftPatch: structuredClone({
      project: snapshot.draft.project,
      controlsText: snapshot.draft.controlsText,
      render: snapshot.draft.render,
    }),
    params: sanitizeParams(controls, snapshot.params),
  };
}

/**
 * Whether the live state is anything other than what `snapshot` holds.
 *
 * Project and render are compared the way `DocumentState.dirty` compares them;
 * params are compared key by key, since their insertion order is not meaningful.
 */
export function differs(snapshot: SnapshotSubject, current: SnapshotSubject): boolean {
  return (
    snapshot.draft.controlsText !== current.draft.controlsText ||
    JSON.stringify(snapshot.draft.project) !== JSON.stringify(current.draft.project) ||
    JSON.stringify(snapshot.draft.render) !== JSON.stringify(current.draft.render) ||
    !sameParams(snapshot.params, current.params)
  );
}

/** True when restoring would lose the live state: no existing snapshot holds it. */
export function needsSafetySnapshot(
  current: SnapshotSubject,
  snapshots: readonly SnapshotSubject[],
): boolean {
  return snapshots.every((snapshot) => differs(snapshot, current));
}

function sameParams(a: Readonly<ShaderParams>, b: Readonly<ShaderParams>): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
  );
}
