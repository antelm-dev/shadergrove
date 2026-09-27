# 03 — GCP readiness and first deployment gate

Read the coordinator README before starting.

## Mission and launch

Make hybrid storage a verified prerequisite for the first GCP deployment.
Planning only: no resources have been provisioned or cloud checks passed.
Base: latest-default, resolved to an exact master commit after task 02 merges
and its acceptance is verified. Use a clean isolated checkout on
codex/minio-hybrid-storage-03-gcp-readiness.

Own server deployment configuration, production dependency packaging, bounded
cleanup job entrypoint, GCS compatibility fixes in the existing adapter,
deployment documentation and targeted integration checks. Preserve REST/IPC
and desktop SQLite. No automatic backfill, public bucket, CDN or browser
presigned transfers.

## Architecture and compatibility gate

| Component | Proposed GCP service | Requirement |
|---|---|---|
| Angular SSR / Nest API | Cloud Run | Stateless production image |
| Metadata, legacy blobs, outbox | Cloud SQL PostgreSQL | Authoritative durable data |
| New textures / thumbnails | Cloud Storage | Private immutable objects |
| Image | Artifact Registry | Immutable image digest |
| Secrets | Secret Manager | Runtime identity, versioned secrets |
| Cleanup | Cloud Run Job + Cloud Scheduler | Authenticated bounded execution |

Use the S3-compatible adapter against https://storage.googleapis.com with
service-account HMAC credentials. ASSET_STORAGE=minio remains the existing
adapter selector; document the name instead of inventing an unimplemented gcs
mode. Validate actual SDK signing, region, addressing style, object metadata,
errors and checksums. GCS interoperability is partial: MinIO tests alone cannot
prove it works. An ETag is not a SHA-256 checksum. Buckets are provisioned
separately; runtime verifies access without bucket administration privileges.

If the real adapter fails the GCS gate, fix the supported subset or plan a native
GCS adapter before launch. Production MinIO requires an explicitly selected
Compute Engine alternative with persistent disk, private networking, upgrades
and recovery ownership. Do not put its durable data on Cloud Run local storage
or a FUSE bucket mount.

## Deployment prerequisites

- Record project ID, billing, region, domain, resource names, owners and budget.
  Enable Run, Artifact Registry, Cloud SQL Admin, Storage, Secret Manager,
  Scheduler and the chosen build service APIs. Colocate services/data where
  possible. Estimate SQL, compute, storage and transfer using current pricing.
  Budget alerts do not cap spending.
- Separate deployer, runtime, cleanup and scheduler identities. Grant specific
  secret access, Cloud SQL connectivity and bucket-scoped object permissions.
  HMAC identities require only the selected bucket permissions. Keep bucket
  provisioning credentials outside the app. Record key rotation/revocation.
- Create a private bucket with uniform bucket-level access and public access
  prevention. API-proxied bytes need no browser CORS. Preserve checksum, size,
  metadata and provider/bucket location. No lifecycle rule may delete live
  objects. Document versioning/retention effects on deletion and recovery.
- Provision Cloud SQL, database/user and backup/recovery policy. Document a
  working connector/socket or private-network connection compatible with the
  actual pg configuration. Explicit DATABASE_URL must prevent accidental local
  SQLite fallback. Bound DATABASE_POOL_MAX and maximum Cloud Run instances,
  accounting for overlapping revisions, auth, cleanup and migration connections.
- Store DATABASE_URL, BETTER_AUTH_SECRET, MAIL_SMTP_URL and storage credentials
  in Secret Manager. Set production BETTER_AUTH_URL, NG_ALLOWED_HOSTS,
  MAIL_FROM, SHADER_SEED=0 and only necessary AUTH_TRUSTED_ORIGINS. Determine
  proxy trust from the actual ingress chain. Verify domain/TLS, SMTP,
  verification/reset links, secure cookies and forwarded client IP behavior.
- Build the final image with all external runtime dependencies, including pg,
  Swagger and any external storage SDK. Pin digest and configure PORT/listen
  binding. Configure Cloud Run probes explicitly; Docker HEALTHCHECK alone is
  insufficient. Check public /api/health separately from private storage access.
- Apply additive migrations with the existing ledger and locking. Prove safe
  overlapping startup or use a serialized release job. The existing migrate-files
  CLI imports legacy files; do not present it as a schema migration command.
- Run bounded cleanup as a Cloud Run Job with authenticated Scheduler invocation.
  Do not rely on background timers in idle HTTP instances. Verify leases,
  retry/backoff, crash recovery and overlapping jobs. Alert on failed uploads,
  missing objects, DB failures, job failures and backlog age; redact secrets.
  Define orphan reconciliation with a grace window and fresh live-reference
  checks that cannot race with reference resurrection.
- Complete a basic restore drill: recover consistent SQL plus matching object
  data/versions into an isolated environment, then render/export an asset.
  Record recovery objectives, retention and operator procedure.

These are implementation and operational requirements, not confirmed features.
Record exact environment variable names and executable commands after implementation.

## Verification and release evidence

Run pnpm run ci on the final implementation; report skipped stages honestly.
Test the exact production image against PostgreSQL/MinIO locally, then an
isolated real private GCS bucket with the deployment identities.

1. Create texture and thumbnail; read/render/export through current API routes.
   Restart or replace the Cloud Run revision; confirm identical bytes/checksums.
2. Preserve legacy blobs and mixed-storage reads. Switch future writes to database
   and roll back to a dual-read-capable image; external assets remain readable.
   Keep adapters, credentials and buckets for references already published.
3. Replace/clear/delete while physical deletion is unavailable. API mutations
   succeed, durable outbox retries converge without deleting live assets. Test
   concurrent workers and a job stopped mid-batch.
4. Reject cross-user asset access. Direct anonymous object reads fail. Browser
   traffic and logs expose no storage credentials.
5. Bad credentials, wrong bucket and upload outage fail explicitly, with no silent
   database write fallback or missing-object reference. A read outage must not
   trigger fallback to stale legacy bytes.
6. Verify concurrent startup/migrations, DB connection limits, health probes,
   SSR, auth, SMTP verification/reset and upload limits through deployed ingress.
7. Complete the restore drill and record SQL/object consistency evidence.

Deliver reproducible deploy/update/job/rollback instructions, resource/IAM
inventory, redacted config, exact commit/image digest, migration result, check
outputs and remaining manual scope. AC-06/AC-07 require actual cloud evidence.
Documentation or unit tests alone cannot close this deployment gate.
Provisioning/public release are separate actions from this plan update.

A public community launch also retains independent requirements for Explore,
public shader publication and customizable/shareable post-process effects;
this storage milestone does not satisfy those product gates.

## Official sources checked (2026-09-27)

- [Cloud Run container contract](https://docs.cloud.google.com/run/docs/container-contract)
- [Cloud SQL from Cloud Run](https://docs.cloud.google.com/sql/docs/postgres/connect-run)
- [Database connection management](https://docs.cloud.google.com/sql/docs/postgres/manage-connections)
- [Cloud Storage interoperability](https://docs.cloud.google.com/storage/docs/interoperability)
- [Cloud Storage HMAC keys](https://docs.cloud.google.com/storage/docs/authentication/hmackeys)

Recheck service options and pricing at implementation/deployment time.
