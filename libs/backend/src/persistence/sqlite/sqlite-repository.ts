/**
 * SQLite persistence via Node's built-in `node:sqlite` (`DatabaseSync`). Chosen
 * over a native module (better-sqlite3) so the Electron main process needs no
 * electron-rebuild and no electron-builder native handling: `node:sqlite` is
 * part of the runtime Electron already ships, and the main rollup config
 * externalizes `node:*` automatically. The whole driver is synchronous, so the
 * async `ShaderRepository` surface is thin wrappers over blocking calls, and a
 * single in-process mutex serializes transactions (one connection, no nested
 * BEGIN).
 */

// Attaches the ambient `node:sqlite` declarations (absent from @types/node@20) to
// this file, so packages that compile it through path mapping — the server, the
// Electron main — see the types too. A plain import cannot carry an ambient module.
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="./node-sqlite.d.ts" />
import { DatabaseSync, type SQLRow, type StatementSync } from 'node:sqlite';
import { drizzle as drizzleProxy } from 'drizzle-orm/sqlite-proxy';

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
  type AuthDatabase,
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
  THUMBNAIL_ASSET_KEY,
} from '../shader-repository';
import type { UserScope } from '../user-scope';
import { sqliteAuthSchema } from './auth-schema';
import { SQLITE_MIGRATIONS } from './migrations';

/**
 * What a scope may read: its own shaders, plus the shared templates. The
 * mirror-image predicate for writes is spelled out inline at each write, and is
 * always `owner_user_id = ?` alone.
 */
const READABLE_SHADER =
  "SELECT * FROM shaders WHERE id = ? AND (owner_user_id = ? OR kind = 'template')";

/** Serializes transactions so two never open a nested BEGIN on the one connection. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export interface SqliteRepositoryOptions {
  /** File path, or `:memory:` for a private in-memory database (tests). */
  location: string;
  /** Lock wait before SQLITE_BUSY, ms. */
  busyTimeoutMs?: number;
}

export class SqliteRepository implements ShaderRepository, PublicationRepository {
  private db: DatabaseSync | null = null;
  private authDb: object | null = null;
  private readonly mutex = new Mutex();

  constructor(private readonly options: SqliteRepositoryOptions) {}

  async init(): Promise<void> {
    // Safe to call more than once: drop any prior connection so re-init does not
    // leak a file handle (which on Windows would block deleting the database).
    this.db?.close();
    this.db = null;
    this.authDb = null;
    const db = new DatabaseSync(this.options.location);
    // Pragmas must run outside any transaction.
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, this.options.busyTimeoutMs ?? 5000)}`);
    if (this.options.location !== ':memory:') {
      try {
        db.exec('PRAGMA journal_mode = WAL');
      } catch {
        // A filesystem that cannot do WAL (some network shares) falls back to
        // the default rollback journal — correct, just less concurrent.
      }
    }
    this.db = db;

    try {
      db.exec('BEGIN IMMEDIATE');
      await runMigrations(SQLITE_MIGRATIONS, {
        getVersion: () =>
          Number((db.prepare('PRAGMA user_version').get() as SQLRow)['user_version']),
        setVersion: (version) => db.exec(`PRAGMA user_version = ${version}`),
        exec: (sql) => db.exec(sql),
      });
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // no active transaction to roll back
      }
      throw asStorageError(error, 'Failed to migrate the SQLite database');
    }
  }

  /**
   * A Drizzle handle over this same connection, for Better Auth.
   *
   * `node:sqlite` has no Drizzle driver of its own, so `sqlite-proxy` is given
   * a callback that runs statements on the one open `DatabaseSync`. Sharing the
   * connection matters on Windows, where a second handle on the same file would
   * contend for locks and keep the file busy after close.
   */
  authDatabase(): AuthDatabase {
    this.authDb ??= drizzleProxy(
      async (sql, params, method) => {
        const db = this.database();
        const statement = db.prepare(sql);
        const bind = params as Parameters<StatementSync['all']>;
        if (method === 'run') {
          statement.run(...bind);
          return { rows: [] };
        }
        // `get`/`all`/`values` all want positional cells, and `node:sqlite`
        // returns objects — in SELECT order, which is what Drizzle expects.
        const cells = (row: SQLRow): unknown[] => Object.values(row);
        if (method === 'get') {
          const row = statement.get(...bind);
          return { rows: row ? cells(row) : [] };
        }
        return { rows: statement.all(...bind).map(cells) };
      },
      { schema: sqliteAuthSchema },
    );
    return { provider: 'sqlite', db: this.authDb };
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
    this.authDb = null;
  }

  transaction<T>(work: (tx: ShaderTx) => Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      const db = this.database();
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await work(new SqliteTx(db));
        db.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // already rolled back
        }
        throw asStorageError(error, 'SQLite transaction failed');
      }
    });
  }

  get publications(): PublicationStore {
    return new PublicationStore(executor(this.database()), 'sqlite');
  }

  publicationTransaction<T>(
    work: (tx: ShaderTx, publications: PublicationStore) => Promise<T>,
  ): Promise<T> {
    return this.transaction((tx) => work(tx, this.publications));
  }

  async listShaders(scope: UserScope): Promise<ShaderSummaryRow[]> {
    const rows = this.database()
      .prepare(
        `SELECT s.id, s.kind, s.name, s.description, s.updated_at, s.revision, s.controls_json,
                (SELECT COUNT(*) FROM presets p WHERE p.shader_id = s.id) AS preset_count,
                t.extension AS thumb_ext, t.updated_at AS thumb_updated
         FROM shaders s
         LEFT JOIN assets t ON t.shader_id = s.id AND t.asset_key = 'thumbnail'
         WHERE s.owner_user_id = ? OR s.kind = 'template'`,
      )
      .all(scope.userId);
    return rows.map(toSummaryRow);
  }

  async loadShader(scope: UserScope, id: string): Promise<StoredShader | null> {
    return new SqliteTx(this.database()).loadShader(scope, id);
  }

  async loadAsset(scope: UserScope, id: string, key: AssetKey): Promise<StoredAsset | null> {
    return new SqliteTx(this.database()).loadAsset(scope, id, key);
  }

  async listHistory(shaderId: string): Promise<HistoryEntryRow[]> {
    return new SqliteTx(this.database()).listHistory(shaderId);
  }

  async getMeta(key: string): Promise<string | null> {
    return new SqliteTx(this.database()).getMeta(key);
  }

  async setMeta(key: string, value: string): Promise<void> {
    return new SqliteTx(this.database()).setMeta(key, value);
  }

  private database(): DatabaseSync {
    if (!this.db) throw new StorageError('io', 'The database is not open');
    return this.db;
  }
}

/** All statement work goes through here; the repo's own reads reuse it on the shared connection. */
class SqliteTx implements ShaderTx {
  constructor(private readonly db: DatabaseSync) {}

  async listIds(scope: UserScope): Promise<string[]> {
    return this.db
      .prepare('SELECT id FROM shaders WHERE owner_user_id = ? ORDER BY id')
      .all(scope.userId)
      .map((row) => String(row['id']));
  }

  async loadShader(scope: UserScope, id: string): Promise<StoredShader | null> {
    // Reads admit the shared templates; writes never do — see updateShader.
    const row = this.db.prepare(READABLE_SHADER).get(id, scope.userId);
    if (!row) return null;

    const presets = this.db
      .prepare(
        'SELECT id, name, created_at, values_json, render_json FROM presets WHERE shader_id = ? ORDER BY created_at, id',
      )
      .all(id)
      .map(toPresetRow);

    const assets = this.db
      .prepare(
        'SELECT asset_key, extension, width, height, updated_at FROM assets WHERE shader_id = ?',
      )
      .all(id)
      .map(toAssetMeta);

    return { row: toShaderRow(row), presets, assets };
  }

  async loadAsset(scope: UserScope, id: string, key: AssetKey): Promise<StoredAsset | null> {
    const row = this.db
      .prepare(
        `SELECT a.asset_key, a.extension, a.width, a.height, a.updated_at, a.data
         FROM assets a
         JOIN shaders s ON s.id = a.shader_id
         WHERE a.shader_id = ? AND a.asset_key = ?
           AND (s.owner_user_id = ? OR s.kind = 'template')`,
      )
      .get(id, key, scope.userId);
    if (!row) return null;
    return { ...toAssetMeta(row), data: toBytes(row['data']) };
  }

  async insertShader(row: ShaderRow): Promise<void> {
    this.exec(
      `INSERT INTO shaders (id, owner_user_id, kind, name, description, author,
                            created_at, updated_at, revision,
                            project_json, controls_json, render_json, channels_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      (stmt) =>
        stmt.run(
          row.id,
          row.ownerUserId,
          row.kind,
          row.name,
          row.description,
          row.author,
          row.createdAt,
          row.updatedAt,
          row.revision,
          row.projectJson,
          row.controlsJson,
          row.renderJson,
          row.channelsJson,
        ),
      `A shader with id "${row.id}" already exists`,
    );
  }

  async updateShader(
    scope: UserScope,
    id: string,
    fields: ShaderMutableFields,
    expectedRevision?: number,
  ): Promise<number> {
    const expected = expectedRevision ?? null;
    const result = this.db
      .prepare(
        `UPDATE shaders
         SET name = ?, description = ?, author = ?, updated_at = ?,
             project_json = ?, controls_json = ?, render_json = ?, channels_json = ?,
             revision = revision + 1
         WHERE id = ? AND owner_user_id = ? AND (? IS NULL OR revision = ?)`,
      )
      .run(
        fields.name,
        fields.description,
        fields.author,
        fields.updatedAt,
        fields.projectJson,
        fields.controlsJson,
        fields.renderJson,
        fields.channelsJson,
        id,
        scope.userId,
        expected,
        expected,
      );

    if (Number(result.changes) === 0) {
      // Scoped on purpose: another user's shader reads as missing here, so a
      // probe cannot tell "not yours" apart from "does not exist".
      const existing = this.db
        .prepare('SELECT revision FROM shaders WHERE id = ? AND owner_user_id = ?')
        .get(id, scope.userId);
      if (!existing) throw new StorageError('not_found', `Shader "${id}" was not found`);
      throw new StorageError(
        'conflict',
        `Shader "${id}" was modified by another write (expected revision ${expectedRevision})`,
      );
    }

    const after = this.db.prepare('SELECT revision FROM shaders WHERE id = ?').get(id) as SQLRow;
    return Number(after['revision']);
  }

  async deleteShader(
    scope: UserScope,
    id: string,
    expectedRevision?: number,
    expectedThumbnail?: string | null,
  ): Promise<boolean> {
    const expected = expectedRevision ?? null;
    // '' stands for "no thumbnail": a stored `updated_at` is never empty. One
    // statement is enough: SQLite runs one write transaction at a time, so no
    // thumbnail write can commit between this check and the cascade.
    const thumbnail = expectedThumbnail === undefined ? null : (expectedThumbnail ?? '');
    const result = this.db
      .prepare(
        `DELETE FROM shaders WHERE id = ? AND owner_user_id = ? AND (? IS NULL OR revision = ?)
           AND (? IS NULL OR COALESCE((SELECT updated_at FROM assets
             WHERE shader_id = shaders.id AND asset_key = ?), '') = ?)`,
      )
      .run(id, scope.userId, expected, expected, thumbnail, THUMBNAIL_ASSET_KEY, thumbnail);
    if (Number(result.changes) > 0) return true;
    if (expectedRevision === undefined && expectedThumbnail === undefined) return false;

    const existing = this.db
      .prepare('SELECT revision FROM shaders WHERE id = ? AND owner_user_id = ?')
      .get(id, scope.userId);
    if (!existing) return false;
    throw new StorageError('conflict', `Shader "${id}" was modified by another write`);
  }

  async replacePresets(shaderId: string, presets: PresetRow[]): Promise<void> {
    this.db.prepare('DELETE FROM presets WHERE shader_id = ?').run(shaderId);
    const stmt = this.db.prepare(
      `INSERT INTO presets (shader_id, id, name, created_at, values_json, render_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const preset of presets) {
      stmt.run(
        shaderId,
        preset.id,
        preset.name,
        preset.createdAt,
        preset.valuesJson,
        preset.renderJson,
      );
    }
  }

  async putAsset(shaderId: string, asset: StoredAsset): Promise<void> {
    this.exec(
      `INSERT OR REPLACE INTO assets (shader_id, asset_key, extension, width, height, updated_at, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      (stmt) =>
        stmt.run(
          shaderId,
          asset.key,
          asset.extension,
          asset.width,
          asset.height,
          asset.updatedAt,
          asset.data,
        ),
      `Failed to store asset "${asset.key}"`,
    );
  }

  async deleteAsset(shaderId: string, key: AssetKey): Promise<void> {
    this.db.prepare('DELETE FROM assets WHERE shader_id = ? AND asset_key = ?').run(shaderId, key);
  }

  async putAssetIf(
    shaderId: string,
    asset: StoredAsset,
    expectedUpdatedAt: string | null,
  ): Promise<boolean> {
    const values = [asset.extension, asset.width, asset.height, asset.updatedAt, asset.data];
    const result =
      expectedUpdatedAt === null
        ? this.db
            .prepare(
              `INSERT INTO assets (extension, width, height, updated_at, data, shader_id, asset_key)
               VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (shader_id, asset_key) DO NOTHING`,
            )
            .run(...values, shaderId, asset.key)
        : this.db
            .prepare(
              `UPDATE assets SET extension = ?, width = ?, height = ?, updated_at = ?, data = ?
               WHERE shader_id = ? AND asset_key = ? AND updated_at = ?`,
            )
            .run(...values, shaderId, asset.key, expectedUpdatedAt);
    return Number(result.changes) > 0;
  }

  async deleteAssetIf(
    shaderId: string,
    key: AssetKey,
    expectedUpdatedAt: string,
  ): Promise<boolean> {
    const result = this.db
      .prepare('DELETE FROM assets WHERE shader_id = ? AND asset_key = ? AND updated_at = ?')
      .run(shaderId, key, expectedUpdatedAt);
    return Number(result.changes) > 0;
  }

  async insertHistory(shaderId: string, row: HistoryRow): Promise<void> {
    this.exec(
      `INSERT INTO shader_history (shader_id, revision, created_at, checkpoint_name, cause,
                                   restored_from_revision, project_json, controls_json,
                                   render_json, presets_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      (stmt) =>
        stmt.run(
          shaderId,
          row.revision,
          row.createdAt,
          row.checkpointName,
          row.cause,
          row.restoredFromRevision,
          row.projectJson,
          row.controlsJson,
          row.renderJson,
          row.presetsJson,
        ),
      `Shader "${shaderId}" already has a history entry for revision ${row.revision}`,
    );
  }

  async listHistory(shaderId: string): Promise<HistoryEntryRow[]> {
    return this.db
      .prepare(
        `SELECT revision, created_at, checkpoint_name, cause, restored_from_revision
         FROM shader_history WHERE shader_id = ? ORDER BY revision DESC`,
      )
      .all(shaderId)
      .map(toHistoryEntryRow);
  }

  async loadHistory(shaderId: string, revision: number): Promise<HistoryRow | null> {
    const row = this.db
      .prepare('SELECT * FROM shader_history WHERE shader_id = ? AND revision = ?')
      .get(shaderId, revision);
    if (!row) return null;
    return {
      ...toHistoryEntryRow(row),
      projectJson: String(row['project_json']),
      controlsJson: String(row['controls_json']),
      renderJson: String(row['render_json']),
      presetsJson: String(row['presets_json']),
    };
  }

  async hasHistory(shaderId: string): Promise<boolean> {
    return (
      this.db.prepare('SELECT 1 FROM shader_history WHERE shader_id = ? LIMIT 1').get(shaderId) !==
      undefined
    );
  }

  async setHistoryCheckpoint(
    shaderId: string,
    revision: number,
    name: string | null,
  ): Promise<HistoryEntryRow | null> {
    this.db
      .prepare('UPDATE shader_history SET checkpoint_name = ? WHERE shader_id = ? AND revision = ?')
      .run(name, shaderId, revision);
    const row = this.db
      .prepare(
        `SELECT revision, created_at, checkpoint_name, cause, restored_from_revision
         FROM shader_history WHERE shader_id = ? AND revision = ?`,
      )
      .get(shaderId, revision);
    return row ? toHistoryEntryRow(row) : null;
  }

  async pruneHistory(shaderId: string, keepUnnamed: number): Promise<number> {
    const result = this.db
      .prepare(
        `DELETE FROM shader_history
         WHERE shader_id = ? AND checkpoint_name IS NULL
           AND revision NOT IN (
             SELECT revision FROM shader_history
             WHERE shader_id = ? AND checkpoint_name IS NULL
             ORDER BY revision DESC LIMIT ?)`,
      )
      .run(shaderId, shaderId, keepUnnamed);
    return Number(result.changes);
  }

  async getMeta(key: string): Promise<string | null> {
    const row = this.db.prepare('SELECT value FROM storage_metadata WHERE key = ?').get(key);
    return row ? String(row['value']) : null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.db
      .prepare('INSERT OR REPLACE INTO storage_metadata (key, value) VALUES (?, ?)')
      .run(key, value);
  }

  /** Runs a mutating statement, translating a constraint violation into a domain error. */
  private exec(sql: string, bind: (stmt: StatementSync) => void, conflictMessage: string): void {
    try {
      bind(this.db.prepare(sql));
    } catch (error) {
      if (isConstraintError(error)) throw new StorageError('conflict', conflictMessage);
      throw asStorageError(error, 'SQLite write failed');
    }
  }
}

/** The one open connection as the publication store sees it; a transaction is whatever is open on it. */
function executor(db: DatabaseSync): SqlExecutor {
  type Bind = Parameters<StatementSync['all']>;
  return {
    all: async (sql, params = []) => db.prepare(sql).all(...(params as Bind)),
    run: async (sql, params = []) => Number(db.prepare(sql).run(...(params as Bind)).changes),
  };
}

function toShaderRow(row: SQLRow): ShaderRow {
  return {
    id: String(row['id']),
    ownerUserId: String(row['owner_user_id']),
    kind: String(row['kind']) === 'template' ? 'template' : 'shader',
    name: String(row['name']),
    description: String(row['description']),
    author: row['author'] === null ? null : String(row['author']),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
    revision: Number(row['revision']),
    projectJson: String(row['project_json']),
    controlsJson: String(row['controls_json']),
    renderJson: String(row['render_json']),
    channelsJson: String(row['channels_json']),
  };
}

function toPresetRow(row: SQLRow): PresetRow {
  return {
    id: String(row['id']),
    name: String(row['name']),
    createdAt: String(row['created_at']),
    valuesJson: String(row['values_json']),
    renderJson: row['render_json'] === null ? null : String(row['render_json']),
  };
}

function toHistoryEntryRow(row: SQLRow): HistoryEntryRow {
  return {
    revision: Number(row['revision']),
    createdAt: String(row['created_at']),
    cause: String(row['cause']) as HistoryEntryRow['cause'],
    checkpointName: row['checkpoint_name'] === null ? null : String(row['checkpoint_name']),
    restoredFromRevision:
      row['restored_from_revision'] === null ? null : Number(row['restored_from_revision']),
  };
}

function toAssetMeta(row: SQLRow): AssetMeta {
  return {
    key: String(row['asset_key']) as AssetKey,
    extension: String(row['extension']),
    width: row['width'] === null ? null : Number(row['width']),
    height: row['height'] === null ? null : Number(row['height']),
    updatedAt: String(row['updated_at']),
  };
}

function toSummaryRow(row: SQLRow): ShaderSummaryRow {
  return {
    id: String(row['id']),
    kind: String(row['kind']) === 'template' ? 'template' : 'shader',
    name: String(row['name']),
    description: String(row['description']),
    updatedAt: String(row['updated_at']),
    revision: Number(row['revision']),
    controlCount: countArray(row['controls_json']),
    presetCount: Number(row['preset_count'] ?? 0),
    thumbnail:
      row['thumb_ext'] === null || row['thumb_ext'] === undefined
        ? null
        : { extension: String(row['thumb_ext']), updatedAt: String(row['thumb_updated']) },
  };
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new StorageError('io', 'Stored asset is not binary');
}

/** Length of a JSON array stored as text; 0 if it is missing or corrupt. */
function countArray(value: unknown): number {
  if (typeof value !== 'string') return 0;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function isConstraintError(error: unknown): boolean {
  const code = (error as { code?: string; errcode?: number })?.code;
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === 'ERR_SQLITE_ERROR' &&
    (/UNIQUE constraint/i.test(message) || /PRIMARY KEY/i.test(message))
  );
}

function asStorageError(error: unknown, fallback: string): StorageError {
  if (error instanceof StorageError) return error;
  // Never surface the raw SQLite message (it can name columns/paths) to callers.
  console.error('[sqlite]', error);
  return new StorageError('io', fallback);
}
