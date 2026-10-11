import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ShaderLibrary } from '../../library/shader-library';
import { runShaderLibraryConformance, type ConformanceHarness } from '../../library/conformance';
import { targetVersion } from '../migration-runner';
import type { AssetKey } from '../shader-repository';
import { LOCAL_SCOPE } from '../user-scope';
import { SQLITE_MIGRATIONS } from './migrations';
import { SqliteRepository } from './sqlite-repository';

function newHarness(): ConformanceHarness {
  const dir = mkdtempSync(join(tmpdir(), 'ss-sqlite-'));
  const file = join(dir, 'store.sqlite');

  const side = <T>(work: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(file);
    try {
      return work(db);
    } finally {
      db.close();
    }
  };

  return {
    makeRepository: () => new SqliteRepository({ location: file }),
    cleanup: async () => {
      // Best-effort: a just-closed WAL handle can linger a beat on Windows.
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* temp dir; the OS reclaims it */
      }
    },
    corruptProjectJson: async (id: string) =>
      side((db) => {
        db.prepare('UPDATE shaders SET project_json = ? WHERE id = ?').run('{ not json', id);
      }),
    removeAssetRow: async (id: string, key: AssetKey) =>
      side((db) => {
        db.prepare('DELETE FROM assets WHERE shader_id = ? AND asset_key = ?').run(id, key);
      }),
    clearHistory: async (id: string) =>
      side((db) => {
        db.prepare('DELETE FROM shader_history WHERE shader_id = ?').run(id);
      }),
    countHistory: async (id: string) =>
      side((db) =>
        Number(
          (
            db.prepare('SELECT COUNT(*) AS n FROM shader_history WHERE shader_id = ?').get(id) as {
              n: number;
            }
          ).n,
        ),
      ),
    corruptHistory: async (id: string, revision: number) =>
      side((db) => {
        db.prepare(
          'UPDATE shader_history SET controls_json = ? WHERE shader_id = ? AND revision = ?',
        ).run('{ not json', id, revision);
      }),
  };
}

runShaderLibraryConformance('sqlite', newHarness);

describe('shader history migration (sqlite)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* temp dir; the OS reclaims it */
      }
    }
  });

  const version = (db: DatabaseSync): number =>
    Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  const hasTable = (db: DatabaseSync, name: string): boolean =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined;

  /** A store a build without history left behind: one shader, schema version 4. */
  async function legacyStore(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'ss-sqlite-history-'));
    dirs.push(dir);
    const file = join(dir, 'store.sqlite');
    const library = new ShaderLibrary(new SqliteRepository({ location: file }), LOCAL_SCOPE);
    await library.init();
    await library.create({ name: 'Old Shader' });
    await library.close();
    const db = new DatabaseSync(file);
    db.exec(
      'DROP TABLE shader_history; DROP INDEX idx_publications_published; PRAGMA user_version = 4',
    );
    db.close();
    return file;
  }

  it('adds the table to an existing library and captures a baseline on the first edit', async () => {
    const file = await legacyStore();
    const library = new ShaderLibrary(new SqliteRepository({ location: file }), LOCAL_SCOPE);
    await library.init();
    try {
      expect(await library.listHistory('old-shader')).toEqual([]);
      const before = await library.read('old-shader');

      await library.update('old-shader', { fragment: 'void main() { gl_FragColor = vec4(1.0); }' });
      const history = await library.listHistory('old-shader');
      expect(history.map((entry) => [entry.revision, entry.cause])).toEqual([
        [2, 'update'],
        [1, 'baseline'],
      ]);
      const restored = await library.restoreHistory('old-shader', 1, 2);
      expect(restored.fragment).toBe(before.fragment);
    } finally {
      await library.close();
    }

    const db = new DatabaseSync(file);
    try {
      expect(version(db)).toBe(targetVersion(SQLITE_MIGRATIONS));
    } finally {
      db.close();
    }
  });

  it('rolls the whole migration back when it fails part way', async () => {
    const file = await legacyStore();
    const side = new DatabaseSync(file);
    // The index name is taken, so the migration fails after it has created the table.
    side.exec('CREATE TABLE blocker (x); CREATE INDEX idx_shader_history_newest ON blocker(x)');
    side.close();

    const repo = new SqliteRepository({ location: file });
    const silence = console.error;
    console.error = () => undefined;
    try {
      await expect(repo.init()).rejects.toMatchObject({ code: 'io' });
    } finally {
      console.error = silence;
    }

    const db = new DatabaseSync(file);
    try {
      expect(version(db)).toBe(4);
      expect(hasTable(db, 'shader_history')).toBe(false);
      expect(db.prepare('SELECT COUNT(*) AS n FROM shaders').get()).toMatchObject({ n: 1 });
    } finally {
      db.close();
    }
  });
});
