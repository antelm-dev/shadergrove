import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ShaderLibrary } from '../library/shader-library';
import { SqliteRepository } from '../persistence/sqlite/sqlite-repository';
import { runPublicationConformance, type PublicationHarness } from './conformance';

function sqliteHarness(): PublicationHarness & { exec(sql: string): void } {
  const dir = mkdtempSync(join(tmpdir(), 'ss-publication-'));
  const file = join(dir, 'store.sqlite');
  const side = (work: (db: DatabaseSync) => void): void => {
    const db = new DatabaseSync(file);
    try {
      // Per connection in SQLite, and what makes the deletes below cascade.
      db.exec('PRAGMA foreign_keys = ON');
      work(db);
    } finally {
      db.close();
    }
  };

  return {
    makeRepository: () => new SqliteRepository({ location: file }),
    exec: (sql) => side((db) => db.exec(sql)),
    cleanup: async () => {
      // Best-effort: a just-closed WAL handle can linger a beat on Windows.
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* temp dir; the OS reclaims it */
      }
    },
    addUser: async (id) =>
      side((db) => {
        db.prepare(
          `INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
           VALUES (?, ?, ?, 1, 0, 0)`,
        ).run(id, id, `${id}@example.test`);
      }),
    removeUser: async (id) =>
      side((db) => {
        db.prepare('DELETE FROM shaders WHERE owner_user_id = ?').run(id);
        db.prepare('DELETE FROM users WHERE id = ?').run(id);
      }),
  };
}

runPublicationConformance('sqlite', sqliteHarness);

describe('publication schema (sqlite)', () => {
  it('migrates a library that predates publications without touching it', async () => {
    const harness = sqliteHarness();
    const repo = harness.makeRepository();
    const library = new ShaderLibrary(repo, { userId: 'local' });
    await library.init();
    const { id } = await library.create({ name: 'Old Shader' });
    await library.close();

    // Put the store back the way a version-3 install left it, then upgrade it.
    harness.exec(`
      DROP TABLE shader_history;
      DROP TABLE moderation_audit; DROP TABLE publisher_restrictions; DROP TABLE publication_reports;
      DROP TABLE shader_origins; DROP TABLE publication_assets; DROP TABLE publications;
      PRAGMA user_version = 3;
    `);
    await library.init();
    expect((await library.read(id)).name).toBe('Old Shader');
    expect(await repo.publications.findBySource(id)).toBeNull();
    expect(await repo.publications.list({ limit: 10 })).toEqual([]);
    await library.close();
    await harness.cleanup();
  });
});
