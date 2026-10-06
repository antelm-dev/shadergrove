# Worker 01 - publication and moderation domain/API

Read the supplied coordinator README and repository instructions first.

## Mission, launch and isolation

Deliver the complete tested server contract for frozen public shader snapshots and minimum moderation. Delivery: `default-branch-pr`, base policy `latest-default`, default-off `PUBLIC_EXPLORE_ENABLED`. No prerequisites. Coordinator supplies exact refreshed default SHA `<exact-launch-base>` and checks it against the plan source.

Use branch `codex/public-explore-admin-01` and sibling worktree `E:/Adel/Documents/Orgs/shader-studio-public-01`; coordinator creates it using managed worktree tools where available, otherwise guarded `git worktree add <path> -b <branch> <exact-launch-base>`. Verify clean initial status. Do not execute from the planning checkout.

## Owned boundary and context

Own new publication DTOs at `libs/shared/src/publication.ts`, a dedicated backend publication domain/repository with SQLite/PostgreSQL implementations, versioned migrations, new server publication/admin controllers and tests, and minimal construction/module/config wiring. This is one coherent domain; supporting schema/export files may exceed five files. Keep private ShaderRepository/ShaderLibrary semantics intact except narrow transactional hooks required for coherent snapshot/source deletion.

Inspect `libs/backend/src/library/shader-library.ts` (especially exportOne/transaction/import), persistence migration runners/repositories, `libs/shared/src/model/records.ts`, payload validation, `apps/server/src/create-library.ts`, API module/bootstrap/AuthGuard, auth config and real-HTTP router tests. Existing exportOne is not an atomic snapshot. PostgreSQL conformance tests need a disposable database.

## Required work

Implement all shared README contracts: gated capabilities, opaque stable publication IDs, explicit publish/update/unpublish, coherent persisted snapshot/assets/presets/post-processing, expected revisions, private-by-default semantics, owner/source/account cleanup, public list/detail/assets/export and verified copy with attribution/license preservation.

Implement server-only admin-ID authorization, bounded verified reports with deduplication, admin listing/inspection/hide/restore, publisher restriction/restore, report resolution and durable transactional action history. Distinguish owner state from moderation state so update/republish cannot bypass removal. Account restrictions must not break private editing. Validate inputs and preserve existing error envelope, verify trusted-origin/CSRF checks for cookie mutations and enforce bounded request/payload/list limits. No server-side GPU execution, remote asset fetching or public emails/private identifiers. Use no-store visibility responses.

Freeze exact methods, DTOs, capabilities and concurrency/error behavior in a small API contract note under the plan docs or implementation documentation. Announce deviations before dependent launch; do not leave wave 2 guessing. Public author/license fields must be explicit and editable only under ownership, and source attribution must survive copies.

## Verification and delivery

Cover AC-SNAPSHOT, AC-PRIVACY, AC-LIFECYCLE, AC-MODERATION with real SQLite and PostgreSQL storage tests and live HTTP tests: two owners + anonymous + admin, source/thumbnail race, hide/update/republish race, conflict, visibility on all assets/export, reports/restrictions/audit and rejected cross-origin/unauthorized actions. Verify additive migrations on an existing private library, feature flag off, rollback by disabling feature and account/source deletion.

Run backend/server targeted specs and both typechecks using README commands; report actual paths, database provisioning and skips. Never claim skipped PG checks passed. Out of scope: UI, desktop/sync publication, standalone effects, global auth redesign. Intended destination master only after review/remote authorization; additive changes and default-off routes must be safe alone.

Make 1-3 logical commits, review the complete diff, and report exact base/HEAD, commits, changed paths, acceptance evidence, commands/results and risks.
