/**
 * Builds the shader storage the server runs on. PostgreSQL is selected whenever
 * `DATABASE_URL` is set (always the case under Docker Compose); without it, a
 * local SQLite file is used so `pnpm dev:server` and `ng serve` work with no
 * database to stand up. Either way the web app only ever sees the REST API —
 * the connection string never leaves this process.
 */

import { Logger } from '@nestjs/common';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  LOCAL_SCOPE,
  ShaderLibrary,
  SYSTEM_SCOPE,
  type UserScope,
} from '@shadergrove/backend/library';
import type { AuthDatabase, ShaderRepository } from '@shadergrove/backend/persistence';
import { PublicationLibrary, type PublicationRepository } from '@shadergrove/backend/publication';

const logger = new Logger('library');

/**
 * The library the process holds is bound to the bootstrap scope, which owns the
 * rows that predate authentication. A request-scoped copy comes from
 * `library.as(principal)` — never this one directly.
 */
export interface ServerStore {
  library: ShaderLibrary;
  /** The same connection, for Better Auth — one database, one migration ledger. */
  authDatabase: AuthDatabase;
  /** Public snapshots of that library. Only reachable when the server enables Explore. */
  publications: PublicationLibrary;
}

export async function createLibrary(): Promise<ServerStore> {
  const { repo, bootstrapScope } = await createRepository();
  const library = new ShaderLibrary(repo, bootstrapScope);
  await library.init();

  logger.log('storage ready');
  return {
    library,
    authDatabase: repo.authDatabase(),
    publications: new PublicationLibrary(repo, library),
  };
}

async function createRepository(): Promise<{
  repo: ShaderRepository & PublicationRepository;
  bootstrapScope: UserScope;
}> {
  const url = process.env['DATABASE_URL'];
  if (url) {
    // Imported lazily so `pg` stays out of the module graph unless it is used —
    // in particular, Angular's build-time route extraction (no DATABASE_URL)
    // must never try to resolve the external `pg` package.
    const { PostgresRepository } = await import('@shadergrove/backend/persistence/postgres');
    logger.log('using PostgreSQL (DATABASE_URL is set)');
    return {
      repo: new PostgresRepository({
        connectionString: url,
        maxPoolSize: Number(process.env['DATABASE_POOL_MAX'] ?? 10),
      }),
      bootstrapScope: SYSTEM_SCOPE,
    };
  }

  // Development fallback: no DATABASE_URL, so persist to a local SQLite file.
  // `node:sqlite` is imported lazily so it never loads on the Postgres path.
  // A SQLite store is single-user, and its ownership migration backfills to the
  // local user, so the bootstrap scope has to match or the rows go invisible.
  const { SqliteRepository } = await import('@shadergrove/backend/persistence/sqlite');
  const dir = process.env['SHADER_DATA_DIR'] ?? join(process.cwd(), 'data');
  await mkdir(dir, { recursive: true });
  logger.warn(`DATABASE_URL is not set — using a local SQLite database in ${dir}`);
  return {
    repo: new SqliteRepository({ location: join(dir, 'shader-studio.sqlite') }),
    bootstrapScope: LOCAL_SCOPE,
  };
}
