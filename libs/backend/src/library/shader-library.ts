/**
 * The engine-agnostic shader domain: everything that used to live in
 * `ShaderStorage` except the filesystem. It validates input, generates ids,
 * derives `fragment`/`vertex` from the project, duplicates, manages presets,
 * textures and thumbnails, imports/exports bundles, and seeds examples — all
 * against a `ShaderRepository` it never inspects. SQLite and Postgres therefore
 * share one copy of this logic; only the repository underneath differs.
 *
 * The project (`project_json`) is the source of truth. `fragment` and `vertex`
 * on a returned `ShaderRecord` are reconstructed from it on read (the Image
 * pass's source and the project's vertex), never stored on their own. Every
 * mutation of a shader and its dependents runs inside `repo.transaction`, so a
 * shader, its presets and its assets always move together.
 */

import {
  DEFAULT_CHANNELS,
  DEFAULT_RENDER,
  DEFAULT_TEXTURE_CHANNEL,
  toPayload,
  type ImportMode,
  type ImportResult,
  type Preset,
  type ShaderControl,
  type ShaderParams,
  type ShaderPayload,
  type ShaderRecord,
  type ShaderSummary,
  type TextureChannel,
  type TextureChannelPayloads,
  type TextureChannels,
  type TextureChannelSettingsPatch,
  type ThumbnailMeta,
} from '@shadergrove/shared/model';
import {
  imagePass,
  migrateLegacyProject,
  sanitizeProject,
  setPassSource,
  setVertexSource,
  type ShaderProject,
} from '@shadergrove/shared/project';
import {
  LIMITS,
  sanitizeParams,
  slugify,
  TEXTURE_EXTENSIONS,
  uniqueId,
  validateChannels,
  validateChannelSettingsPatch,
  validateControls,
  validateDescription,
  validateId,
  validateName,
  validatePreset,
  validateRender,
  validateRenderStrict,
  validateSource,
  validateThumbnailMeta,
} from '@shadergrove/shared/validate';
import {
  DEFAULT_VERTEX,
  TEMPLATE_CONTROLS,
  TEMPLATE_FRAGMENT,
} from '@shadergrove/shared/templates';

import { expect, StorageError } from './storage-error';
import type { ShaderKind, UserScope } from '../persistence/user-scope';
import {
  textureAssetKey,
  THUMBNAIL_ASSET_KEY,
  type AssetMeta,
  type PresetRow,
  type ShaderMutableFields,
  type ShaderRepository,
  type ShaderRow,
  type ShaderTx,
  type StoredAsset,
  type StoredShader,
} from '../persistence/shader-repository';

/** The last thumbnail stamp handed out per store, in ms, shared by every scope's library. */
const lastThumbnailStamps = new WeakMap<ShaderRepository, number>();

/** Bump when the bundled examples change in a way that should reach existing stores. */
export const SEED_VERSION = 1;

const CHANNEL_INDICES = [0, 1, 2, 3] as const;
type ChannelIndex = (typeof CHANNEL_INDICES)[number];

function isChannelIndex(value: number): value is ChannelIndex {
  return Number.isInteger(value) && value >= 0 && value <= 3;
}

/** A read-only source of exportable payloads — the legacy file store, or the examples folder. */
export interface PayloadSource {
  listIds(): Promise<string[]>;
  exportOne(id: string): Promise<ShaderPayload>;
}

export interface LegacyMigrationSummary {
  imported: number;
  skipped: number;
}

export class ShaderLibrary {
  /**
   * Every shader operation runs as exactly one user. The scope is bound here
   * rather than passed per call so no caller can forget it: a controller takes
   * the request's principal, calls {@link as}, and works with a library that
   * cannot see another account's rows at all.
   */
  constructor(
    private readonly repo: ShaderRepository,
    private readonly scope: UserScope,
  ) {}

  /** The same store, seen as another user. Cheap — the repository is shared. */
  as(scope: UserScope): ShaderLibrary {
    return new ShaderLibrary(this.repo, scope);
  }

  get userId(): string {
    return this.scope.userId;
  }

  /** Opens the store and brings the schema to the current version. */
  init(): Promise<void> {
    return this.repo.init();
  }

  close(): Promise<void> {
    return this.repo.close();
  }

  /** Checks database access without reading or returning any user's library. */
  async checkHealth(): Promise<void> {
    await this.repo.getMeta('schema_version');
  }

  // --- Reads ---------------------------------------------------------------

  async list(): Promise<ShaderSummary[]> {
    const rows = await this.repo.listShaders(this.scope);
    return (
      rows
        // Old shared examples remain readable through saved links, but are no
        // longer part of anyone's library. Personal copies are ordinary shaders.
        .filter((row) => row.kind === 'shader')
        .map(
          (row): ShaderSummary => ({
            id: row.id,
            kind: row.kind,
            name: row.name,
            description: row.description,
            updatedAt: row.updatedAt,
            revision: row.revision,
            controlCount: row.controlCount,
            presetCount: row.presetCount,
            thumbnail: row.thumbnail
              ? { ext: row.thumbnail.extension, updatedAt: row.thumbnail.updatedAt }
              : null,
          }),
        )
        .sort((a, b) => a.name.localeCompare(b.name))
    );
  }

  async read(id: string): Promise<ShaderRecord> {
    const validId = this.validId(id);
    const stored = await this.repo.loadShader(this.scope, validId);
    if (!stored) throw new StorageError('not_found', `Shader "${id}" was not found`);
    return this.mapRecord(stored);
  }

  // --- Create / update / delete -------------------------------------------

  async create(input: {
    name: unknown;
    description?: unknown;
    controls?: unknown;
    render?: unknown;
    fragment?: unknown;
    vertex?: unknown;
    project?: unknown;
  }): Promise<ShaderRecord> {
    const name = expect(validateName(input.name), 'Invalid shader name');
    const description = expect(validateDescription(input.description), 'Invalid description');
    const fragment = expect(
      validateSource(input.fragment ?? TEMPLATE_FRAGMENT, 'fragment'),
      'Invalid fragment shader',
    );
    const vertex = expect(
      validateSource(input.vertex ?? DEFAULT_VERTEX, 'vertex'),
      'Invalid vertex shader',
    );
    const controls = expect(
      validateControls(input.controls ?? TEMPLATE_CONTROLS),
      'Invalid control schema',
    );
    const project =
      input.project === undefined
        ? migrateLegacyProject(fragment, vertex)
        : sanitizeProject(input.project, fragment, vertex);
    const render =
      input.render === undefined
        ? { ...DEFAULT_RENDER }
        : expect(validateRenderStrict(input.render), 'Invalid render settings');

    const now = new Date().toISOString();
    const row: Omit<ShaderRow, 'id'> = {
      ownerUserId: this.scope.userId,
      kind: 'shader',
      name,
      description,
      author: null,
      createdAt: now,
      updatedAt: now,
      revision: 1,
      projectJson: JSON.stringify(project),
      controlsJson: JSON.stringify(controls),
      renderJson: JSON.stringify(render),
      channelsJson: JSON.stringify(cloneDefaultChannels()),
    };

    const id = await this.insertUnique(uniqueId(slugify(name), await this.ids()), (tx, candidate) =>
      tx.insertShader({ ...row, id: candidate }),
    );
    return this.read(id);
  }

  async update(
    id: string,
    patch: {
      name?: unknown;
      description?: unknown;
      controls?: unknown;
      render?: unknown;
      fragment?: unknown;
      vertex?: unknown;
      project?: unknown;
      channels?: unknown;
      expectedRevision?: unknown;
    },
  ): Promise<ShaderRecord> {
    const validId = this.validId(id);
    const expectedRevision = parseExpectedRevision(patch.expectedRevision);

    // Validate everything the caller supplied *before* opening the transaction,
    // so a bad patch never even starts a write.
    const name =
      patch.name === undefined
        ? undefined
        : expect(validateName(patch.name), 'Invalid shader name');
    const description =
      patch.description === undefined
        ? undefined
        : expect(validateDescription(patch.description), 'Invalid description');
    const controls =
      patch.controls === undefined
        ? undefined
        : expect(validateControls(patch.controls), 'Invalid control schema');
    const suppliedFragment =
      patch.fragment === undefined
        ? undefined
        : expect(validateSource(patch.fragment, 'fragment'), 'Invalid fragment shader');
    const suppliedVertex =
      patch.vertex === undefined
        ? undefined
        : expect(validateSource(patch.vertex, 'vertex'), 'Invalid vertex shader');
    const render =
      patch.render === undefined
        ? undefined
        : expect(validateRenderStrict(patch.render), 'Invalid render settings');
    const channelsPatch =
      patch.channels === undefined ? undefined : validateChannelSettingsPatch(patch.channels);

    // Editing a bundled example gives you a copy of it, in your own library.
    // Done before the write transaction opens so the rest of this method only
    // ever deals with a shader the caller owns.
    const target = await this.materialize(validId, id);
    if (target !== validId) return this.update(target, patch);

    await this.repo.transaction(async (tx) => {
      const stored = await tx.loadShader(this.scope, validId);
      if (!stored) throw new StorageError('not_found', `Shader "${id}" was not found`);
      const current = this.mapRecord(stored);

      // The project is the source of truth once present; a caller that only
      // knows the old fragment/vertex shape gets those reconciled onto the
      // *current* project rather than replacing it.
      let project = current.project;
      let projectTouched = false;
      if (patch.project !== undefined) {
        project = sanitizeProject(
          patch.project,
          suppliedFragment ?? current.fragment,
          suppliedVertex ?? current.vertex,
        );
        projectTouched = true;
      } else if (suppliedFragment !== undefined || suppliedVertex !== undefined) {
        const image = imagePass(current.project);
        if (suppliedFragment !== undefined)
          project = setPassSource(project, image.id, suppliedFragment);
        if (suppliedVertex !== undefined) project = setVertexSource(project, suppliedVertex);
        projectTouched = true;
      }

      const nextControls = controls ?? current.controls;
      const channels =
        channelsPatch === undefined
          ? current.channels
          : mergeChannelSettings(current.channels, channelsPatch);

      const fields: ShaderMutableFields = {
        name: name ?? current.name,
        description: description ?? current.description,
        author: current.author ?? null,
        updatedAt: new Date().toISOString(),
        projectJson: JSON.stringify(projectTouched ? project : current.project),
        controlsJson: JSON.stringify(nextControls),
        renderJson: JSON.stringify(render ?? current.render),
        channelsJson: JSON.stringify(channels),
      };

      await tx.updateShader(this.scope, validId, fields, expectedRevision);

      // Re-project presets against a changed schema, exactly as the file store did.
      if (controls !== undefined) {
        const reprojected = current.presets.map((preset) => ({
          ...preset,
          values: sanitizeParams(nextControls, preset.values),
        }));
        await tx.replacePresets(validId, reprojected.map(presetToRow));
      }
    });

    return this.read(id);
  }

  /**
   * Deletes a shader the scope owns. With `expectedRevision`, deletes only if
   * the stored revision still matches; with `expectedThumbnail` (the stored
   * `thumbnail.updatedAt`, or `null` for none), only if the thumbnail still
   * matches. Otherwise fails with `conflict` and deletes nothing. A template
   * is never deleted: it reads as `not_found`.
   */
  async remove(id: string, expectedRevision?: unknown, expectedThumbnail?: unknown): Promise<void> {
    const validId = this.validId(id);
    const revision = parseExpectedRevision(expectedRevision);
    if (
      expectedThumbnail !== undefined &&
      expectedThumbnail !== null &&
      (typeof expectedThumbnail !== 'string' || expectedThumbnail === '')
    ) {
      throw new StorageError('invalid', 'Invalid expected thumbnail');
    }
    await this.repo.transaction(async (tx) => {
      const existed = await tx.deleteShader(this.scope, validId, revision, expectedThumbnail);
      if (!existed) throw new StorageError('not_found', `Shader "${id}" was not found`);
    });
  }

  async duplicate(id: string, name?: unknown): Promise<ShaderRecord> {
    const source = await this.exportOne(id);
    const copyName = expect(
      validateName(name ?? `${source.name} copy`.slice(0, LIMITS.nameLength)),
      'Invalid shader name',
    );
    const copyId = await this.insertUnique(
      uniqueId(slugify(copyName), await this.ids()),
      (tx, candidate) => this.insertPayload(tx, { ...source, id: candidate, name: copyName }),
    );
    return this.read(copyId);
  }

  // --- Texture channels ----------------------------------------------------

  async setTexture(
    id: string,
    channel: number,
    input: { ext: string; bytes: Uint8Array; width: number; height: number },
  ): Promise<ShaderRecord> {
    const validId = this.validId(id);
    if (!isChannelIndex(channel)) {
      throw new StorageError('invalid', `Invalid channel index "${channel}"`);
    }
    const ext = input.ext.toLowerCase();
    if (!TEXTURE_EXTENSIONS.has(ext)) {
      throw new StorageError('invalid', `Unsupported image type ".${input.ext}"`);
    }
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
      throw new StorageError('invalid', 'Texture data is empty');
    }
    if (input.bytes.byteLength > LIMITS.textureBytes) {
      throw new StorageError(
        'invalid',
        `Texture must be at most ${Math.round(LIMITS.textureBytes / (1024 * 1024))} MB`,
      );
    }
    const width = Math.round(input.width);
    const height = Math.round(input.height);
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0 ||
      width > LIMITS.textureDimension ||
      height > LIMITS.textureDimension
    ) {
      throw new StorageError('invalid', 'Invalid texture dimensions');
    }

    await this.repo.transaction(async (tx) => {
      const stored = await tx.loadShader(this.scope, validId);
      if (!stored) throw new StorageError('not_found', `Shader "${id}" was not found`);
      const current = this.mapRecord(stored);
      const now = new Date().toISOString();

      await tx.putAsset(validId, {
        key: textureAssetKey(channel),
        extension: ext,
        width,
        height,
        updatedAt: now,
        data: input.bytes,
      });

      const channels = CHANNEL_INDICES.map((index) =>
        index === channel
          ? { ...current.channels[index], ext, width, height }
          : current.channels[index],
      ) as unknown as TextureChannels;

      await tx.updateShader(this.scope, validId, this.fieldsWithChannels(current, channels, now));
    });

    return this.read(id);
  }

  async clearTexture(id: string, channel: number): Promise<ShaderRecord> {
    const validId = this.validId(id);
    if (!isChannelIndex(channel)) {
      throw new StorageError('invalid', `Invalid channel index "${channel}"`);
    }

    await this.repo.transaction(async (tx) => {
      const stored = await tx.loadShader(this.scope, validId);
      if (!stored) throw new StorageError('not_found', `Shader "${id}" was not found`);
      const current = this.mapRecord(stored);
      const now = new Date().toISOString();

      await tx.deleteAsset(validId, textureAssetKey(channel));

      const channels = CHANNEL_INDICES.map((index) =>
        index === channel ? { ...DEFAULT_TEXTURE_CHANNEL } : current.channels[index],
      ) as unknown as TextureChannels;

      await tx.updateShader(this.scope, validId, this.fieldsWithChannels(current, channels, now));
    });

    return this.read(id);
  }

  /** A channel's raw image bytes, for serving to the client. */
  async readTexture(
    id: string,
    channel: number,
  ): Promise<{ bytes: Uint8Array; ext: string } | null> {
    if (!isChannelIndex(channel)) return null;
    const asset = await this.repo.loadAsset(this.scope, this.validId(id), textureAssetKey(channel));
    return asset ? { bytes: asset.data, ext: asset.extension } : null;
  }

  // --- Thumbnail -----------------------------------------------------------

  /**
   * Stores the preview the client captured. It deliberately does *not* touch the
   * shader row: a thumbnail is a picture of the document, not a change to it, so
   * `updatedAt` and `revision` stay put and a "recently modified" list does not
   * reorder every time a preview refreshes.
   *
   * With `expectedThumbnail` (the stored `thumbnail.updatedAt`, or `null` for
   * none) the compare and the write are one conditional statement: a thumbnail
   * written meanwhile fails the call with `conflict` and nothing is written.
   * Every write stamps a `thumbnail.updatedAt` strictly after any this process
   * has written or cleared on this store (see {@link stampThumbnail}), so a
   * stamp never comes back and a stale expectation can never match again.
   */
  async setThumbnail(
    id: string,
    input: { ext: string; bytes: Uint8Array },
    expectedThumbnail?: string | null,
  ): Promise<ShaderRecord> {
    const validId = this.validId(id);
    const ext = input.ext.toLowerCase();
    if (!TEXTURE_EXTENSIONS.has(ext)) {
      throw new StorageError('invalid', `Unsupported image type ".${input.ext}"`);
    }
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
      throw new StorageError('invalid', 'Thumbnail data is empty');
    }
    if (input.bytes.byteLength > LIMITS.thumbnailBytes) {
      throw new StorageError(
        'invalid',
        `Thumbnail must be at most ${Math.round(LIMITS.thumbnailBytes / 1024)} KB`,
      );
    }

    return this.repo.transaction(async (tx) => {
      const stored = await tx.loadShader(this.scope, validId);
      if (!stored) throw new StorageError('not_found', `Shader "${id}" was not found`);
      const previous = stored.assets.find((asset) => asset.key === THUMBNAIL_ASSET_KEY);
      const asset = {
        key: THUMBNAIL_ASSET_KEY,
        extension: ext,
        width: null,
        height: null,
        updatedAt: this.stampThumbnail(expectedThumbnail ?? previous?.updatedAt),
        data: input.bytes,
      };
      if (expectedThumbnail === undefined) await tx.putAsset(validId, asset);
      else if (!(await tx.putAssetIf(validId, asset, expectedThumbnail))) {
        throw thumbnailConflict(id);
      }
      return this.mapRecord(await this.reload(tx, validId));
    });
  }

  /**
   * Drops the preview. Like {@link setThumbnail}, the shader row stays put, and
   * `expectedThumbnail` makes it conditional the same way.
   */
  async clearThumbnail(id: string, expectedThumbnail?: string | null): Promise<ShaderRecord> {
    const validId = this.validId(id);
    return this.repo.transaction(async (tx) => {
      const stored = await tx.loadShader(this.scope, validId);
      if (!stored) throw new StorageError('not_found', `Shader "${id}" was not found`);
      // A later thumbnail must never reuse the stamp of the one going now.
      const cleared = stored.assets.find((asset) => asset.key === THUMBNAIL_ASSET_KEY);
      this.stampThumbnail(cleared?.updatedAt);
      if (expectedThumbnail === undefined) await tx.deleteAsset(validId, THUMBNAIL_ASSET_KEY);
      else if (expectedThumbnail === null) {
        // Nothing to delete: only a thumbnail present now breaks the expectation.
        if (stored.assets.some((asset) => asset.key === THUMBNAIL_ASSET_KEY)) {
          throw thumbnailConflict(id);
        }
      } else if (!(await tx.deleteAssetIf(validId, THUMBNAIL_ASSET_KEY, expectedThumbnail))) {
        throw thumbnailConflict(id);
      }
      return this.mapRecord(await this.reload(tx, validId));
    });
  }

  /**
   * A thumbnail stamp strictly after `previous` and after every stamp this
   * process handed out or saw cleared on this store, whatever the clock says
   * (same millisecond, clock set back). The conditional writes' only caller is
   * the desktop sync, comparing a stamp it read from this same store in this
   * same process, so no in-flight expectation can ever match a newer thumbnail
   * — clears included. The REST API never takes an expectation from clients.
   */
  // ponytail: per-process clock; unique stamps across processes need a persisted thumbnail version column.
  private stampThumbnail(previous?: string | null): string {
    const stamp = Math.max(
      Date.now(),
      (lastThumbnailStamps.get(this.repo) ?? 0) + 1,
      previous ? Date.parse(previous) + 1 || 0 : 0,
    );
    lastThumbnailStamps.set(this.repo, stamp);
    return new Date(stamp).toISOString();
  }

  /** The shader as this transaction just wrote it. */
  private async reload(tx: ShaderTx, id: string): Promise<StoredShader> {
    const stored = await tx.loadShader(this.scope, id);
    if (!stored) throw new StorageError('not_found', `Shader "${id}" was not found`);
    return stored;
  }

  /** The preview's raw image bytes, for serving to the client. */
  async readThumbnail(id: string): Promise<{ bytes: Uint8Array; ext: string } | null> {
    const asset = await this.repo.loadAsset(this.scope, this.validId(id), THUMBNAIL_ASSET_KEY);
    return asset ? { bytes: asset.data, ext: asset.extension } : null;
  }

  // --- Presets -------------------------------------------------------------

  async savePreset(
    id: string,
    input: { name: unknown; values: unknown; render?: unknown },
  ): Promise<Preset> {
    const validId = this.validId(id);
    const name = expect(validateName(input.name, 'preset.name'), 'Invalid preset name');

    return this.repo.transaction(async (tx) => {
      const stored = await tx.loadShader(this.scope, validId);
      if (!stored) throw new StorageError('not_found', `Shader "${id}" was not found`);
      const shader = this.mapRecord(stored);

      if (shader.presets.length >= LIMITS.presetCount) {
        throw new StorageError(
          'conflict',
          `Shader "${id}" already has the maximum number of presets`,
        );
      }

      const existing = shader.presets.find((preset) => preset.name === name);
      const presetId =
        existing?.id ??
        uniqueId(
          slugify(name),
          shader.presets.map((preset) => preset.id),
        );

      const preset: Preset = {
        id: presetId,
        name,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        values: sanitizeParams(shader.controls, input.values as ShaderParams),
        ...(input.render === undefined || input.render === null
          ? {}
          : { render: expect(validateRenderStrict(input.render), 'Invalid preset render') }),
      };

      const presets = existing
        ? shader.presets.map((entry) => (entry.id === presetId ? preset : entry))
        : [...shader.presets, preset];

      await tx.replacePresets(validId, presets.map(presetToRow));
      await this.touch(tx, shader);
      return preset;
    });
  }

  async deletePreset(id: string, presetId: string): Promise<void> {
    const validId = this.validId(id);
    expect(validateId(presetId), `Invalid preset id "${presetId}"`);

    await this.repo.transaction(async (tx) => {
      const stored = await tx.loadShader(this.scope, validId);
      if (!stored) throw new StorageError('not_found', `Shader "${id}" was not found`);
      const shader = this.mapRecord(stored);

      const presets = shader.presets.filter((preset) => preset.id !== presetId);
      if (presets.length === shader.presets.length) {
        throw new StorageError('not_found', `Preset "${presetId}" was not found on shader "${id}"`);
      }

      await tx.replacePresets(validId, presets.map(presetToRow));
      await this.touch(tx, shader);
    });
  }

  // --- Import / export -----------------------------------------------------

  async exportOne(id: string): Promise<ShaderPayload> {
    const record = await this.read(id);
    const payload = toPayload(record);

    const channels = await Promise.all(
      CHANNEL_INDICES.map(async (channel) => {
        const entry = payload.channels[channel];
        if (entry.ext === null) return entry;
        const asset = await this.repo.loadAsset(this.scope, record.id, textureAssetKey(channel));
        if (!asset) {
          console.warn(`[storage] texture ${channel} of "${id}" is missing`);
          return { ...DEFAULT_TEXTURE_CHANNEL, data: null };
        }
        return { ...entry, data: toBase64(asset.data) };
      }),
    );

    let thumbnail = payload.thumbnail;
    if (record.thumbnail) {
      const asset = await this.repo.loadAsset(this.scope, record.id, THUMBNAIL_ASSET_KEY);
      thumbnail = asset
        ? {
            ext: record.thumbnail.ext,
            updatedAt: record.thumbnail.updatedAt,
            data: toBase64(asset.data),
          }
        : null;
    }

    return {
      ...payload,
      channels: channels as unknown as TextureChannelPayloads,
      thumbnail,
    };
  }

  /**
   * The shader and every asset's bytes exactly as `tx` sees them — what a
   * publication snapshot is cut from. {@link exportOne} reads the same pieces
   * in separate statements and so can straddle a concurrent write; this holds
   * the shader row for the whole transaction, and every child-row write takes
   * that lock first. Only a shader the scope owns: a template or someone
   * else's reads as `not_found`.
   */
  async snapshotWithin(
    tx: ShaderTx,
    id: string,
  ): Promise<{ record: ShaderRecord; assets: StoredAsset[] }> {
    const validId = this.validId(id);
    const stored = await tx.loadShader(this.scope, validId);
    if (!stored || stored.row.kind !== 'shader' || stored.row.ownerUserId !== this.scope.userId) {
      throw new StorageError('not_found', `Shader "${id}" was not found`);
    }
    const assets: StoredAsset[] = [];
    for (const meta of stored.assets) {
      const asset = await tx.loadAsset(this.scope, validId, meta.key);
      if (asset) assets.push(asset);
    }
    return { record: this.mapRecord(stored), assets };
  }

  async exportAll(): Promise<ShaderPayload[]> {
    const summaries = await this.list();
    const payloads: ShaderPayload[] = [];
    for (const summary of summaries) {
      try {
        payloads.push(await this.exportOne(summary.id));
      } catch (error) {
        console.warn(`[storage] excluding shader "${summary.id}" from export: ${String(error)}`);
      }
    }
    return payloads;
  }

  async importPayloads(payloads: ShaderPayload[], mode: ImportMode): Promise<ImportResult> {
    const imported: ImportResult['imported'] = [];
    const taken = new Set(await this.ids());

    for (const payload of payloads) {
      const collides = taken.has(payload.id);
      const replaced = collides && mode === 'overwrite';
      const wanted = replaced || !collides ? payload.id : uniqueId(payload.id, taken);

      const id = await this.insertUnique(wanted, async (tx, candidate) => {
        if (replaced && candidate === wanted) await tx.deleteShader(this.scope, candidate);
        await this.insertPayload(tx, { ...payload, id: candidate });
      });

      taken.add(id);
      imported.push({ id, name: payload.name, replaced });
    }

    return { imported };
  }

  /**
   * Overwrites a shader with a payload in one transaction: fields, project,
   * controls, render, presets and textures. `id`, owner, `kind` and
   * `createdAt` stay; `payload.id` is ignored. Unlike an `overwrite` import it
   * never deletes the row, so the revision carries on — it becomes exactly
   * `expectedRevision + 1`, or the call fails with `conflict` when the shader
   * has moved on. This is how a sync client pushes a whole shader.
   *
   * The thumbnail is left out entirely: it is a derived picture outside the
   * revision (see {@link setThumbnail}), so this never reads or writes it and
   * cannot lose a concurrent upload. `payload.thumbnail` is ignored; a client
   * pushes its preview through {@link setThumbnail} instead.
   *
   * The returned record is read inside the transaction, so it is exactly the
   * revision this call wrote, never a later concurrent one.
   */
  async replaceFromPayload(
    id: string,
    payload: ShaderPayload,
    expectedRevision: unknown,
  ): Promise<ShaderRecord> {
    const validId = this.validId(id);
    const revision = parseExpectedRevision(expectedRevision);
    if (revision === undefined) throw new StorageError('invalid', 'Invalid expected revision');
    const now = new Date().toISOString();
    const fields = payloadFields(payload, now);

    return this.repo.transaction(async (tx) => {
      const stored = await tx.loadShader(this.scope, validId);
      if (!stored) throw new StorageError('not_found', `Shader "${id}" was not found`);
      if (stored.row.kind === 'template') {
        throw new StorageError('invalid', `Shader "${id}" is a template and cannot be replaced`);
      }

      await tx.updateShader(this.scope, validId, fields, revision);
      for (const asset of stored.assets) {
        if (asset.key !== THUMBNAIL_ASSET_KEY) await tx.deleteAsset(validId, asset.key);
      }
      await this.writePayloadChildren(tx, validId, { ...payload, thumbnail: null }, now);

      const written = await tx.loadShader(this.scope, validId);
      if (!written) throw new StorageError('not_found', `Shader "${id}" was not found`);
      return this.mapRecord(written);
    });
  }

  // --- Seeding & legacy migration -----------------------------------------

  /**
   * Installs the bundled examples once per seed version, idempotently: it only
   * inserts examples whose id is not already present, so it never overwrites a
   * user's shader, and it records the seed version so a deleted example does not
   * come back on the next start. Only explicit callers install examples.
   */
  async installExamples(
    source: PayloadSource,
    enabled: boolean,
    kind: ShaderKind = 'shader',
  ): Promise<void> {
    if (!enabled) return;
    const stored = Number((await this.repo.getMeta('seed_version')) ?? -1);
    if (stored >= SEED_VERSION) return;

    let examples: ShaderPayload[];
    try {
      const ids = await source.listIds();
      examples = [];
      for (const id of ids) {
        try {
          examples.push(await source.exportOne(id));
        } catch (error) {
          console.warn(`[storage] skipping example "${id}": ${String(error)}`);
        }
      }
    } catch (error) {
      console.warn(`[storage] no examples available: ${String(error)}`);
      examples = [];
    }

    await this.repo.transaction(async (tx) => {
      const existing = new Set(await tx.listIds(this.scope));
      for (const payload of examples) {
        if (existing.has(payload.id)) continue;
        await this.insertPayload(tx, payload, kind);
        existing.add(payload.id);
      }
      await tx.setMeta('seed_version', String(SEED_VERSION));
    });
  }

  /** Marks seeding as complete without inserting anything — used after a legacy import. */
  async markSeeded(): Promise<void> {
    await this.repo.setMeta('seed_version', String(SEED_VERSION));
  }

  /**
   * Imports an entire legacy file library in one transaction, then verifies the
   * import (shader count, ids, preset counts, texture and thumbnail presence)
   * before the transaction is allowed to commit. Never deletes the source.
   */
  async migrateLegacy(source: PayloadSource): Promise<LegacyMigrationSummary> {
    const ids = await source.listIds();
    const payloads: ShaderPayload[] = [];
    let skipped = 0;
    for (const id of ids) {
      try {
        payloads.push(await source.exportOne(id));
      } catch (error) {
        skipped += 1;
        console.warn(`[migration] skipping unreadable shader "${id}": ${String(error)}`);
      }
    }

    await this.repo.transaction(async (tx) => {
      const existing = new Set(await tx.listIds(this.scope));
      for (const payload of payloads) {
        const id = existing.has(payload.id) ? uniqueId(payload.id, existing) : payload.id;
        await this.insertPayload(tx, { ...payload, id });
        existing.add(id);
        await this.verifyImported(tx, payload, id);
      }
      await tx.setMeta('seed_version', String(SEED_VERSION));
    });

    return { imported: payloads.length, skipped };
  }

  getMeta(key: string): Promise<string | null> {
    return this.repo.getMeta(key);
  }

  setMeta(key: string, value: string): Promise<void> {
    return this.repo.setMeta(key, value);
  }

  // --- Internals -----------------------------------------------------------

  /**
   * Writes under `wanted`, an id the caller already picked as free *in this
   * user's library*, and retries with a random suffix if the row id — still
   * globally unique — turns out to belong to someone else's shader. Retrying
   * rather than probing keeps the scoped listing the only readable thing: a
   * collision yields an unguessable id instead of an incrementing one that
   * would let a user count strangers' shaders.
   *
   * ponytail: per-user slugs would need a composite (owner, id) primary key
   * across shaders/presets/assets. Revisit if collisions show up in logs.
   */
  private async insertUnique(
    wanted: string,
    write: (tx: ShaderTx, id: string) => Promise<void>,
  ): Promise<string> {
    const base = wanted;
    let candidate = wanted;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.repo.transaction((tx) => write(tx, candidate));
        return candidate;
      } catch (error) {
        const collision = error instanceof StorageError && error.code === 'conflict';
        if (!collision || attempt >= 4) throw error;
        candidate = `${base}-${randomSuffix()}`;
      }
    }
  }

  /**
   * Returns an id this scope may write to.
   *
   * A template is readable by everyone and writable by nobody, so the first
   * edit of one forks it: the caller gets a copy in their own library and the
   * example stays as it was for everybody else. Any other shader — including
   * one that simply is not yours — is returned unchanged, so the write that
   * follows fails on ownership exactly as it did before.
   */
  private async materialize(validId: string, rawId: string): Promise<string> {
    const stored = await this.repo.loadShader(this.scope, validId);
    if (!stored) throw new StorageError('not_found', `Shader "${rawId}" was not found`);
    if (stored.row.kind !== 'template' || stored.row.ownerUserId === this.scope.userId) {
      return validId;
    }

    const source = await this.exportOne(validId);
    return this.insertUnique(uniqueId(source.id, await this.ids()), (tx, candidate) =>
      this.insertPayload(tx, { ...source, id: candidate }),
    );
  }

  private async ids(): Promise<string[]> {
    return (await this.repo.listShaders(this.scope)).map((row) => row.id);
  }

  private validId(id: string): string {
    return expect(validateId(id), `Invalid shader id "${id}"`);
  }

  private async touch(tx: ShaderTx, current: ShaderRecord): Promise<void> {
    await tx.updateShader(this.scope, current.id, this.fields(current, new Date().toISOString()));
  }

  /** The current record's mutable columns, with a fresh `updatedAt`. */
  private fields(current: ShaderRecord, updatedAt: string): ShaderMutableFields {
    return {
      name: current.name,
      description: current.description,
      author: current.author ?? null,
      updatedAt,
      projectJson: JSON.stringify(current.project),
      controlsJson: JSON.stringify(current.controls),
      renderJson: JSON.stringify(current.render),
      channelsJson: JSON.stringify(current.channels),
    };
  }

  private fieldsWithChannels(
    current: ShaderRecord,
    channels: TextureChannels,
    updatedAt: string,
  ): ShaderMutableFields {
    return { ...this.fields(current, updatedAt), channelsJson: JSON.stringify(channels) };
  }

  /** Writes a full payload (shader row, presets and asset bytes) inside a transaction. */
  private async insertPayload(
    tx: ShaderTx,
    payload: ShaderPayload,
    kind: ShaderKind = 'shader',
  ): Promise<void> {
    const now = new Date().toISOString();
    const row: ShaderRow = {
      id: payload.id,
      ownerUserId: this.scope.userId,
      kind,
      createdAt: now,
      revision: 1,
      ...payloadFields(payload, now),
    };

    await tx.insertShader(row);
    await this.writePayloadChildren(tx, payload.id, payload, now);
  }

  /** Presets, texture bytes and thumbnail of a payload, written under `id`. */
  private async writePayloadChildren(
    tx: ShaderTx,
    id: string,
    payload: ShaderPayload,
    now: string,
  ): Promise<void> {
    await tx.replacePresets(id, payload.presets.map(presetToRow));

    for (const channel of CHANNEL_INDICES) {
      const entry = payload.channels[channel];
      if (entry.ext === null || entry.data === null) continue;
      await tx.putAsset(id, {
        key: textureAssetKey(channel),
        extension: entry.ext,
        width: entry.width,
        height: entry.height,
        updatedAt: now,
        data: fromBase64(entry.data),
      });
    }

    if (payload.thumbnail) {
      await tx.putAsset(id, {
        key: THUMBNAIL_ASSET_KEY,
        extension: payload.thumbnail.ext,
        width: null,
        height: null,
        updatedAt: payload.thumbnail.updatedAt,
        data: fromBase64(payload.thumbnail.data),
      });
    }
  }

  private async verifyImported(tx: ShaderTx, payload: ShaderPayload, id: string): Promise<void> {
    const stored = await tx.loadShader(this.scope, id);
    if (!stored) {
      throw new StorageError('io', `Migration verification failed: shader "${id}" is missing`);
    }
    if (stored.presets.length !== payload.presets.length) {
      throw new StorageError(
        'io',
        `Migration verification failed: shader "${id}" preset count ${stored.presets.length} != ${payload.presets.length}`,
      );
    }
    const assetKeys = new Set(stored.assets.map((asset) => asset.key));
    for (const channel of CHANNEL_INDICES) {
      const entry = payload.channels[channel];
      if (entry.ext !== null && entry.data !== null && !assetKeys.has(textureAssetKey(channel))) {
        throw new StorageError(
          'io',
          `Migration verification failed: texture ${channel} of "${id}" is missing`,
        );
      }
    }
    if (payload.thumbnail && !assetKeys.has(THUMBNAIL_ASSET_KEY)) {
      throw new StorageError(
        'io',
        `Migration verification failed: thumbnail of "${id}" is missing`,
      );
    }
  }

  /** Rebuilds the public record from stored rows, deriving fragment/vertex from the project. */
  private mapRecord(stored: StoredShader): ShaderRecord {
    const { row, presets, assets } = stored;
    const project = this.parseProject(row);
    const image = imagePass(project);

    const controls = expect(
      validateControls(safeParse(row.controlsJson) ?? []),
      `Shader "${row.id}" has an invalid control schema`,
    );
    const render = validateRender(safeParse(row.renderJson));
    const channels = validateChannels(safeParse(row.channelsJson));
    const thumbnail = this.thumbnailMeta(assets);

    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      description: row.description,
      ...(row.author ? { author: row.author } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      revision: row.revision,
      controls,
      render,
      channels,
      thumbnail,
      fragment: image.source,
      vertex: project.vertex,
      presets: this.mapPresets(presets, controls),
      project,
    };
  }

  private parseProject(row: ShaderRow): ShaderProject {
    let raw: unknown;
    try {
      raw = JSON.parse(row.projectJson);
    } catch {
      throw new StorageError('io', `Shader "${row.id}" has a corrupt project`);
    }
    return sanitizeProject(raw, TEMPLATE_FRAGMENT, DEFAULT_VERTEX);
  }

  private thumbnailMeta(assets: AssetMeta[]): ThumbnailMeta | null {
    const asset = assets.find((entry) => entry.key === THUMBNAIL_ASSET_KEY);
    if (!asset) return null;
    return validateThumbnailMeta({ ext: asset.extension, updatedAt: asset.updatedAt });
  }

  private mapPresets(rows: PresetRow[], controls: ShaderControl[]): Preset[] {
    const presets: Preset[] = [];
    for (const row of rows) {
      const values = safeParse(row.valuesJson) ?? {};
      const render = row.renderJson ? safeParse(row.renderJson) : undefined;
      const raw = {
        id: row.id,
        name: row.name,
        createdAt: row.createdAt,
        values,
        ...(render === undefined ? {} : { render }),
      };
      const result = validatePreset(raw, controls, row.id);
      if (result.ok) presets.push(result.value);
    }
    return presets;
  }
}

/** Six base-36 characters — enough that a retry practically never repeats. */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0');
}

function mergeChannelSettings(
  current: TextureChannels,
  patch: TextureChannelSettingsPatch[],
): TextureChannels {
  return CHANNEL_INDICES.map((channel) => ({
    ...current[channel],
    ...patch[channel],
  })) as unknown as TextureChannels;
}

/** A payload's shader columns, validated the same way for insert and replace. */
function payloadFields(payload: ShaderPayload, updatedAt: string): ShaderMutableFields {
  const project = sanitizeProject(payload.project, payload.fragment, payload.vertex);
  const controls = expect(
    validateControls(payload.controls),
    `Shader "${payload.id}" has an invalid control schema`,
  );
  const channels = CHANNEL_INDICES.map((channel) => {
    const entry = payload.channels[channel];
    return {
      ext: entry.ext,
      width: entry.width,
      height: entry.height,
      wrap: entry.wrap,
      filter: entry.filter,
      flipY: entry.flipY,
    } satisfies TextureChannel;
  }) as unknown as TextureChannels;

  return {
    name: payload.name,
    description: payload.description,
    author: payload.author ?? null,
    updatedAt,
    projectJson: JSON.stringify(project),
    controlsJson: JSON.stringify(controls),
    renderJson: JSON.stringify(validateRender(payload.render)),
    channelsJson: JSON.stringify(validateChannels(channels)),
  };
}

function presetToRow(preset: Preset): PresetRow {
  return {
    id: preset.id,
    name: preset.name,
    createdAt: preset.createdAt,
    valuesJson: JSON.stringify(preset.values),
    renderJson: preset.render === undefined ? null : JSON.stringify(preset.render),
  };
}

function cloneDefaultChannels(): TextureChannels {
  return DEFAULT_CHANNELS.map((channel) => ({ ...channel })) as unknown as TextureChannels;
}

function thumbnailConflict(id: string): StorageError {
  return new StorageError(
    'conflict',
    `The thumbnail of "${id}" was changed by another write; nothing was written`,
  );
}

function parseExpectedRevision(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 1) {
    throw new StorageError('invalid', 'Invalid expected revision');
  }
  return revision;
}

function safeParse(raw: string | null): unknown {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(data: string): Uint8Array {
  return Buffer.from(data, 'base64');
}
