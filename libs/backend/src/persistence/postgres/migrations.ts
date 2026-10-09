import { publicationSchemaSql } from '../../publication/publication-store';
import type { Migration } from '../migration-runner';

/**
 * Versioned PostgreSQL schema. Mirrors the SQLite schema but stores JSON as
 * `jsonb` and binary assets as `bytea`. The `storage_metadata` ledger is
 * bootstrapped by the repository before migrations run (it also holds the
 * `schema_version` these migrations advance), so it is intentionally absent
 * here. Never edit a shipped migration — add a new one.
 */
export const POSTGRES_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    async up(exec) {
      await exec(`
        CREATE TABLE shaders (
          id            text PRIMARY KEY,
          name          text NOT NULL,
          description   text NOT NULL,
          author        text,
          created_at    text NOT NULL,
          updated_at    text NOT NULL,
          revision      integer NOT NULL,
          project_json  jsonb NOT NULL,
          controls_json jsonb NOT NULL,
          render_json   jsonb NOT NULL,
          channels_json jsonb NOT NULL
        );

        CREATE TABLE presets (
          shader_id   text NOT NULL REFERENCES shaders(id) ON DELETE CASCADE,
          id          text NOT NULL,
          name        text NOT NULL,
          created_at  text NOT NULL,
          values_json jsonb NOT NULL,
          render_json jsonb,
          PRIMARY KEY (shader_id, id)
        );

        CREATE TABLE assets (
          shader_id  text NOT NULL REFERENCES shaders(id) ON DELETE CASCADE,
          asset_key  text NOT NULL,
          extension  text NOT NULL,
          width      integer,
          height     integer,
          updated_at text NOT NULL,
          data       bytea NOT NULL,
          PRIMARY KEY (shader_id, asset_key)
        );

        CREATE INDEX idx_presets_shader ON presets(shader_id);
        CREATE INDEX idx_assets_shader ON assets(shader_id);
      `);
    },
  },
  {
    version: 2,
    name: 'shader-ownership',
    async up(exec) {
      // Backfill through a column default, then drop the default: from here on an
      // INSERT must name an owner, so a code path that forgets one fails loudly
      // instead of quietly creating an unowned shader. The foreign key to
      // users(id) is added by the auth migration, once that table exists.
      await exec(`
        ALTER TABLE shaders ADD COLUMN owner_user_id text NOT NULL DEFAULT 'system';
        ALTER TABLE shaders ALTER COLUMN owner_user_id DROP DEFAULT;
        ALTER TABLE shaders ADD COLUMN kind text NOT NULL DEFAULT 'shader';

        CREATE INDEX idx_shaders_owner_updated ON shaders(owner_user_id, updated_at DESC);
      `);
    },
  },
  {
    version: 3,
    name: 'auth-tables',
    async up(exec) {
      // Mirrors `auth-schema.ts` exactly — Better Auth resolves columns through
      // those Drizzle definitions, so the two files change together or the
      // adapter fails at runtime rather than at build time.
      //
      // The system account is inserted before the foreign key so the rows
      // migration 2 backfilled have something real to point at. It is given an
      // unroutable email and no `accounts` row, which means no credential
      // exists for it and nobody can sign in as the owner of the examples.
      await exec(`
        CREATE TABLE users (
          id             text PRIMARY KEY,
          name           text NOT NULL,
          email          text NOT NULL UNIQUE,
          email_verified boolean NOT NULL DEFAULT false,
          image          text,
          created_at     timestamptz NOT NULL DEFAULT now(),
          updated_at     timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE sessions (
          id         text PRIMARY KEY,
          expires_at timestamptz NOT NULL,
          token      text NOT NULL UNIQUE,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          ip_address text,
          user_agent text,
          user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE accounts (
          id                       text PRIMARY KEY,
          account_id               text NOT NULL,
          provider_id              text NOT NULL,
          user_id                  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          access_token             text,
          refresh_token            text,
          id_token                 text,
          access_token_expires_at  timestamptz,
          refresh_token_expires_at timestamptz,
          scope                    text,
          password                 text,
          created_at               timestamptz NOT NULL DEFAULT now(),
          updated_at               timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE verifications (
          id         text PRIMARY KEY,
          identifier text NOT NULL,
          value      text NOT NULL,
          expires_at timestamptz NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );

        CREATE INDEX idx_sessions_user ON sessions(user_id);
        CREATE INDEX idx_accounts_user ON accounts(user_id);
        CREATE INDEX idx_verifications_identifier ON verifications(identifier);

        INSERT INTO users (id, name, email, email_verified)
        VALUES ('system', 'Shadergrove', 'system@shader-studio.invalid', true);

        ALTER TABLE shaders
          ADD CONSTRAINT fk_shaders_owner
          FOREIGN KEY (owner_user_id) REFERENCES users(id);
      `);
    },
  },
  {
    version: 4,
    name: 'publications',
    async up(exec) {
      await exec(publicationSchemaSql('bytea'));
    },
  },
  {
    version: 5,
    name: 'shader-history',
    async up(exec) {
      // Mirrors the SQLite table; see its migration for the row's meaning.
      await exec(`
        CREATE TABLE shader_history (
          shader_id              text NOT NULL REFERENCES shaders(id) ON DELETE CASCADE,
          revision               integer NOT NULL,
          created_at             text NOT NULL,
          checkpoint_name        text,
          cause                  text NOT NULL,
          restored_from_revision integer,
          project_json           jsonb NOT NULL,
          controls_json          jsonb NOT NULL,
          render_json            jsonb NOT NULL,
          presets_json           jsonb NOT NULL,
          PRIMARY KEY (shader_id, revision)
        );

        CREATE INDEX idx_shader_history_newest ON shader_history(shader_id, revision DESC);
      `);
    },
  },
];
