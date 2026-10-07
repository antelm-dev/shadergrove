export type {
  AssetKey,
  AssetMeta,
  HistoryEntryRow,
  HistoryRow,
  PresetRow,
  ShaderMutableFields,
  ShaderRepository,
  ShaderRow,
  ShaderSummaryRow,
  ShaderTx,
  StoredAsset,
  StoredShader,
} from './shader-repository';
export { textureAssetKey, TEXTURE_ASSET_KEYS, THUMBNAIL_ASSET_KEY } from './shader-repository';
export { runMigrations, targetVersion } from './migration-runner';
export type { Migration, MigrationContext } from './migration-runner';
export type { ShaderKind, UserScope } from './user-scope';
export { LOCAL_SCOPE, LOCAL_USER_ID, SYSTEM_OWNER_ID, SYSTEM_SCOPE } from './user-scope';
export type { AuthDatabase } from './shader-repository';
