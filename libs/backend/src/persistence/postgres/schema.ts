import { index, integer, jsonb, pgTable, primaryKey, text, customType } from 'drizzle-orm/pg-core';

import type { ShaderHistoryCause } from '@shadergrove/shared/model';

import type { ShaderKind } from '../user-scope';

const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => 'bytea',
  fromDriver: (value) => new Uint8Array(value),
  toDriver: (value) => Buffer.from(value),
});

/**
 * The PostgreSQL schema used by the server.
 *
 * Keep column names explicit: the existing installation predates Drizzle and
 * its migrations already created these tables. The schema is therefore both a
 * typed query model and the source of truth for future server-side relations.
 */
export const shaders = pgTable(
  'shaders',
  {
    id: text('id').primaryKey(),
    ownerUserId: text('owner_user_id').notNull(),
    kind: text('kind').$type<ShaderKind>().notNull().default('shader'),
    name: text('name').notNull(),
    description: text('description').notNull(),
    author: text('author'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    revision: integer('revision').notNull(),
    projectJson: jsonb('project_json').notNull(),
    controlsJson: jsonb('controls_json').notNull(),
    renderJson: jsonb('render_json').notNull(),
    channelsJson: jsonb('channels_json').notNull(),
  },
  (table) => [index('idx_shaders_owner_updated').on(table.ownerUserId, table.updatedAt.desc())],
);

export const presets = pgTable(
  'presets',
  {
    shaderId: text('shader_id')
      .notNull()
      .references(() => shaders.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    name: text('name').notNull(),
    createdAt: text('created_at').notNull(),
    valuesJson: jsonb('values_json').notNull(),
    renderJson: jsonb('render_json'),
  },
  (table) => [
    primaryKey({ columns: [table.shaderId, table.id] }),
    index('idx_presets_shader').on(table.shaderId),
  ],
);

export const assets = pgTable(
  'assets',
  {
    shaderId: text('shader_id')
      .notNull()
      .references(() => shaders.id, { onDelete: 'cascade' }),
    assetKey: text('asset_key').notNull(),
    extension: text('extension').notNull(),
    width: integer('width'),
    height: integer('height'),
    updatedAt: text('updated_at').notNull(),
    data: bytea('data').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.shaderId, table.assetKey] }),
    index('idx_assets_shader').on(table.shaderId),
  ],
);

export const shaderHistory = pgTable(
  'shader_history',
  {
    shaderId: text('shader_id')
      .notNull()
      .references(() => shaders.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    createdAt: text('created_at').notNull(),
    checkpointName: text('checkpoint_name'),
    cause: text('cause').$type<ShaderHistoryCause>().notNull(),
    restoredFromRevision: integer('restored_from_revision'),
    projectJson: jsonb('project_json').notNull(),
    controlsJson: jsonb('controls_json').notNull(),
    renderJson: jsonb('render_json').notNull(),
    presetsJson: jsonb('presets_json').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.shaderId, table.revision] }),
    index('idx_shader_history_newest').on(table.shaderId, table.revision.desc()),
  ],
);

export const storageMetadata = pgTable('storage_metadata', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const postgresSchema = {
  assets,
  presets,
  shaderHistory,
  shaders,
  storageMetadata,
};
