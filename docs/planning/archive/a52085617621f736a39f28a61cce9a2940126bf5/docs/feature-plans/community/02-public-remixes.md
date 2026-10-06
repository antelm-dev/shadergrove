# Worker 02 — discoverable public direct remixes

Read the supplied coordinator README and accepted worker-01 contract. Implement
only Phase-1 remix discovery, preserving the existing publication/copy guarantees.

## Launch and isolation

Delivery: `integration-only`; base policy: `integration-tip`.
Prerequisite: worker 01 accepted, committed and reachable from integration (not just
a PR opened). Coordinator supplies `EXACT_LAUNCH_BASE=<resolved integration SHA>`
and plan documents. Verify creator capability and API at that SHA.

```text
git worktree add E:/Adel/Documents/Orgs/shader-studio-community-02 -b codex/community-02-remixes <EXACT_LAUNCH_BASE>
cd E:/Adel/Documents/Orgs/shader-studio-community-02
git status --short --branch
```

Require clean initial status and preserve unrelated files/local instructions.

## Mission and primary ownership

Make published copies discoverable as direct remixes on the source publication,
with durable attribution and optional captured source revision.
Primary files: `libs/backend/src/publication/publication-store.ts`,
`publication-library.ts`, `libs/shared/src/publication.ts`,
`libs/api/src/publications/publications.controller.ts`, and
`apps/web/src/app/publications/publication-page.ts`.
Supporting edits only: subsequent additive SQLite/PostgreSQL migration, pre-serving
server initialization and conditional route registration, API client, FR/EN i18n
and targeted tests/conformance. The profile implementation belongs to 01;
consume it, do not redesign it. Shared files are safe to edit only after the wave gate.

## Required work and contract

Implement README contracts 6–8 under the accepted PUBLIC_COMMUNITY_ENABLED gate.
Reuse existing copy-to-library and explicit publish flow. UI action “Create a remix”
creates a private copy; no publish-on-copy. A published derived copy is a remix even
without proven content changes. Preserve existing license/share-alike rules.

Add a nullable indexed immediate-origin publication ID to the publication table;
no source cascade FK. The migration runner supports statements only: backfill valid
legacy JSON via the store executor in bounded idempotent initialization batches before
community reads become available. Conditional writes must check the observed origin
JSON to preserve concurrent updates; test restarts and repeated initialization on
both engines. Do not fabricate relationships for malformed origins. Record
the column from server-trusted shader origin transactionally on publish/update.
Keep attribution JSON as durable historical evidence, including hidden/deleted source.
Add optional `revision` to newly recorded origins from the copied snapshot; legacy
and imported origins remain readable with no guessed version. Do not widen import
trust or accept a client-selected relationship. Cover export/import compatibility.

`GET /api/publications/:id/remixes` returns existing `PublicationPage`, newest first
with deterministic validated keyset cursors, direct currently public children only.
Parent unavailable means 404. No private shader identifiers/counts or hidden children.
Use creator projections from 01 and current visibility/restrictions. Public reads
use no-store. A source update preserves descendant content and copied revision.

Add remix list/cards and paging states below publication details, a verified-account
copy action and clear source/version credits. A hidden/deleted source link becomes
unavailable without exposing live hidden metadata; retain historical credit text.
Do not implement a recursive tree, counters, ranking or notification events.

## Verification and delivery

Acceptance: AC-REMIX, AC-ORIGIN, AC-NAV; E2E-2, E2E-3, relevant E2E-5–6.
Run the four task-02 commands in README YAML. Extend domain conformance for legacy
backfill, A→B→C immediate ancestry, private copies, pagination, source update,
delete/hide, restriction and licensing. Extend existing single PostgreSQL harness
for coordinator validation; no second parallel database-dropping suite.
Add HTTP flag/auth/visibility and UI source-unavailable/paging/copy tests. Report
actual browser evidence and unavailable checks without calling skips passed.

Review full diff; make 1–3 logical commits. Report SHAs, migration version, backfill
behavior, API compatibility, test/acceptance evidence and risks. Integrate locally
into `codex/integrate-community`; coordinator owns broad CI/E2E and eventual delivery
to develop. No remote actions or deferred community implementation.
