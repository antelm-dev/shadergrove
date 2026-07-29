# 02 — Opt-in MinIO server path

Read the coordinator README before starting.

## Mission

Implement a server-only opt-in MinIO blob store for current texture/thumbnail
API endpoints, durable cleanup processing, and local Compose configuration,
without changing web or desktop clients.

## Launch and isolation

- Base policy: latest-default; coordinator replaces <exact-launch-base> with
  refreshed master commit after task 01 PR merges.
- Prerequisite: task 01 acceptance is verified on that exact base.

    git worktree add E:/Adel/Documents/Orgs/shader-studio-minio-hybrid-storage-02-server-path -b codex/minio-hybrid-storage-02-server-path <exact-launch-base>
    cd E:/Adel/Documents/Orgs/shader-studio-minio-hybrid-storage-02-server-path
    git status --short --branch

Require clean status before edits.

## Context and owned scope

Use task 01 contract. Server composition is apps/server/src/create-library.ts;
the API already proxies bytes in apps/server/src/api/api.controller.ts; local
deployment is docker-compose.yml; safe environment documentation is .env.example.

Own MinIO/S3 adapter, server composition/config, cleanup worker bootstrap,
Compose/environment documentation, and focused unit/integration tests. Keep it
cohesive and do not touch web or desktop source.

## Required work

1. Add S3-compatible client dependency only to server-reachable backend code.
   Build private-bucket adapter that verifies SHA-256/byte size before DB
   reference publication.
2. ASSET_STORAGE=database remains default. For minio, validate endpoint,
   bucket, access key, secret key, optional region/TLS settings at startup.
   Never expose secrets in clients/logs/responses. Incomplete config or bucket
   preparation fails startup.
3. Use README immutable keys. Upload before DB commit; commit failure may leave
   recoverable orphan. Replace/clear/delete enqueues cleanup; bounded retries
   verify no live reference before delete. Successful API mutations do not wait
   for object deletion.
4. Preserve all four texture/thumbnail REST routes and response types. Database
   mode and legacy assets.data fallback remain working. Desktop unaffected.
5. Add MinIO Compose service, persistent volume, health check, private
   bucket/bootstrap, and documented non-secret variables. Do not publish host
   port unless local administration deliberately requires it.
6. Add test-double unit coverage and reproducible real-MinIO integration where
   conventions permit: restart read, replacement, deletion retry, config failure.

## Out of scope

Browser presigned URLs/CORS/CDN, production backfill, legacy blob removal,
global deduplication, export-format changes, unrelated deployment hardening.

## Contracts and verification

Meet AC-02 through AC-05. Feature remains default-off and rollbackable via
ASSET_STORAGE=database.

    pnpm --filter @shader-studio/backend test
    pnpm typecheck
    pnpm check:ipc
    pnpm format:check

Run documented Compose smoke scenario if Docker is available. Review full diff,
make 1–3 logical commits, report exact base, commits, checks, MinIO evidence,
configuration variables, and operational risks.

