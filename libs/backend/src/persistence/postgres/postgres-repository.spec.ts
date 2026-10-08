import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import {
  CONFORMANCE_USER_IDS,
  runShaderLibraryConformance,
  type ConformanceHarness,
} from '../../library/conformance';
import { ShaderLibrary } from '../../library/shader-library';
import { runPublicationConformance } from '../../publication/conformance';
import type { AssetKey } from '../shader-repository';
import { LOCAL_SCOPE } from '../user-scope';
import { PostgresRepository } from './postgres-repository';

/**
 * Runs the shared conformance suite against a real PostgreSQL, when one is
 * configured. Point `SHADER_TEST_DATABASE_URL` (or `DATABASE_URL`) at an
 * *empty, disposable* database — the harness drops everything in its `public`
 * schema between tests. Without a URL the suite is skipped rather than failing, so
 * `pnpm test` stays green on a machine with no PostgreSQL.
 *
 *   docker run --rm -e POSTGRES_PASSWORD=test -p 5433:5432 postgres:16-alpine
 *   SHADER_TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/postgres pnpm --filter @shadergrove/backend test
 */
const url = process.env['SHADER_TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];

if (!url) {
  describe.skip('ShaderLibrary conformance (postgres)', () => {
    it('skipped — set SHADER_TEST_DATABASE_URL to run', () => undefined);
  });
} else {
  const sidePool = new Pool({ connectionString: url });
  afterAll(async () => {
    await sidePool.end();
  });

  // The whole schema, not a list of tables: the auth and publication tables
  // reference the shader ones, and a store left with some of them would fail
  // its next migration run on a table that already exists.
  const cleanup = async (): Promise<void> => {
    await sidePool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  };

  // The shared suite runs as the single-user `local` scope and several other
  // users. A server store only seeds `system` and owns rows by real accounts, so
  // every account the suite acts as has to exist before the library bootstraps,
  // or each owned write fails `fk_shaders_owner`.
  const localRepository = (): PostgresRepository => {
    const repo = new PostgresRepository({ connectionString: url });
    const migrate = repo.init.bind(repo);
    repo.init = async () => {
      await migrate();
      await sidePool.query(
        `INSERT INTO users (id, name, email, email_verified)
         SELECT id, id, id || '@shader-studio.invalid', true FROM unnest($1::text[]) AS id
         ON CONFLICT (id) DO NOTHING`,
        [CONFORMANCE_USER_IDS],
      );
    };
    return repo;
  };

  const newHarness = (): ConformanceHarness => ({
    makeRepository: () => localRepository(),
    cleanup,
    corruptProjectJson: async (id: string) => {
      // jsonb cannot hold invalid JSON, so store a degenerate-but-valid value;
      // the library must degrade to a default project rather than crash.
      await sidePool.query("UPDATE shaders SET project_json = 'null'::jsonb WHERE id = $1", [id]);
    },
    removeAssetRow: async (id: string, key: AssetKey) => {
      await sidePool.query('DELETE FROM assets WHERE shader_id = $1 AND asset_key = $2', [id, key]);
    },
    clearHistory: async (id: string) => {
      await sidePool.query('DELETE FROM shader_history WHERE shader_id = $1', [id]);
    },
    countHistory: async (id: string) => {
      const result = await sidePool.query(
        'SELECT COUNT(*)::int AS n FROM shader_history WHERE shader_id = $1',
        [id],
      );
      return Number(result.rows[0].n);
    },
    corruptHistory: async (id: string, revision: number) => {
      // jsonb cannot hold invalid JSON; a string is a valid value that is not a control list.
      await sidePool.query(
        `UPDATE shader_history SET controls_json = '"not controls"'::jsonb
         WHERE shader_id = $1 AND revision = $2`,
        [id, revision],
      );
    },
  });

  runShaderLibraryConformance('postgres', newHarness);

  // In this file rather than beside the SQLite run: test files run in parallel,
  // and two of them dropping the same database's schema would trip each other.
  runPublicationConformance('postgres', () => ({
    makeRepository: () => localRepository(),
    cleanup,
    addUser: async (id) => {
      await sidePool.query(
        'INSERT INTO users (id, name, email, email_verified) VALUES ($1, $1, $2, true)',
        [id, `${id}@example.test`],
      );
    },
    removeUser: async (id) => {
      await sidePool.query('DELETE FROM shaders WHERE owner_user_id = $1', [id]);
      await sidePool.query('DELETE FROM users WHERE id = $1', [id]);
    },
  }));

  describe('conditional delete vs a concurrent thumbnail write (postgres)', () => {
    it('conflicts instead of deleting over a thumbnail committed meanwhile', async () => {
      await newHarness().cleanup();
      const repo = localRepository();
      const lib = new ShaderLibrary(repo, LOCAL_SCOPE);
      await lib.init();
      try {
        const { id } = await lib.create({ name: 'Contended' });
        const bytes = new Uint8Array([1]);
        const old = (await lib.setThumbnail(id, { ext: 'png', bytes })).thumbnail!.updatedAt;
        const newer = '2999-01-01T00:00:00.000Z';
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        let wrote!: () => void;
        const written = new Promise<void>((resolve) => (wrote = resolve));
        // Transaction 1: the thumbnail write, held open.
        const write = repo.transaction(async (tx) => {
          const asset = { key: 'thumbnail' as const, extension: 'png', width: null, height: null };
          await tx.putAssetIf(id, { ...asset, updatedAt: newer, data: bytes }, old);
          wrote();
          await held;
        });
        await written;

        // Transaction 2: the delete, conditional on the old stamp, reaches the lock and waits.
        const removal = lib.remove(id, 1, old);
        const outcome = removal.then(
          () => 'deleted',
          (error: { code?: string }) => error.code,
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        release();
        await write;

        expect(await outcome).toBe('conflict');
        expect((await lib.read(id)).thumbnail?.updatedAt).toBe(newer);
      } finally {
        await lib.close();
      }
    });

    it('never deadlocks a preset delete against a conditional delete', async () => {
      await newHarness().cleanup();
      const lib = new ShaderLibrary(localRepository(), LOCAL_SCOPE);
      await lib.init();
      try {
        for (let round = 0; round < 20; round++) {
          const { id } = await lib.create({ name: `Race ${round}` });
          const preset = await lib.savePreset(id, { name: 'Only', values: {} });
          const { revision } = await lib.read(id);

          const results = await Promise.allSettled([
            lib.deletePreset(id, preset.id),
            lib.remove(id, revision),
          ]);

          for (const result of results) {
            if (result.status === 'rejected') {
              expect(['not_found', 'conflict']).toContain(
                (result.reason as { code?: string }).code,
              );
            }
          }
          // Exactly one of them won: the shader is gone, or the preset is.
          const fulfilled = results.filter((result) => result.status === 'fulfilled');
          expect(fulfilled).toHaveLength(1);
        }
      } finally {
        await lib.close();
      }
    });
  });
}
