/**
 * PostgreSQL persistence via Drizzle's node-postgres adapter. The connection
 * string stays server-side, reads use the pool, and every shader mutation uses
 * one Drizzle transaction.
 *
 * Schema migrations intentionally still use the repository's original ledger:
 * existing installations already track `schema_version` there. Keeping that
 * history avoids a second migration tool treating live tables as uninitialized.
 */

import { and, asc, count, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';

import { StorageError } from '../../library/storage-error';
import {
  PublicationStore,
  type PublicationRepository,
  type SqlExecutor,
} from '../../publication/publication-store';
import { runMigrations } from '../migration-runner';
import {
  type AssetKey,
  type AssetMeta,
  type HistoryEntryRow,
  type HistoryRow,
  type PresetRow,
  type ShaderMutableFields,
  type ShaderRepository,
  type ShaderRow,
  type ShaderSummaryRow,
  type ShaderTx,
  type StoredAsset,
  type StoredShader,
  type AuthDatabase,
  THUMBNAIL_ASSET_KEY,
} from '../shader-repository';
import type { UserScope } from '../user-scope';
import { postgresAuthSchema } from './auth-schema';
import { POSTGRES_MIGRATIONS } from './migrations';
import { assets, postgresSchema, presets, shaderHistory, shaders, storageMetadata } from './schema';

/**
 * What a scope may read: its own shaders, plus the shared templates. The
 * mirror-image predicate for writes is spelled out inline at each write, and is
 * always `ownerUserId = scope.userId` alone.
 */
function readable(scope: UserScope) {
  return or(eq(shaders.ownerUserId, scope.userId), eq(shaders.kind, 'template'));
}

/** Arbitrary but stable key for the migration advisory lock. */
const MIGRATION_LOCK_KEY = 0x5_4d1_9a70;

type PostgresDb = NodePgDatabase<typeof postgresSchema>;
type PostgresExecutor = Pick<PostgresDb, 'delete' | 'insert' | 'select' | 'update'>;

export interface PostgresRepositoryOptions {
  connectionString: string;
  maxPoolSize?: number;
  /** Statement/connection timeouts, ms. */
  connectionTimeoutMs?: number;
}

export class PostgresRepository implements ShaderRepository, PublicationRepository {
  private pool: Pool | null = null;
  private db: PostgresDb | null = null;
  private authDb: object | null = null;

  constructor(private readonly options: PostgresRepositoryOptions) {}

  async init(): Promise<void> {
    await this.close();

    const pool = new Pool({
      connectionString: this.options.connectionString,
      max: this.options.maxPoolSize ?? 10,
      connectionTimeoutMillis: this.options.connectionTimeoutMs ?? 10_000,
    });
    pool.on('error', (error) => console.error('[postgres] idle client error', error));
    this.pool = pool;

    const client = await pool.connect().catch((error: unknown) => {
      throw asStorageError(error, 'Cannot connect to PostgreSQL');
    });
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
      await client.query(
        'CREATE TABLE IF NOT EXISTS storage_metadata (key text PRIMARY KEY, value text NOT NULL)',
      );
      await runMigrations(POSTGRES_MIGRATIONS, {
        getVersion: async () => {
          const result = await client.query(
            "SELECT value FROM storage_metadata WHERE key = 'schema_version'",
          );
          return result.rows.length ? Number(result.rows[0]['value']) : 0;
        },
        setVersion: async (version) => {
          await client.query(
            `INSERT INTO storage_metadata (key, value) VALUES ('schema_version', $1)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
            [String(version)],
          );
        },
        exec: async (statement) => {
          await client.query(statement);
        },
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      this.pool = null;
      void pool.end().catch(() => undefined);
      throw asStorageError(error, 'Failed to migrate the PostgreSQL database');
    } finally {
      client.release();
    }

    this.db = drizzle({ client: pool, schema: postgresSchema });
    // A second Drizzle view of the *same* pool. Separating the schemas keeps
    // Better Auth's tables out of the shader query model (and vice versa)
    // without opening a second set of connections.
    this.authDb = drizzle({ client: pool, schema: postgresAuthSchema });
  }

  authDatabase(): AuthDatabase {
    if (!this.authDb) throw new StorageError('io', 'The database pool is not open');
    return { provider: 'pg', db: this.authDb };
  }

  async close(): Promise<void> {
    const pool = this.pool;
    this.db = null;
    this.authDb = null;
    this.pool = null;
    await pool?.end();
  }

  transaction<T>(work: (tx: ShaderTx) => Promise<T>): Promise<T> {
    return this.publicationTransaction(work);
  }

  get publications(): PublicationStore {
    return new PublicationStore(executor(this.database()), 'pg');
  }

  async publicationTransaction<T>(
    work: (tx: ShaderTx, publications: PublicationStore) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.database().transaction((tx) =>
        work(new PgOps(tx, true), new PublicationStore(executor(tx), 'pg')),
      );
    } catch (error) {
      throw asStorageError(error, 'Database transaction failed');
    }
  }

  listShaders(scope: UserScope): Promise<ShaderSummaryRow[]> {
    return new PgOps(this.database()).listShaders(scope);
  }

  loadShader(scope: UserScope, id: string): Promise<StoredShader | null> {
    return new PgOps(this.database()).loadShader(scope, id);
  }

  loadAsset(scope: UserScope, id: string, key: AssetKey): Promise<StoredAsset | null> {
    return new PgOps(this.database()).loadAsset(scope, id, key);
  }

  listHistory(shaderId: string): Promise<HistoryEntryRow[]> {
    return new PgOps(this.database()).listHistory(shaderId);
  }

  getMeta(key: string): Promise<string | null> {
    return new PgOps(this.database()).getMeta(key);
  }

  setMeta(key: string, value: string): Promise<void> {
    return new PgOps(this.database()).setMeta(key, value);
  }

  private database(): PostgresDb {
    if (!this.db) throw new StorageError('io', 'The database pool is not open');
    return this.db;
  }
}

/**
 * Lock order, in a write transaction: the shader row first (`FOR UPDATE`, by
 * `loadShader` or `deleteShader`, the first statement of every such
 * transaction), then its presets and assets. One order, so a child-row write
 * and a delete's cascade never deadlock, and a conditional delete never sees
 * a thumbnail that is about to change.
 */
class PgOps implements ShaderTx {
  constructor(
    private readonly db: PostgresExecutor,
    private readonly inTransaction = false,
  ) {}

  async listShaders(scope: UserScope): Promise<ShaderSummaryRow[]> {
    const thumbnails = alias(assets, 'thumbnail_asset');
    const rows = await this.db
      .select({
        id: shaders.id,
        kind: shaders.kind,
        name: shaders.name,
        description: shaders.description,
        updatedAt: shaders.updatedAt,
        revision: shaders.revision,
        controlsJson: shaders.controlsJson,
        presetCount: count(presets.id),
        thumbExt: thumbnails.extension,
        thumbUpdated: thumbnails.updatedAt,
      })
      .from(shaders)
      .leftJoin(presets, eq(presets.shaderId, shaders.id))
      .leftJoin(
        thumbnails,
        and(eq(thumbnails.shaderId, shaders.id), eq(thumbnails.assetKey, 'thumbnail')),
      )
      .where(readable(scope))
      .groupBy(
        shaders.id,
        shaders.kind,
        shaders.name,
        shaders.description,
        shaders.updatedAt,
        shaders.revision,
        shaders.controlsJson,
        thumbnails.extension,
        thumbnails.updatedAt,
      );

    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      name: row.name,
      description: row.description,
      updatedAt: row.updatedAt,
      revision: row.revision,
      controlCount: Array.isArray(row.controlsJson) ? row.controlsJson.length : 0,
      presetCount: row.presetCount,
      thumbnail:
        row.thumbExt === null
          ? null
          : { extension: row.thumbExt, updatedAt: required(row.thumbUpdated, 'thumbnail date') },
    }));
  }

  async listIds(scope: UserScope): Promise<string[]> {
    const rows = await this.db
      .select({ id: shaders.id })
      .from(shaders)
      .where(eq(shaders.ownerUserId, scope.userId))
      .orderBy(asc(shaders.id));
    return rows.map((row) => row.id);
  }

  async loadShader(scope: UserScope, id: string): Promise<StoredShader | null> {
    // Reads admit the shared templates; writes never do — see updateShader.
    const query = this.db
      .select()
      .from(shaders)
      .where(and(eq(shaders.id, id), readable(scope)))
      .limit(1);
    const [row] = this.inTransaction ? await query.for('update') : await query;
    if (!row) return null;

    const presetRows = await this.db
      .select()
      .from(presets)
      .where(eq(presets.shaderId, id))
      .orderBy(asc(presets.createdAt), asc(presets.id));
    const assetRows = await this.db
      .select({
        assetKey: assets.assetKey,
        extension: assets.extension,
        width: assets.width,
        height: assets.height,
        updatedAt: assets.updatedAt,
      })
      .from(assets)
      .where(eq(assets.shaderId, id));

    return {
      row: {
        id: row.id,
        ownerUserId: row.ownerUserId,
        kind: row.kind,
        name: row.name,
        description: row.description,
        author: row.author,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        revision: row.revision,
        projectJson: stringifyJson(row.projectJson),
        controlsJson: stringifyJson(row.controlsJson),
        renderJson: stringifyJson(row.renderJson),
        channelsJson: stringifyJson(row.channelsJson),
      },
      presets: presetRows.map((preset) => ({
        id: preset.id,
        name: preset.name,
        createdAt: preset.createdAt,
        valuesJson: stringifyJson(preset.valuesJson),
        renderJson: preset.renderJson === null ? null : stringifyJson(preset.renderJson),
      })),
      assets: assetRows.map(toAssetMeta),
    };
  }

  async loadAsset(scope: UserScope, id: string, key: AssetKey): Promise<StoredAsset | null> {
    // Joined rather than trusting the caller: this is the one asset read that is
    // reachable without a prior scoped load of the parent shader.
    const [row] = await this.db
      .select({ asset: assets })
      .from(assets)
      .innerJoin(shaders, eq(shaders.id, assets.shaderId))
      .where(and(eq(assets.shaderId, id), eq(assets.assetKey, key), readable(scope)))
      .limit(1);
    if (!row) return null;
    return { ...toAssetMeta(row.asset), data: row.asset.data };
  }

  async insertShader(row: ShaderRow): Promise<void> {
    try {
      await this.db.insert(shaders).values({
        id: row.id,
        ownerUserId: row.ownerUserId,
        kind: row.kind,
        name: row.name,
        description: row.description,
        author: row.author,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        revision: row.revision,
        projectJson: parseJson(row.projectJson),
        controlsJson: parseJson(row.controlsJson),
        renderJson: parseJson(row.renderJson),
        channelsJson: parseJson(row.channelsJson),
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new StorageError('conflict', `A shader with id "${row.id}" already exists`);
      }
      throw asStorageError(error, 'Failed to insert the shader');
    }
  }

  async updateShader(
    scope: UserScope,
    id: string,
    fields: ShaderMutableFields,
    expectedRevision?: number,
  ): Promise<number> {
    const owned = and(eq(shaders.id, id), eq(shaders.ownerUserId, scope.userId));
    const predicate =
      expectedRevision === undefined ? owned : and(owned, eq(shaders.revision, expectedRevision));
    const [updated] = await this.db
      .update(shaders)
      .set({
        name: fields.name,
        description: fields.description,
        author: fields.author,
        updatedAt: fields.updatedAt,
        projectJson: parseJson(fields.projectJson),
        controlsJson: parseJson(fields.controlsJson),
        renderJson: parseJson(fields.renderJson),
        channelsJson: parseJson(fields.channelsJson),
        revision: sql`${shaders.revision} + 1`,
      })
      .where(predicate)
      .returning({ revision: shaders.revision });

    if (!updated) {
      // Scoped on purpose: another user's shader reads as missing here, so a
      // probe cannot tell "not yours" apart from "does not exist".
      const [existing] = await this.db
        .select({ revision: shaders.revision })
        .from(shaders)
        .where(owned)
        .limit(1);
      if (!existing) throw new StorageError('not_found', `Shader "${id}" was not found`);
      throw new StorageError(
        'conflict',
        `Shader "${id}" was modified by another write (expected revision ${expectedRevision})`,
      );
    }
    return updated.revision;
  }

  /**
   * Locks the shader row, then, when conditional, reads the revision and
   * thumbnail in a new statement (a fresh snapshot under READ COMMITTED), then
   * deletes. Every child-row write holds the same lock first (see `PgOps`).
   */
  async deleteShader(
    scope: UserScope,
    id: string,
    expectedRevision?: number,
    expectedThumbnail?: string | null,
  ): Promise<boolean> {
    const owned = and(eq(shaders.id, id), eq(shaders.ownerUserId, scope.userId));
    const [locked] = await this.db
      .select({ id: shaders.id })
      .from(shaders)
      .where(owned)
      .for('update');
    if (!locked) return false;
    if (expectedRevision === undefined && expectedThumbnail === undefined) {
      await this.db.delete(shaders).where(owned);
      return true;
    }
    const [current] = await this.db
      .select({
        revision: shaders.revision,
        thumbnail: sql<string | null>`(SELECT ${assets.updatedAt} FROM ${assets}
          WHERE ${assets.shaderId} = ${shaders.id} AND ${assets.assetKey} = ${THUMBNAIL_ASSET_KEY})`,
      })
      .from(shaders)
      .where(owned);
    const matches =
      (expectedRevision === undefined || current.revision === expectedRevision) &&
      (expectedThumbnail === undefined || current.thumbnail === expectedThumbnail);
    if (!matches) {
      throw new StorageError('conflict', `Shader "${id}" was modified by another write`);
    }
    await this.db.delete(shaders).where(owned);
    return true;
  }

  async replacePresets(shaderId: string, rows: PresetRow[]): Promise<void> {
    await this.db.delete(presets).where(eq(presets.shaderId, shaderId));
    if (rows.length === 0) return;
    await this.db.insert(presets).values(
      rows.map((row) => ({
        shaderId,
        id: row.id,
        name: row.name,
        createdAt: row.createdAt,
        valuesJson: parseJson(row.valuesJson),
        renderJson: row.renderJson === null ? null : parseJson(row.renderJson),
      })),
    );
  }

  async putAsset(shaderId: string, asset: StoredAsset): Promise<void> {
    await this.db
      .insert(assets)
      .values({
        shaderId,
        assetKey: asset.key,
        extension: asset.extension,
        width: asset.width,
        height: asset.height,
        updatedAt: asset.updatedAt,
        data: asset.data,
      })
      .onConflictDoUpdate({
        target: [assets.shaderId, assets.assetKey],
        set: {
          extension: asset.extension,
          width: asset.width,
          height: asset.height,
          updatedAt: asset.updatedAt,
          data: asset.data,
        },
      });
  }

  async deleteAsset(shaderId: string, key: AssetKey): Promise<void> {
    await this.db
      .delete(assets)
      .where(and(eq(assets.shaderId, shaderId), eq(assets.assetKey, key)));
  }

  async putAssetIf(
    shaderId: string,
    asset: StoredAsset,
    expectedUpdatedAt: string | null,
  ): Promise<boolean> {
    const values = {
      extension: asset.extension,
      width: asset.width,
      height: asset.height,
      updatedAt: asset.updatedAt,
      data: asset.data,
    };
    const rows =
      expectedUpdatedAt === null
        ? await this.db
            .insert(assets)
            .values({ ...values, shaderId, assetKey: asset.key })
            .onConflictDoNothing({ target: [assets.shaderId, assets.assetKey] })
            .returning({ key: assets.assetKey })
        : await this.db
            .update(assets)
            .set(values)
            .where(
              and(
                eq(assets.shaderId, shaderId),
                eq(assets.assetKey, asset.key),
                eq(assets.updatedAt, expectedUpdatedAt),
              ),
            )
            .returning({ key: assets.assetKey });
    return rows.length > 0;
  }

  async deleteAssetIf(
    shaderId: string,
    key: AssetKey,
    expectedUpdatedAt: string,
  ): Promise<boolean> {
    const rows = await this.db
      .delete(assets)
      .where(
        and(
          eq(assets.shaderId, shaderId),
          eq(assets.assetKey, key),
          eq(assets.updatedAt, expectedUpdatedAt),
        ),
      )
      .returning({ key: assets.assetKey });
    return rows.length > 0;
  }

  async insertHistory(shaderId: string, row: HistoryRow): Promise<void> {
    try {
      await this.db.insert(shaderHistory).values({
        shaderId,
        revision: row.revision,
        createdAt: row.createdAt,
        checkpointName: row.checkpointName,
        cause: row.cause,
        restoredFromRevision: row.restoredFromRevision,
        projectJson: parseJson(row.projectJson),
        controlsJson: parseJson(row.controlsJson),
        renderJson: parseJson(row.renderJson),
        presetsJson: parseJson(row.presetsJson),
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new StorageError(
          'conflict',
          `Shader "${shaderId}" already has a history entry for revision ${row.revision}`,
        );
      }
      throw asStorageError(error, 'Failed to insert the history entry');
    }
  }

  listHistory(shaderId: string): Promise<HistoryEntryRow[]> {
    return this.db
      .select(historyEntryColumns)
      .from(shaderHistory)
      .where(eq(shaderHistory.shaderId, shaderId))
      .orderBy(desc(shaderHistory.revision));
  }

  async loadHistory(shaderId: string, revision: number): Promise<HistoryRow | null> {
    const [row] = await this.db
      .select()
      .from(shaderHistory)
      .where(and(eq(shaderHistory.shaderId, shaderId), eq(shaderHistory.revision, revision)))
      .limit(1);
    if (!row) return null;
    return {
      revision: row.revision,
      createdAt: row.createdAt,
      cause: row.cause,
      checkpointName: row.checkpointName,
      restoredFromRevision: row.restoredFromRevision,
      projectJson: stringifyJson(row.projectJson),
      controlsJson: stringifyJson(row.controlsJson),
      renderJson: stringifyJson(row.renderJson),
      presetsJson: stringifyJson(row.presetsJson),
    };
  }

  async hasHistory(shaderId: string): Promise<boolean> {
    const rows = await this.db
      .select({ revision: shaderHistory.revision })
      .from(shaderHistory)
      .where(eq(shaderHistory.shaderId, shaderId))
      .limit(1);
    return rows.length > 0;
  }

  async setHistoryCheckpoint(
    shaderId: string,
    revision: number,
    name: string | null,
  ): Promise<HistoryEntryRow | null> {
    const [row] = await this.db
      .update(shaderHistory)
      .set({ checkpointName: name })
      .where(and(eq(shaderHistory.shaderId, shaderId), eq(shaderHistory.revision, revision)))
      .returning(historyEntryColumns);
    return row ?? null;
  }

  async pruneHistory(shaderId: string, keepUnnamed: number): Promise<number> {
    const rows = await this.db
      .delete(shaderHistory)
      .where(
        and(
          eq(shaderHistory.shaderId, shaderId),
          isNull(shaderHistory.checkpointName),
          sql`${shaderHistory.revision} NOT IN (
            SELECT revision FROM shader_history
            WHERE shader_id = ${shaderId} AND checkpoint_name IS NULL
            ORDER BY revision DESC LIMIT ${keepUnnamed})`,
        ),
      )
      .returning({ revision: shaderHistory.revision });
    return rows.length;
  }

  async getMeta(key: string): Promise<string | null> {
    const [row] = await this.db
      .select({ value: storageMetadata.value })
      .from(storageMetadata)
      .where(eq(storageMetadata.key, key))
      .limit(1);
    return row?.value ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.db
      .insert(storageMetadata)
      .values({ key, value })
      .onConflictDoUpdate({ target: storageMetadata.key, set: { value } });
  }
}

/**
 * The pool, or an open transaction, as the publication store sees it. Its SQL
 * uses `?` placeholders and never a literal question mark, so splitting on one
 * is a faithful way to hand Drizzle the text and the parameters separately.
 */
function executor(db: Pick<PostgresDb, 'execute'>): SqlExecutor {
  const execute = (text: string, params: readonly unknown[] = []) =>
    db.execute(
      sql.join(
        text
          .split('?')
          .flatMap((part, index) =>
            index < params.length ? [sql.raw(part), sql.param(params[index])] : [sql.raw(part)],
          ),
      ),
    );
  return {
    all: async (text, params) => (await execute(text, params)).rows,
    run: async (text, params) => (await execute(text, params)).rowCount ?? 0,
  };
}

const historyEntryColumns = {
  revision: shaderHistory.revision,
  createdAt: shaderHistory.createdAt,
  cause: shaderHistory.cause,
  checkpointName: shaderHistory.checkpointName,
  restoredFromRevision: shaderHistory.restoredFromRevision,
};

function toAssetMeta(row: {
  assetKey: string;
  extension: string;
  width: number | null;
  height: number | null;
  updatedAt: string;
}): AssetMeta {
  return {
    key: row.assetKey as AssetKey,
    extension: row.extension,
    width: row.width,
    height: row.height,
    updatedAt: row.updatedAt,
  };
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function required<T>(value: T | null, label: string): T {
  if (value === null) throw new StorageError('io', `Stored ${label} is missing`);
  return value;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    (error as { cause?: { code?: string }; code?: string })?.code === '23505' ||
    (error as { cause?: { code?: string } })?.cause?.code === '23505'
  );
}

function asStorageError(error: unknown, fallback: string): StorageError {
  if (error instanceof StorageError) return error;
  console.error('[postgres]', error);
  return new StorageError('io', fallback);
}
