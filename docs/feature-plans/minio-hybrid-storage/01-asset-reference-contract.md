# 01 — Asset references and lifecycle contract

Read the coordinator README before starting.

## Mission

Make asset persistence represent immutable external blobs and durable cleanup
work, while retaining database blobs and public ShaderLibrary behavior by
default.

## Launch and isolation

- Base policy: latest-default; coordinator replaces <exact-launch-base> with
  current master commit at launch.
- Prerequisites: none.

    git worktree add E:/Adel/Documents/Orgs/shader-studio-minio-hybrid-storage-01-asset-contract -b codex/minio-hybrid-storage-01-asset-contract <exact-launch-base>
    cd E:/Adel/Documents/Orgs/shader-studio-minio-hybrid-storage-01-asset-contract
    git status --short --branch

Require clean status before edits.

## Context and owned scope

Current combined database/blob contract is
libs/backend/src/persistence/shader-repository.ts. Postgres and SQLite implement
it in their persistence folders; ShaderLibrary uses it in
libs/backend/src/library/shader-library.ts. Desktop must keep SQLite blobs.

Own the repository contract, Postgres schema/migrations/repository,
database-backed blob adapter/lifecycle types, and focused backend tests
(normally five primary source areas maximum). Make only minimal ShaderLibrary
adaptation. Do not add MinIO wiring, Compose/client changes, or a backfill tool.

## Required work

1. Define a blob/reference contract that distinguishes legacy database bytes
   from external immutable references without provider details leaking to web or
   desktop callers.
2. Add new additive Postgres migration(s), never edit migration 1, for object
   metadata and retryable cleanup/outbox records. Preserve assets.data and dual
   reads.
3. Model object key, byte size, SHA-256, type/extension, timestamps, and
   deterministic cleanup identity/retry state. A cleanup path must establish no
   live reference remains before physical deletion.
4. Preserve database default behavior and shared SQLite/Postgres conformance.
   Existing databases must upgrade safely and idempotently.
5. Add focused tests for migration, dual-read, reference replacement, and
   cleanup-queue behavior including failure-safe replacement at contract scope.

## Out of scope

MinIO/S3 dependencies/configuration, Docker Compose, API endpoint changes,
browser transfers, worker execution, legacy backfill, removal of assets.data,
and non-asset refactors.

## Contracts and verification

Meet AC-01, AC-03, AC-04. The next worker needs a stable contract and must not
alter ShaderLibrary API or Electron IPC generation.

    pnpm --filter @shader-studio/backend test
    pnpm typecheck

Review full diff. Make 1–3 logical commits. Report exact base, commits, checks,
migration evidence, and constraints the MinIO worker must honor. Delivery is a
backward-compatible default-branch PR; it stays deployable with
ASSET_STORAGE=database.

