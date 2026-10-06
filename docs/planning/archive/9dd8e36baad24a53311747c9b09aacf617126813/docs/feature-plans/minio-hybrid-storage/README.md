# MinIO hybrid asset storage — phase 1

## Goal and milestone

Move new server-side texture and thumbnail bytes from PostgreSQL to a private,
S3-compatible MinIO bucket while PostgreSQL remains authoritative for shader
records, presets, asset metadata, and lifecycle jobs. Keep REST and Electron IPC
contracts unchanged: the server proxies asset reads and writes, while desktop
continues using SQLite blobs.

This is the smallest usable milestone. A Compose deployment can opt into MinIO
without exposing credentials or bucket URLs to the browser. Database-backed
storage remains the default and existing assets.data rows stay readable.
Backfill and removal of that column are deferred.

Non-goals: browser presigned URLs, public buckets/CDNs, cross-shader blob
deduplication, object-store use in desktop, changed export bundles, and
automatic production backfill.

## Planning and source context

- Planning ref: codex/plan-minio-hybrid-storage
- Source base: 453adb47f456d7f26c2955dc22f0225b32badc44
- Default branch: master (origin/master)
- Remote: origin (https://github.com/antelm-dev/shader-studio.git)
- Future integration branch: codex/integrate-minio-hybrid-storage

The coordinator supplies each worker this README and their numbered prompt, or
an explicit readable planning ref and path. Before launch, resolve
latest-default to an exact commit; never treat a moving branch name as a base.

## Shared design contract

1. ShaderLibrary remains the domain and validation boundary. It presently calls
   putAsset, loadAsset, and deleteAsset via
   libs/backend/src/persistence/shader-repository.ts.
2. Introduce a server-selectable blob-store abstraction for bytes. Postgres
   stores complete immutable asset references: object key, byte size, SHA-256,
   type/extension, timestamps and a stable storage location identifier (provider/bucket). Legacy data fallback is required. Reads resolve the recorded location independently of current write mode.
3. New MinIO objects use immutable shader-scoped keys:
   private/shaders/<shader-id>/<asset-key>/<sha256>.<ext>. The bucket is private
   and API routes remain the sole browser-facing transfer boundary.
4. Upload an object before committing its DB reference. Commit failure can leave
   only a recoverable orphan; never publish a missing-object reference.
5. Replacements/removals enqueue durable PostgreSQL cleanup work. No request
   performs immediate destructive object deletion. Cleanup is retry-safe and
   verifies that a key has no live reference before deleting.
6. ASSET_STORAGE=database is safe default. ASSET_STORAGE=minio requires all
   server-only variables. Incomplete selected configuration fails startup; a
   MinIO write failure must not silently fall back to database storage.

## Acceptance criteria

- **AC-01:** Existing Postgres/SQLite assets retain current behavior; desktop is SQLite-only.
- **AC-02:** Opt-in server MinIO writes and reads textures/thumbnails through current API paths.
- **AC-03:** References are immutable with checksum/size, and never point to failed uploads.
- **AC-04:** Replace/clear/delete records retryable cleanup without depending on delete success.
- **AC-05:** Compose, configuration, and tests reproduce MinIO locally; secrets never reach clients.

- **AC-06:** The exact production image passes real private-GCS asset round trips, restart/revision, rollback and scheduled cleanup checks.
- **AC-07:** GCP configuration, IAM, migrations, recovery and release evidence are reproducible before public traffic.

## Work plan

| Wave | Task | Dependency | Delivery | Launch base |
|---|---|---|---|---|
| 1 | [01 — Asset references and lifecycle contract](01-asset-reference-contract.md) | none | default-branch-pr | latest-default |
| 2 | [02 — Opt-in MinIO server path](02-minio-server-path.md) | Task 01 PR merged into master | default-branch-pr | latest-default |
| 3 | [03 — GCP readiness](03-gcp-first-deployment.md) | Task 02 PR merged into master | default-branch-pr | latest-default |

Task 01 is deployable alone: it keeps database bytes active and has additive
schema/contract changes. Task 02 is default-off. ASSET_STORAGE=database changes new writes only; existing external references require their adapter, bucket and credentials. Code rollback must retain dual-read support.

## First GCP deployment prerequisite

Proposed target: Cloud Run for SSR/API, Cloud SQL PostgreSQL for metadata and
legacy blobs, and private Cloud Storage through its S3-interoperable XML API.
MinIO remains the local integration target. Actual GCS compatibility must be
verified; this plan is not a completed implementation or deployment.

Task 03 is mandatory before the first GCP deployment with external assets.
See [GCP readiness and deployment gate](03-gcp-first-deployment.md).
A database-only cloud smoke does not satisfy the hybrid storage milestone.
Do not run persistent PostgreSQL or MinIO inside Cloud Run.

## Verification and integration gate

Workers run their focused checks, inspect complete diffs, and report commits,
command output, migration behavior, and risks. After task 01 merges, refresh
master before task 02 launch. Coordinator checks:

    pnpm --filter @shader-studio/backend test
    pnpm typecheck
    pnpm check:ipc
    pnpm format:check

Critical E2E scenarios:

1. No MinIO configuration: create, replace, read, export, and delete a texture
   and thumbnail using PostgreSQL; legacy blobs still read.
2. MinIO mode: create/replace a texture, restart server, read/render/export it
   through the unchanged API URL.
3. MinIO deletion unavailable: clear texture/delete shader succeeds in API,
   cleanup persists, retry completes without deleting a newly referenced blob.
4. Incomplete MinIO configuration fails startup before serving mixed storage.

Only after explicit authorization — Review completed tasks and open or merge
eligible PRs — may a reviewer perform remote PR actions. Coordinator owns
conflicts and retains worker worktrees until review completes.

## Worker conventions

Use clean sibling worktrees. Each worker makes 1–3 logical commits, runs the
targeted checks, reviews their full diff, and returns commit IDs and risks.

- codex/minio-hybrid-storage-01-asset-contract
- codex/minio-hybrid-storage-02-server-path
- codex/minio-hybrid-storage-03-gcp-readiness

## Deferred backlog

- Idempotent production backfill from assets.data and later blob-column removal.
- Presigned browser transfers, MinIO CORS, and CDN delivery.
- Cross-shader content-addressed deduplication/reference counting.
- Multi-region replication, customer-managed KMS and retention automation. Basic backup/restore validation is required by task 03.

    review_contract:
      milestone: minio-hybrid-storage-phase-1
      planning_ref: codex/plan-minio-hybrid-storage
      source_base: 453adb47f456d7f26c2955dc22f0225b32badc44
      default_branch: master
      integration_branch: codex/integrate-minio-hybrid-storage
      tasks:
        - id: "01"
          branch: codex/minio-hybrid-storage-01-asset-contract
          depends_on: []
          acceptance: [AC-01, AC-03, AC-04]
          checks: ["pnpm --filter @shader-studio/backend test", "pnpm typecheck"]
          delivery: default-branch-pr
          base_policy: latest-default
          feature_flag: ASSET_STORAGE=database
        - id: "02"
          branch: codex/minio-hybrid-storage-02-server-path
          depends_on: ["01 merged into master"]
          acceptance: [AC-02, AC-03, AC-04, AC-05]
          checks: ["pnpm --filter @shader-studio/backend test", "pnpm typecheck", "pnpm format:check"]
          delivery: default-branch-pr
          base_policy: latest-default
          feature_flag: ASSET_STORAGE=minio
        - id: "03"
          branch: codex/minio-hybrid-storage-03-gcp-readiness
          depends_on: ["02 merged into master"]
          acceptance: [AC-06, AC-07]
          checks: ["pnpm run ci", "production image smoke", "real GCS deployment gate"]
          delivery: default-branch-pr
          base_policy: latest-default
          feature_flag: ASSET_STORAGE=minio
      integration_checks: ["pnpm --filter @shader-studio/backend test", "pnpm typecheck", "pnpm check:ipc", "pnpm format:check"]
      e2e_scenarios:
        - database mode retains legacy blob reads
        - minio replacement persists across restart through current API routes
        - cleanup retries after object-store deletion failure
        - incomplete MinIO configuration fails startup
      deferred:
        - production blob backfill and blob-column removal
        - presigned browser transfers and CDN
