import { publicationSchemaSql } from '../../publication/publication-store';
import type { Migration } from '../migration-runner';

/**
 * Versioned SQLite schema. Each entry is applied once, in order, inside the
 * migration transaction the repository opens. JSON is stored as TEXT and binary
 * assets as BLOB. Never edit an already-shipped migration — add a new one.
 */
export const SQLITE_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    up(exec) {
      exec(`
        CREATE TABLE shaders (
          id            TEXT PRIMARY KEY,
          name          TEXT NOT NULL,
          description   TEXT NOT NULL,
          author        TEXT,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL,
          revision      INTEGER NOT NULL,
          project_json  TEXT NOT NULL,
          controls_json TEXT NOT NULL,
          render_json   TEXT NOT NULL,
          channels_json TEXT NOT NULL
        );

        CREATE TABLE presets (
          shader_id   TEXT NOT NULL REFERENCES shaders(id) ON DELETE CASCADE,
          id          TEXT NOT NULL,
          name        TEXT NOT NULL,
          created_at  TEXT NOT NULL,
          values_json TEXT NOT NULL,
          render_json TEXT,
          PRIMARY KEY (shader_id, id)
        );

        CREATE TABLE assets (
          shader_id  TEXT NOT NULL REFERENCES shaders(id) ON DELETE CASCADE,
          asset_key  TEXT NOT NULL,
          extension  TEXT NOT NULL,
          width      INTEGER,
          height     INTEGER,
          updated_at TEXT NOT NULL,
          data       BLOB NOT NULL,
          PRIMARY KEY (shader_id, asset_key)
        );

        CREATE TABLE storage_metadata (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE INDEX idx_presets_shader ON presets(shader_id);
        CREATE INDEX idx_assets_shader ON assets(shader_id);
      `);
    },
  },
  {
    version: 2,
    name: 'shader-ownership',
    up(exec) {
      // SQLite accepts NOT NULL on an added column when it carries a default, so
      // pre-authentication rows are backfilled in place — no table rebuild, and
      // no window in which ownership is nullable. A missing owner is never
      // shorthand for "public": `kind` marks a shared example.
      //
      // A SQLite store belongs to one person by construction (the desktop app,
      // or a developer's machine), so its rows go to the local user and stay
      // visible across the upgrade. The shared Postgres deployment backfills to
      // the system owner instead, and a real account claims them afterwards.
      exec(`
        ALTER TABLE shaders ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT 'local';
        ALTER TABLE shaders ADD COLUMN kind TEXT NOT NULL DEFAULT 'shader';

        CREATE INDEX idx_shaders_owner_updated ON shaders(owner_user_id, updated_at DESC);
      `);
    },
  },
  {
    version: 3,
    name: 'auth-tables',
    up(exec) {
      // Mirrors `auth-schema.ts` exactly — Better Auth resolves columns through
      // those Drizzle definitions, so the two files change together.
      //
      // Dates are epoch milliseconds and booleans 0/1, matching the schema's
      // `timestamp_ms` and `boolean` modes. No foreign key is added to
      // `shaders.owner_user_id`: SQLite cannot add a constraint to an existing
      // table without a rebuild, and this store is single-user anyway. The
      // desktop app never opens these tables — only `pnpm dev:server` does.
      exec(`
        CREATE TABLE users (
          id             TEXT PRIMARY KEY,
          name           TEXT NOT NULL,
          email          TEXT NOT NULL UNIQUE,
          email_verified INTEGER NOT NULL DEFAULT 0,
          image          TEXT,
          created_at     INTEGER NOT NULL,
          updated_at     INTEGER NOT NULL
        );

        CREATE TABLE sessions (
          id         TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL,
          token      TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          ip_address TEXT,
          user_agent TEXT,
          user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE accounts (
          id                       TEXT PRIMARY KEY,
          account_id               TEXT NOT NULL,
          provider_id              TEXT NOT NULL,
          user_id                  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          access_token             TEXT,
          refresh_token            TEXT,
          id_token                 TEXT,
          access_token_expires_at  INTEGER,
          refresh_token_expires_at INTEGER,
          scope                    TEXT,
          password                 TEXT,
          created_at               INTEGER NOT NULL,
          updated_at               INTEGER NOT NULL
        );

        CREATE TABLE verifications (
          id         TEXT PRIMARY KEY,
          identifier TEXT NOT NULL,
          value      TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX idx_sessions_user ON sessions(user_id);
        CREATE INDEX idx_accounts_user ON accounts(user_id);
        CREATE INDEX idx_verifications_identifier ON verifications(identifier);
      `);
    },
  },
  {
    version: 4,
    name: 'publications',
    up(exec) {
      // Additive, and inert on the desktop: its store gets the empty tables and
      // nothing there ever writes to them.
      exec(publicationSchemaSql('BLOB'));
    },
  },
  {
    version: 5,
    name: 'shader-history',
    up(exec) {
      // Additive: shaders that predate it simply have no rows until their first
      // versioned edit captures a baseline. `revision` is the shader's own
      // counter, so gaps are normal. Content is frozen as the same JSON the
      // `shaders` columns hold; only `checkpoint_name` is ever updated.
      exec(`
        CREATE TABLE shader_history (
          shader_id              TEXT NOT NULL REFERENCES shaders(id) ON DELETE CASCADE,
          revision               INTEGER NOT NULL,
          created_at             TEXT NOT NULL,
          checkpoint_name        TEXT,
          cause                  TEXT NOT NULL,
          restored_from_revision INTEGER,
          project_json           TEXT NOT NULL,
          controls_json          TEXT NOT NULL,
          render_json            TEXT NOT NULL,
          presets_json           TEXT NOT NULL,
          PRIMARY KEY (shader_id, revision)
        );

        CREATE INDEX idx_shader_history_newest ON shader_history(shader_id, revision DESC);
      `);
    },
  },
];
