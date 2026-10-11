import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ShaderLibrary } from '../library/shader-library';
import { runMigrations, targetVersion } from '../persistence/migration-runner';
import { SQLITE_MIGRATIONS } from '../persistence/sqlite/migrations';
import { SqliteRepository } from '../persistence/sqlite/sqlite-repository';
import { runPublicationConformance, type PublicationHarness } from './conformance';
import { PublicationLibrary } from './publication-library';

function sqliteHarness(): PublicationHarness & { file: string; exec(sql: string): void } {
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
    file,
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
    stamp: async (id, publishedAt, updatedAt) =>
      side((db) => {
        db.prepare('UPDATE publications SET published_at = ?, updated_at = ? WHERE id = ?').run(
          publishedAt,
          updatedAt,
          id,
        );
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

  // --- AC-P2-MIGRATION --------------------------------------------------------

  const read = <T>(file: string, work: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(file);
    try {
      return work(db);
    } finally {
      db.close();
    }
  };
  const version = (db: DatabaseSync) =>
    Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  const hasPublishedIndex = (db: DatabaseSync) =>
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get('idx_publications_published') !== undefined;
  const rows = (db: DatabaseSync) =>
    db.prepare('SELECT * FROM publications ORDER BY id').all() as Record<string, unknown>[];

  /** A store with two publications, one of them updated after it was first published. */
  async function populated(): Promise<ReturnType<typeof sqliteHarness>> {
    const harness = sqliteHarness();
    const repo = harness.makeRepository();
    const library = new ShaderLibrary(repo, { userId: 'alice' });
    await library.init();
    await harness.addUser('alice');
    const pubs = new PublicationLibrary(repo, library);
    const terms = { authorLabel: 'A', license: 'MIT', rightsConfirmed: true };
    for (const name of ['First', 'Second']) {
      const shader = await library.create({ name });
      await pubs.publish('alice', shader.id, { ...terms, expectedRevision: shader.revision });
    }
    const { revision } = await library.update('first', { name: 'First, updated' });
    await pubs.publish('alice', 'first', { ...terms, expectedRevision: revision });
    await library.close();
    return harness;
  }

  it('creates the first-publication index on a fresh store', async () => {
    const harness = await populated();
    const file = harness.file;
    read(file, (db) => {
      expect(version(db)).toBe(targetVersion(SQLITE_MIGRATIONS));
      expect(hasPublishedIndex(db)).toBe(true);
    });
    await harness.cleanup();
  });

  it('upgrades a version-5 store by adding the index and changing no row', async () => {
    const harness = await populated();
    const file = harness.file;
    read(file, (db) => db.exec('DROP INDEX idx_publications_published; PRAGMA user_version = 5'));
    const before = read(file, rows);
    expect(before).toHaveLength(2);

    const library = new ShaderLibrary(harness.makeRepository(), { userId: 'alice' });
    await library.init();
    await library.close();
    read(file, (db) => {
      expect(version(db)).toBe(6);
      expect(hasPublishedIndex(db)).toBe(true);
      expect(rows(db)).toEqual(before);
    });
    await harness.cleanup();
  });

  it('refuses an older build against the upgraded ledger, while a build keeping it starts', async () => {
    const harness = await populated();
    const file = harness.file;
    // A build from before this migration knows versions 1–5 only.
    const older = SQLITE_MIGRATIONS.filter((migration) => migration.version <= 5);
    const stored = read(file, version);
    const noop = () => undefined;
    await expect(
      runMigrations(older, { getVersion: () => stored, setVersion: noop, exec: noop }),
    ).rejects.toThrow(/newer than this build supports/);

    // The rollback candidate keeps migration 6 (and so the index) and opens the store as-is.
    const repo = harness.makeRepository();
    const library = new ShaderLibrary(repo, { userId: 'alice' });
    await library.init();
    const listed = await repo.publications.list({ state: 'visible', limit: 10 });
    expect(listed.map((row) => row.title).sort()).toEqual(['First, updated', 'Second']);
    await library.close();
    read(file, (db) => expect(version(db)).toBe(6));
    await harness.cleanup();
  });
});
