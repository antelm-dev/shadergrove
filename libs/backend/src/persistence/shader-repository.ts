/**
 * The storage contract every SQL engine implements. It is deliberately shaped
 * around the shader domain — insert a shader, replace its presets, put an asset,
 * bump a revision — rather than exposing raw SQL. All the logic that decides
 * *what* to write lives one level up, in `ShaderLibrary`; a repository only
 * knows how to persist and fetch the rows the library hands it, and how to run a
 * transaction so a shader and its dependents move together.
 *
 * Row DTOs carry pre-serialized JSON (`*_json`) exactly as it is stored, so the
 * engines never need to know the project/controls/render/channels shapes. The
 * library owns every conversion between these rows and the public model.
 */

/** The four channel slots plus the preview, as stored in the `assets` table. */
import type { ShaderHistoryCause } from '@shadergrove/shared/model';

import type { ShaderKind, UserScope } from './user-scope';

export type AssetKey = 'thumbnail' | 'texture:0' | 'texture:1' | 'texture:2' | 'texture:3';

export const TEXTURE_ASSET_KEYS = [
  'texture:0',
  'texture:1',
  'texture:2',
  'texture:3',
] as const satisfies readonly AssetKey[];

export const THUMBNAIL_ASSET_KEY: AssetKey = 'thumbnail';

export function textureAssetKey(channel: number): AssetKey {
  return `texture:${channel}` as AssetKey;
}

/** A `shaders` row. `project_json` is the source of truth; fragment/vertex are derived. */
export interface ShaderRow {
  id: string;
  /** Set from the caller's scope on insert, never from request input. */
  ownerUserId: string;
  kind: ShaderKind;
  name: string;
  description: string;
  author: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
  projectJson: string;
  controlsJson: string;
  renderJson: string;
  channelsJson: string;
}

/** The mutable columns of a shader — everything an update may rewrite except id/createdAt/revision. */
export interface ShaderMutableFields {
  name: string;
  description: string;
  author: string | null;
  updatedAt: string;
  projectJson: string;
  controlsJson: string;
  renderJson: string;
  channelsJson: string;
}

export interface PresetRow {
  id: string;
  name: string;
  createdAt: string;
  valuesJson: string;
  renderJson: string | null;
}

/** A `shader_history` row without its content — what a timeline lists. */
export interface HistoryEntryRow {
  revision: number;
  createdAt: string;
  cause: ShaderHistoryCause;
  checkpointName: string | null;
  restoredFromRevision: number | null;
}

/** A full `shader_history` row: the entry plus the serialized document it froze. */
export interface HistoryRow extends HistoryEntryRow {
  projectJson: string;
  controlsJson: string;
  renderJson: string;
  /** The `Preset[]` of the public model, serialized. */
  presetsJson: string;
}

/** Asset metadata without the bytes — enough to describe presence and dimensions. */
export interface AssetMeta {
  key: AssetKey;
  extension: string;
  width: number | null;
  height: number | null;
  updatedAt: string;
}

export interface StoredAsset extends AssetMeta {
  data: Uint8Array;
}

/** A shader and its dependents as they exist in the database, bytes excluded. */
export interface StoredShader {
  row: ShaderRow;
  presets: PresetRow[];
  /** Metadata for every asset the shader has; bytes fetched separately via `loadAsset`. */
  assets: AssetMeta[];
}

/** A lightweight listing row — no project/render/channels JSON, no asset bytes. */
export interface ShaderSummaryRow {
  id: string;
  kind: ShaderKind;
  name: string;
  description: string;
  updatedAt: string;
  revision: number;
  controlCount: number;
  presetCount: number;
  thumbnail: { extension: string; updatedAt: string } | null;
}

/**
 * The operations available inside a transaction. Every method runs on the one
 * connection the surrounding `transaction()` holds, so a shader, its presets and
 * its assets commit or roll back as a unit.
 */
export interface ShaderTx {
  listIds(scope: UserScope): Promise<string[]>;
  loadShader(scope: UserScope, id: string): Promise<StoredShader | null>;
  loadAsset(scope: UserScope, id: string, key: AssetKey): Promise<StoredAsset | null>;
  insertShader(row: ShaderRow): Promise<void>;
  /**
   * Rewrites the mutable columns and bumps `revision`. When `expectedRevision`
   * is given and no longer matches the stored revision, throws a `conflict`
   * `StorageError` rather than clobbering a concurrent write. Returns the new
   * revision.
   */
  updateShader(
    scope: UserScope,
    id: string,
    fields: ShaderMutableFields,
    expectedRevision?: number,
  ): Promise<number>;
  /**
   * Deletes a shader the scope owns; returns whether a row went. When
   * `expectedRevision` is given, deletes only at that revision; when
   * `expectedThumbnail` is given, only while the thumbnail's `updatedAt` is
   * still that (`null`: only while there is none). Both are checked in the
   * delete statement itself; a miss throws a `conflict` `StorageError`.
   */
  deleteShader(
    scope: UserScope,
    id: string,
    expectedRevision?: number,
    expectedThumbnail?: string | null,
  ): Promise<boolean>;
  replacePresets(shaderId: string, presets: PresetRow[]): Promise<void>;
  putAsset(shaderId: string, asset: StoredAsset): Promise<void>;
  deleteAsset(shaderId: string, key: AssetKey): Promise<void>;
  /**
   * `putAsset` in one conditional statement: writes only while the stored
   * asset's `updatedAt` is still `expectedUpdatedAt` (`null`: only if there is
   * none). Returns whether it wrote.
   */
  putAssetIf(
    shaderId: string,
    asset: StoredAsset,
    expectedUpdatedAt: string | null,
  ): Promise<boolean>;
  /** `deleteAsset` in one statement, only while its `updatedAt` is still `expectedUpdatedAt`. */
  deleteAssetIf(shaderId: string, key: AssetKey, expectedUpdatedAt: string): Promise<boolean>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;

  // History. These take a shader id and do no ownership check: the library
  // loads the shader through its scope first, and the rows cascade with it.
  /** Inserts an immutable entry; a second entry for the same revision is a `conflict`. */
  insertHistory(shaderId: string, row: HistoryRow): Promise<void>;
  /** Entries without content, newest first (`revision DESC`). */
  listHistory(shaderId: string): Promise<HistoryEntryRow[]>;
  loadHistory(shaderId: string, revision: number): Promise<HistoryRow | null>;
  hasHistory(shaderId: string): Promise<boolean>;
  /**
   * Sets or clears (`null`) one entry's checkpoint name, touching nothing else.
   * Returns the entry, or `null` when there is no such revision.
   */
  setHistoryCheckpoint(
    shaderId: string,
    revision: number,
    name: string | null,
  ): Promise<HistoryEntryRow | null>;
  /**
   * Deletes all but the newest `keepUnnamed` entries without a checkpoint name;
   * named entries are never touched. Returns how many went.
   */
  pruneHistory(shaderId: string, keepUnnamed: number): Promise<number>;
}

/**
 * The engine's own connection, handed over as a Drizzle database bound to the
 * auth schema. Authentication shares the shader store — same pool or file, same
 * migration ledger — so a session and the shaders it unlocks can never be
 * served by two databases that disagree about what exists.
 */
export interface AuthDatabase {
  readonly provider: 'pg' | 'sqlite';
  /** Passed straight to Better Auth's `drizzleAdapter`. */
  readonly db: object;
}

export interface ShaderRepository {
  /** Opens the connection, applies engine pragmas/pool settings, runs migrations. */
  init(): Promise<void>;
  /** The auth-schema view of the same connection. Only valid after `init()`. */
  authDatabase(): AuthDatabase;
  close(): Promise<void>;
  /** Runs `work` inside a single transaction, rolling back if it throws. */
  transaction<T>(work: (tx: ShaderTx) => Promise<T>): Promise<T>;

  // Reads — safe outside a transaction.
  listShaders(scope: UserScope): Promise<ShaderSummaryRow[]>;
  loadShader(scope: UserScope, id: string): Promise<StoredShader | null>;
  loadAsset(scope: UserScope, id: string, key: AssetKey): Promise<StoredAsset | null>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
  /** Newest first; the caller has already checked the scope can read the shader. */
  listHistory(shaderId: string): Promise<HistoryEntryRow[]>;
}
