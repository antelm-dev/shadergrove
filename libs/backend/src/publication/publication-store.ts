/**
 * Persistence for public snapshots and their moderation, kept apart from the
 * private library's `ShaderRepository`: a publication is a separate row with
 * its own copy of the sources and image bytes, so nothing about making one
 * public ever widens what a query over `shaders` can return.
 *
 * Unlike the shader tables, these were born after both engines existed, so they
 * are declared once in portable SQL (text, integer, one blob type) and queried
 * once, here, through a two-method executor each engine supplies. JSON is
 * stored as text and booleans as 0/1 on both.
 */

import type { PublicationSort } from '@shadergrove/shared/publication';

import type { AssetKey, ShaderTx } from '../persistence/shader-repository';

export type SqlValue = string | number | null | Uint8Array;

/** The engine's connection (or open transaction), reduced to what this file needs. */
export interface SqlExecutor {
  /** Runs `sql` with positional `?` parameters; rows are keyed by column name. */
  all(sql: string, params?: readonly SqlValue[]): Promise<Record<string, unknown>[]>;
  /** As `all`, for a write: the number of rows changed. */
  run(sql: string, params?: readonly SqlValue[]): Promise<number>;
}

export interface PublicationRepository {
  /** Reads outside a transaction. */
  readonly publications: PublicationStore;
  /**
   * One transaction over both domains, so the private shader being snapshotted
   * and the publication written from it commit or roll back together.
   */
  publicationTransaction<T>(
    work: (tx: ShaderTx, publications: PublicationStore) => Promise<T>,
  ): Promise<T>;
}

export interface PublicationRow {
  id: string;
  sourceShaderId: string;
  ownerUserId: string;
  title: string;
  description: string;
  authorLabel: string;
  license: string;
  attribution: string;
  derivedFromJson: string | null;
  ownerVisible: boolean;
  moderatorHidden: boolean;
  revision: number;
  moderationRevision: number;
  sourceRevision: number;
  publishedAt: string;
  updatedAt: string;
  hasThumbnail: boolean;
  openReports: number;
  publisherRestricted: boolean;
}

/** The columns an owner's publish writes; visibility and revisions are the store's. */
export interface PublicationContent {
  title: string;
  description: string;
  authorLabel: string;
  license: string;
  attribution: string;
  derivedFromJson: string | null;
  sourceRevision: number;
  snapshotJson: string;
}

export interface PublicationAsset {
  key: AssetKey;
  extension: string;
  width: number | null;
  height: number | null;
  data: Uint8Array;
}

export interface ReportRow {
  id: string;
  publicationId: string;
  publicationTitle: string;
  reporterUserId: string;
  reason: string;
  body: string;
  createdAt: string;
  status: string;
  revision: number;
  resolvedAt: string | null;
  resolution: string | null;
}

export interface RestrictionRow {
  restricted: boolean;
  revision: number;
  reason: string;
  updatedAt: string;
}

export interface AuditRow {
  id: string;
  at: string;
  actorUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  reason: string;
}

/** Keyset position: rows strictly before this `(time, id)` in descending order. */
export interface PageCursor {
  at: string;
  id: string;
}

export interface PublicationListQuery {
  /** `visible`: owner-visible and not moderator-hidden. `hidden`: the rest. */
  state?: 'visible' | 'hidden';
  search?: string;
  /** `title` (the default) matches the title only; `public` also the description and author label. */
  searchIn?: 'title' | 'public';
  /** `updated` (the default) or `published`: newest first by that time, then by id. */
  sort?: PublicationSort;
  /** A position in the chosen `sort`: `at` is that sort's time. */
  before?: PageCursor;
  limit: number;
}

/**
 * Additive schema for both engines; `blob` is the one type they spell
 * differently. Publications and restrictions hang off `users` and `shaders`
 * with `ON DELETE CASCADE`, so deleting a source shader or an account removes
 * every public trace of it in the same statement. The audit trail deliberately
 * references nothing: it has to outlive what it describes.
 */
export function publicationSchemaSql(blob: 'BLOB' | 'bytea'): string {
  return `
    CREATE TABLE publications (
      id                  TEXT PRIMARY KEY,
      source_shader_id    TEXT NOT NULL UNIQUE REFERENCES shaders(id) ON DELETE CASCADE,
      owner_user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title               TEXT NOT NULL,
      description         TEXT NOT NULL,
      author_label        TEXT NOT NULL,
      license             TEXT NOT NULL,
      attribution         TEXT NOT NULL,
      derived_from_json   TEXT,
      owner_visible       INTEGER NOT NULL,
      moderator_hidden    INTEGER NOT NULL,
      revision            INTEGER NOT NULL,
      moderation_revision INTEGER NOT NULL,
      source_revision     INTEGER NOT NULL,
      published_at        TEXT NOT NULL,
      updated_at          TEXT NOT NULL,
      snapshot_json       TEXT NOT NULL
    );

    CREATE TABLE publication_assets (
      publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
      asset_key      TEXT NOT NULL,
      extension      TEXT NOT NULL,
      width          INTEGER,
      height         INTEGER,
      data           ${blob} NOT NULL,
      PRIMARY KEY (publication_id, asset_key)
    );

    CREATE TABLE shader_origins (
      shader_id   TEXT PRIMARY KEY REFERENCES shaders(id) ON DELETE CASCADE,
      origin_json TEXT NOT NULL,
      copied_at   TEXT NOT NULL
    );

    CREATE TABLE publication_reports (
      id               TEXT PRIMARY KEY,
      publication_id   TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
      reporter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reason           TEXT NOT NULL,
      body             TEXT NOT NULL,
      created_at       TEXT NOT NULL,
      status           TEXT NOT NULL,
      revision         INTEGER NOT NULL,
      resolved_at      TEXT,
      resolution       TEXT
    );

    CREATE TABLE publisher_restrictions (
      user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      restricted INTEGER NOT NULL,
      revision   INTEGER NOT NULL,
      reason     TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE moderation_audit (
      id            TEXT PRIMARY KEY,
      created_at    TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      action        TEXT NOT NULL,
      target_type   TEXT NOT NULL,
      target_id     TEXT NOT NULL,
      reason        TEXT NOT NULL
    );

    CREATE INDEX idx_publications_listing ON publications(updated_at DESC, id DESC);
    CREATE INDEX idx_publications_owner ON publications(owner_user_id);
    CREATE INDEX idx_reports_listing ON publication_reports(created_at DESC, id DESC);
    CREATE UNIQUE INDEX idx_reports_one_open
      ON publication_reports(publication_id, reporter_user_id) WHERE status = 'open';
    CREATE INDEX idx_moderation_audit_listing ON moderation_audit(created_at DESC, id DESC);
  `;
}

const VISIBLE = 'p.owner_visible = 1 AND p.moderator_hidden = 0';

/** What a public search reads: the snapshot's own text, never anything private. */
const PUBLIC_SEARCH_FIELDS = ['p.title', 'p.description', 'p.author_label'];

const PUBLICATION_COLUMNS = `
  p.id, p.source_shader_id, p.owner_user_id, p.title, p.description, p.author_label, p.license,
  p.attribution, p.derived_from_json, p.owner_visible, p.moderator_hidden, p.revision,
  p.moderation_revision, p.source_revision, p.published_at, p.updated_at,
  (SELECT COUNT(*) FROM publication_assets a
    WHERE a.publication_id = p.id AND a.asset_key = 'thumbnail') AS thumbnails,
  (SELECT COUNT(*) FROM publication_reports r
    WHERE r.publication_id = p.id AND r.status = 'open') AS open_reports,
  (SELECT COUNT(*) FROM publisher_restrictions x
    WHERE x.user_id = p.owner_user_id AND x.restricted = 1) AS restrictions`;

const REPORT_COLUMNS = `
  r.id, r.publication_id, p.title AS publication_title, r.reporter_user_id, r.reason, r.body,
  r.created_at, r.status, r.revision, r.resolved_at, r.resolution`;

export class PublicationStore {
  constructor(
    private readonly db: SqlExecutor,
    /** Only Postgres needs (or understands) an explicit row lock; SQLite runs one writer at a time. */
    private readonly dialect: 'sqlite' | 'pg',
  ) {}

  // --- publications ---------------------------------------------------------

  async find(id: string): Promise<PublicationRow | null> {
    const [row] = await this.db.all(
      `SELECT ${PUBLICATION_COLUMNS} FROM publications p WHERE p.id = ?`,
      [id],
    );
    return row ? toPublicationRow(row) : null;
  }

  /**
   * The row and its snapshot in one statement. Read separately, an owner's
   * update landing in between would pair the old title, license and revision
   * with the new sources.
   */
  async findWithSnapshot(
    id: string,
  ): Promise<{ row: PublicationRow; snapshotJson: string } | null> {
    const [row] = await this.db.all(
      `SELECT ${PUBLICATION_COLUMNS}, p.snapshot_json FROM publications p WHERE p.id = ?`,
      [id],
    );
    return row ? { row: toPublicationRow(row), snapshotJson: String(row['snapshot_json']) } : null;
  }

  async findBySource(shaderId: string): Promise<PublicationRow | null> {
    const [row] = await this.db.all(
      `SELECT ${PUBLICATION_COLUMNS} FROM publications p WHERE p.source_shader_id = ?`,
      [shaderId],
    );
    return row ? toPublicationRow(row) : null;
  }

  /**
   * Newest first by `(updated_at, id)`, or `(published_at, id)` — a total order
   * either way, so paging a static listing never skips or repeats.
   */
  async list(query: PublicationListQuery): Promise<PublicationRow[]> {
    // A fixed pair of columns, never anything taken from the query.
    const time = query.sort === 'published' ? 'p.published_at' : 'p.updated_at';
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (query.state === 'visible') where.push(VISIBLE);
    if (query.state === 'hidden') where.push(`NOT (${VISIBLE})`);
    if (query.search) {
      const term = `%${query.search.toLowerCase().replace(/[!%_]/g, '!$&')}%`;
      const fields = query.searchIn === 'public' ? PUBLIC_SEARCH_FIELDS : ['p.title'];
      where.push(`(${fields.map((field) => `LOWER(${field}) LIKE ? ESCAPE '!'`).join(' OR ')})`);
      params.push(...fields.map(() => term));
    }
    if (query.before) {
      where.push(`(${time} < ? OR (${time} = ? AND p.id < ?))`);
      params.push(query.before.at, query.before.at, query.before.id);
    }
    const rows = await this.db.all(
      `SELECT ${PUBLICATION_COLUMNS} FROM publications p
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY ${time} DESC, p.id DESC LIMIT ?`,
      [...params, query.limit],
    );
    return rows.map(toPublicationRow);
  }

  async snapshot(id: string): Promise<string | null> {
    const [row] = await this.db.all('SELECT snapshot_json FROM publications WHERE id = ?', [id]);
    return row ? String(row['snapshot_json']) : null;
  }

  async insert(
    id: string,
    sourceShaderId: string,
    ownerUserId: string,
    content: PublicationContent,
    now: string,
  ): Promise<void> {
    await this.db.run(
      `INSERT INTO publications (
         id, source_shader_id, owner_user_id, title, description, author_label, license,
         attribution, derived_from_json, source_revision, snapshot_json,
         owner_visible, moderator_hidden, revision, moderation_revision, published_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 1, 1, ?, ?)`,
      [id, sourceShaderId, ownerUserId, ...contentValues(content), now, now],
    );
  }

  /**
   * An explicit update or a republish: new content, next revision, owner-visible
   * again. `moderator_hidden` is not in the statement at all, which is what
   * keeps an owner from publishing their way out of a takedown.
   */
  async replaceContent(id: string, content: PublicationContent, now: string): Promise<void> {
    await this.db.run(
      `UPDATE publications
       SET title = ?, description = ?, author_label = ?, license = ?, attribution = ?,
           derived_from_json = ?, source_revision = ?, snapshot_json = ?,
           owner_visible = 1, revision = revision + 1, updated_at = ?
       WHERE id = ?`,
      [...contentValues(content), now, id],
    );
  }

  async setOwnerVisible(id: string, visible: boolean): Promise<void> {
    await this.db.run('UPDATE publications SET owner_visible = ? WHERE id = ?', [
      visible ? 1 : 0,
      id,
    ]);
  }

  async replaceAssets(id: string, assets: readonly PublicationAsset[]): Promise<void> {
    await this.db.run('DELETE FROM publication_assets WHERE publication_id = ?', [id]);
    for (const asset of assets) {
      await this.db.run(
        `INSERT INTO publication_assets (publication_id, asset_key, extension, width, height, data)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, asset.key, asset.extension, asset.width, asset.height, asset.data],
      );
    }
  }

  /**
   * One asset's bytes. With `visibleOnly` the visibility test is part of the
   * same statement, so a request racing a takedown either sees the publication
   * as it was or not at all — never bytes of something already hidden.
   */
  async asset(id: string, key: AssetKey, visibleOnly: boolean): Promise<PublicationAsset | null> {
    const [row] = await this.db.all(
      `SELECT a.asset_key, a.extension, a.width, a.height, a.data
       FROM publication_assets a JOIN publications p ON p.id = a.publication_id
       WHERE a.publication_id = ? AND a.asset_key = ?${visibleOnly ? ` AND ${VISIBLE}` : ''}`,
      [id, key],
    );
    return row ? toAsset(row) : null;
  }

  async assets(id: string): Promise<PublicationAsset[]> {
    const rows = await this.db.all(
      `SELECT asset_key, extension, width, height, data FROM publication_assets
       WHERE publication_id = ?`,
      [id],
    );
    return rows.map(toAsset);
  }

  // --- provenance -----------------------------------------------------------

  async origin(shaderId: string): Promise<string | null> {
    const [row] = await this.db.all('SELECT origin_json FROM shader_origins WHERE shader_id = ?', [
      shaderId,
    ]);
    return row ? String(row['origin_json']) : null;
  }

  async putOrigin(shaderId: string, originJson: string, now: string): Promise<void> {
    await this.db.run(
      'INSERT INTO shader_origins (shader_id, origin_json, copied_at) VALUES (?, ?, ?)',
      [shaderId, originJson, now],
    );
  }

  // --- moderation -----------------------------------------------------------

  /** Compare-and-set on `moderation_revision`; `false` means it moved on (or the row is gone). */
  async setModeratorHidden(id: string, hidden: boolean, expected: number): Promise<boolean> {
    const changed = await this.db.run(
      `UPDATE publications
       SET moderator_hidden = ?, moderation_revision = moderation_revision + 1
       WHERE id = ? AND moderation_revision = ?`,
      [hidden ? 1 : 0, id, expected],
    );
    return changed > 0;
  }

  async hideAllByOwner(userId: string): Promise<void> {
    await this.db.run(
      `UPDATE publications
       SET moderator_hidden = 1, moderation_revision = moderation_revision + 1
       WHERE owner_user_id = ? AND moderator_hidden = 0`,
      [userId],
    );
  }

  async userExists(userId: string): Promise<boolean> {
    return (await this.db.all('SELECT id FROM users WHERE id = ?', [userId])).length > 0;
  }

  /**
   * Serializes a publish against a restriction of the same account. Without it
   * a publish that read "not restricted" could commit a fresh, visible
   * publication just after the restriction hid all the others.
   */
  async lockPublisher(userId: string): Promise<void> {
    if (this.dialect === 'pg') {
      await this.db.all('SELECT id FROM users WHERE id = ? FOR UPDATE', [userId]);
    }
  }

  /** Holds the publication against an owner's update while its snapshot and assets are read together. */
  async lockPublication(id: string): Promise<void> {
    if (this.dialect === 'pg') {
      await this.db.all('SELECT id FROM publications WHERE id = ? FOR SHARE', [id]);
    }
  }

  async restriction(userId: string): Promise<RestrictionRow | null> {
    const [row] = await this.db.all(
      'SELECT restricted, revision, reason, updated_at FROM publisher_restrictions WHERE user_id = ?',
      [userId],
    );
    if (!row) return null;
    return {
      restricted: Number(row['restricted']) === 1,
      revision: Number(row['revision']),
      reason: String(row['reason']),
      updatedAt: String(row['updated_at']),
    };
  }

  /** Compare-and-set on the restriction's revision; an account never restricted is at 0. */
  async setRestriction(
    userId: string,
    restricted: boolean,
    reason: string,
    expected: number,
    now: string,
  ): Promise<boolean> {
    const flag = restricted ? 1 : 0;
    const changed =
      expected === 0
        ? await this.db.run(
            `INSERT INTO publisher_restrictions (user_id, restricted, revision, reason, updated_at)
             VALUES (?, ?, 1, ?, ?) ON CONFLICT DO NOTHING`,
            [userId, flag, reason, now],
          )
        : await this.db.run(
            `UPDATE publisher_restrictions
             SET restricted = ?, revision = revision + 1, reason = ?, updated_at = ?
             WHERE user_id = ? AND revision = ?`,
            [flag, reason, now, userId, expected],
          );
    return changed > 0;
  }

  // --- reports --------------------------------------------------------------

  /** `false` when this reporter already has an open report on the publication. */
  async insertReport(report: {
    id: string;
    publicationId: string;
    reporterUserId: string;
    reason: string;
    body: string;
    now: string;
  }): Promise<boolean> {
    const changed = await this.db.run(
      `INSERT INTO publication_reports
         (id, publication_id, reporter_user_id, reason, body, created_at, status, revision)
       VALUES (?, ?, ?, ?, ?, ?, 'open', 1) ON CONFLICT DO NOTHING`,
      [
        report.id,
        report.publicationId,
        report.reporterUserId,
        report.reason,
        report.body,
        report.now,
      ],
    );
    return changed > 0;
  }

  async findReport(id: string): Promise<ReportRow | null> {
    const [row] = await this.db.all(
      `SELECT ${REPORT_COLUMNS} FROM publication_reports r
       JOIN publications p ON p.id = r.publication_id WHERE r.id = ?`,
      [id],
    );
    return row ? toReportRow(row) : null;
  }

  async listReports(query: {
    status?: string;
    publicationId?: string;
    before?: PageCursor;
    limit: number;
  }): Promise<ReportRow[]> {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (query.status) {
      where.push('r.status = ?');
      params.push(query.status);
    }
    if (query.publicationId) {
      where.push('r.publication_id = ?');
      params.push(query.publicationId);
    }
    if (query.before) {
      where.push('(r.created_at < ? OR (r.created_at = ? AND r.id < ?))');
      params.push(query.before.at, query.before.at, query.before.id);
    }
    const rows = await this.db.all(
      `SELECT ${REPORT_COLUMNS} FROM publication_reports r
       JOIN publications p ON p.id = r.publication_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY r.created_at DESC, r.id DESC LIMIT ?`,
      [...params, query.limit],
    );
    return rows.map(toReportRow);
  }

  async resolveReport(
    id: string,
    expected: number,
    resolution: string,
    now: string,
  ): Promise<boolean> {
    const changed = await this.db.run(
      `UPDATE publication_reports
       SET status = 'resolved', revision = revision + 1, resolved_at = ?, resolution = ?
       WHERE id = ? AND revision = ? AND status = 'open'`,
      [now, resolution, id, expected],
    );
    return changed > 0;
  }

  // --- audit ----------------------------------------------------------------

  async insertAudit(entry: AuditRow): Promise<void> {
    await this.db.run(
      `INSERT INTO moderation_audit
         (id, created_at, actor_user_id, action, target_type, target_id, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.at,
        entry.actorUserId,
        entry.action,
        entry.targetType,
        entry.targetId,
        entry.reason,
      ],
    );
  }

  async listAudit(query: {
    targetId?: string;
    before?: PageCursor;
    limit: number;
  }): Promise<AuditRow[]> {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (query.targetId) {
      where.push('target_id = ?');
      params.push(query.targetId);
    }
    if (query.before) {
      where.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(query.before.at, query.before.at, query.before.id);
    }
    const rows = await this.db.all(
      `SELECT id, created_at, actor_user_id, action, target_type, target_id, reason
       FROM moderation_audit
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      [...params, query.limit],
    );
    return rows.map((row) => ({
      id: String(row['id']),
      at: String(row['created_at']),
      actorUserId: String(row['actor_user_id']),
      action: String(row['action']),
      targetType: String(row['target_type']),
      targetId: String(row['target_id']),
      reason: String(row['reason']),
    }));
  }
}

function contentValues(content: PublicationContent): SqlValue[] {
  return [
    content.title,
    content.description,
    content.authorLabel,
    content.license,
    content.attribution,
    content.derivedFromJson,
    content.sourceRevision,
    content.snapshotJson,
  ];
}

function toPublicationRow(row: Record<string, unknown>): PublicationRow {
  return {
    id: String(row['id']),
    sourceShaderId: String(row['source_shader_id']),
    ownerUserId: String(row['owner_user_id']),
    title: String(row['title']),
    description: String(row['description']),
    authorLabel: String(row['author_label']),
    license: String(row['license']),
    attribution: String(row['attribution']),
    derivedFromJson: row['derived_from_json'] === null ? null : String(row['derived_from_json']),
    ownerVisible: Number(row['owner_visible']) === 1,
    moderatorHidden: Number(row['moderator_hidden']) === 1,
    revision: Number(row['revision']),
    moderationRevision: Number(row['moderation_revision']),
    sourceRevision: Number(row['source_revision']),
    publishedAt: String(row['published_at']),
    updatedAt: String(row['updated_at']),
    hasThumbnail: Number(row['thumbnails']) > 0,
    openReports: Number(row['open_reports']),
    publisherRestricted: Number(row['restrictions']) > 0,
  };
}

function toAsset(row: Record<string, unknown>): PublicationAsset {
  return {
    key: String(row['asset_key']) as AssetKey,
    extension: String(row['extension']),
    width: row['width'] === null ? null : Number(row['width']),
    height: row['height'] === null ? null : Number(row['height']),
    data: plainBytes(row['data'] as Uint8Array),
  };
}

/**
 * node-postgres hands `bytea` back as a Node `Buffer`; the contract (and SQLite)
 * is a plain `Uint8Array`. A view over the same memory, not a copy.
 */
function plainBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function toReportRow(row: Record<string, unknown>): ReportRow {
  return {
    id: String(row['id']),
    publicationId: String(row['publication_id']),
    publicationTitle: String(row['publication_title']),
    reporterUserId: String(row['reporter_user_id']),
    reason: String(row['reason']),
    body: String(row['body']),
    createdAt: String(row['created_at']),
    status: String(row['status']),
    revision: Number(row['revision']),
    resolvedAt: row['resolved_at'] === null ? null : String(row['resolved_at']),
    resolution: row['resolution'] === null ? null : String(row['resolution']),
  };
}
