import type { ShaderControl, ShaderParams } from './controls';
import type { RenderSettings } from './render';
import type {
  TextureChannelPayloads,
  TextureChannels,
  ThumbnailMeta,
  ThumbnailPayload,
} from './textures';
import type { ShaderProject } from '../project/types';

/**
 * Format tag written into every exported bundle. Bump on a breaking change.
 *
 * Bumped from v3 to v4 because effects gained an `instanceId` and a `custom`
 * type that embeds GLSL: an app that only knows v3 must refuse such a bundle
 * rather than silently drop its custom effects. v1–v3 are still accepted on
 * import — `validateRender` gives their effects the ids they would always
 * have had (see `legacyInstanceId`).
 */
export const BUNDLE_FORMAT = 'shader-studio/v4';

/**
 * Effects as an ordered chain, without instance ids or custom effects. Still
 * accepted on import.
 */
export const LEGACY_BUNDLE_FORMAT_V3 = 'shader-studio/v3';

/**
 * The format between v1 and v3: has a `project` field, but `render` is still
 * the pre-chain `{ bloom }` object. Still accepted on import for the same
 * reason v1 is.
 */
export const LEGACY_BUNDLE_FORMAT_V2 = 'shader-studio/v2';

/**
 * The previous bundle format, from before a shader's project (its buffers,
 * Common pass, files and channel wiring) was part of the payload. Still
 * accepted on import — `validateShaderPayload` synthesizes a `project` for one
 * via `migrateLegacyProject`, the same way a pre-project shader on disk does.
 */
export const LEGACY_BUNDLE_FORMAT = 'shader-studio/v1';

export interface Preset {
  id: string;
  name: string;
  createdAt: string;
  values: ShaderParams;
  render?: RenderSettings;
}

/**
 * `shader` is a document in your own library. `template` is a bundled example:
 * everyone can read one, nobody can write to one, and editing it produces a
 * copy you own. It is a marker, never the absence of an owner — an unowned row
 * does not exist.
 */
export type ShaderKind = 'shader' | 'template';

export interface ShaderMeta {
  id: string;
  kind: ShaderKind;
  name: string;
  description: string;
  author?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Optimistic-concurrency counter. Starts at 1 on create and increments on
   * every edit; a save may pass the revision it read as `expectedRevision` to
   * be told (409) when someone else has written since. Not part of an exported
   * bundle — an imported shader always starts fresh at 1.
   */
  revision: number;
  controls: ShaderControl[];
  render: RenderSettings;
  channels: TextureChannels;
  thumbnail: ThumbnailMeta | null;
}

export interface ShaderRecord extends ShaderMeta {
  fragment: string;
  vertex: string;
  presets: Preset[];
  /**
   * The multi-pass document this shader is: buffers, Common, plain files and
   * channel wiring. `fragment`/`vertex` above stay in sync with it — they are
   * the Image pass's source and the project's vertex shader, mirrored for
   * anything that still reads the old two-string shape.
   */
  project: ShaderProject;
}

/**
 * Why a history entry exists. `baseline` is the pre-feature state captured just
 * before a shader's first versioned mutation; `sync` is a whole-shader replace
 * from a bundle.
 */
export type ShaderHistoryCause =
  | 'create'
  | 'import'
  | 'duplicate'
  | 'baseline'
  | 'update'
  | 'preset-save'
  | 'preset-delete'
  | 'sync'
  | 'restore';

/**
 * One immutable saved state of a shader's document (`project`, controls, render
 * settings and presets), keyed by the shader's persisted `revision`. Revisions
 * may have gaps: a texture, channel, metadata or thumbnail write bumps the
 * counter without a history entry. Only `checkpointName` ever changes.
 */
export interface ShaderHistoryEntry {
  revision: number;
  createdAt: string;
  cause: ShaderHistoryCause;
  /** A user-given name; named entries are never pruned. */
  checkpointName: string | null;
  /** The entry a `restore` copied from; `null` for every other cause. */
  restoredFromRevision: number | null;
}

export interface ShaderSummary {
  id: string;
  kind: ShaderKind;
  name: string;
  description: string;
  updatedAt: string;
  /** Same as `ShaderMeta.revision` — lets a sync client spot a change without reading the record. */
  revision: number;
  controlCount: number;
  presetCount: number;
  thumbnail: ThumbnailMeta | null;
}

export interface ShaderPayload {
  id: string;
  name: string;
  description: string;
  author?: string;
  controls: ShaderControl[];
  render: RenderSettings;
  fragment: string;
  vertex: string;
  presets: Preset[];
  channels: TextureChannelPayloads;
  thumbnail: ThumbnailPayload | null;
  /** Same role as `ShaderRecord.project` — what makes a bundle lossless. */
  project: ShaderProject;
}

export interface ShaderBundle {
  format: typeof BUNDLE_FORMAT;
  kind: 'shader';
  exportedAt: string;
  shader: ShaderPayload;
}

export interface CollectionBundle {
  format: typeof BUNDLE_FORMAT;
  kind: 'collection';
  exportedAt: string;
  shaders: ShaderPayload[];
}

export type Bundle = ShaderBundle | CollectionBundle;

export type ImportMode = 'rename' | 'overwrite';

export interface ImportResult {
  imported: { id: string; name: string; replaced: boolean }[];
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: string[];
  };
}

export function toSummary(record: ShaderRecord): ShaderSummary {
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    description: record.description,
    updatedAt: record.updatedAt,
    revision: record.revision,
    controlCount: record.controls.length,
    presetCount: record.presets.length,
    thumbnail: record.thumbnail,
  };
}

/**
 * Metadata-only conversion — `channels[n].data` and `thumbnail` are always
 * `null` here since this function never touches the filesystem. Callers that
 * need the actual image bytes (export, or a same-process copy) fill them in
 * afterwards.
 */
export function toPayload(record: ShaderRecord): ShaderPayload {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    ...(record.author ? { author: record.author } : {}),
    controls: record.controls,
    render: record.render,
    fragment: record.fragment,
    vertex: record.vertex,
    presets: record.presets,
    channels: record.channels.map((channel) => ({
      ...channel,
      data: null,
    })) as unknown as TextureChannelPayloads,
    thumbnail: null,
    project: record.project,
  };
}
