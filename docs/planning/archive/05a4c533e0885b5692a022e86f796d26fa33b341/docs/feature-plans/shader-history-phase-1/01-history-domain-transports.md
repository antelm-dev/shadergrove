# Task 01: Transactional history domain and transports

## Mission

Implement the backward-compatible Phase 1 history capability across shared types, both SQL repositories, `ShaderLibrary`, REST, and generated Electron IPC. Do not build UI.

Read the supplied coordinator README first and preserve its scope contract.

## Launch base and isolation

- Base policy: `latest-default`
- Exact base: `<exact-launch-base>` — coordinator records the refreshed `master` SHA at launch.
- Prerequisites: none.
- Branch: `codex/shader-history-01`
- Sibling worktree: `E:\Adel\Documents\Orgs\shader-studio-wt-shader-history-01`

```text
git worktree add E:\Adel\Documents\Orgs\shader-studio-wt-shader-history-01 -b codex/shader-history-01 <exact-launch-base>
cd E:\Adel\Documents\Orgs\shader-studio-wt-shader-history-01
git status --short --branch
```

Start only from a clean worker worktree.

## Context and owned boundary

Primary boundary:

- Shared history models/request types in `libs/shared/src/model/records.ts` and `libs/shared/src/api.ts`
- Repository contract, additive SQLite/PostgreSQL migrations, schemas, and implementations under `libs/backend/src/persistence/`
- Domain behavior and cross-engine coverage in `libs/backend/src/library/shader-library.ts` and `conformance.ts`
- REST routes/tests in `apps/server/src/api/api.controller.ts` and `router.spec.ts`
- Electron handlers in `apps/desktop/main/src/ipc/shader.ipc.ts` and regenerated `libs/desktop-api/src/ipc-bridge.ts`

Follow existing validation, `StorageError`, transaction, migration, and generated-IPC conventions. Do not edit migration 1.

## Required work

1. Add immutable history rows keyed by `(shader_id, revision)` containing timestamp, nullable checkpoint name, cause, optional restored-from revision, and serialized `project`, controls, render, and presets. Cascade on shader deletion and index newest-first listing.
2. Extend the repository transaction/read contract for insert, list, checkpoint metadata update, load, count/prune, and existence checks. Keep SQLite and PostgreSQL behavior equivalent.
3. Create initial snapshots for new/imported/duplicated shaders. For a pre-feature shader with no history, capture its current baseline before the first versioned mutation.
4. Snapshot source/config/render updates and preset save/delete in the same transaction as the head mutation. Exclude channel/texture-only, metadata-only, and thumbnail changes. Prune to 50 unnamed entries while retaining all named entries.
5. Add library methods to list history, set/clear a checkpoint name, and restore with required `expectedRevision`. Restore versioned fields and presets into a new head, preserve current identity/metadata/channels/assets, record provenance, and roll back fully on stale/missing/invalid input.
6. Expose list/checkpoint/restore through REST and Electron IPC using shared types and the standard error envelope. Regenerate IPC; do not hand-edit generated output.
7. Add conformance and route tests for AC-HIST-01 through AC-HIST-05, including persistence after reopen, baseline capture, pruning, checkpoint survival, immutable restore, preserved channel metadata, cascade, and rollback.

## Out of scope

UI, thumbnails, diffs, duplicate-from-revision, texture-byte history, compile health, configurable retention, bundle history, and speculative repository refactors.

## Contracts and verification

Use newest-first stable ordering (`revision DESC`). Checkpoint mutation does not bump head. Restore returns the new `ShaderRecord`. Not-found, invalid, and conflict errors must retain established semantics.

Run:

```text
pnpm --filter @shader-studio/backend test
pnpm --filter @shader-studio/backend typecheck
pnpm --filter @shader-studio/server test
pnpm --filter @shader-studio/server typecheck
pnpm gen:ipc
pnpm --filter @shader-studio/desktop typecheck
git diff --check
```

## Delivery and commit discipline

Intended destination: independent `default-branch-pr` to `master`; no feature flag. Do not push or open a PR without later authorization. Make 1–3 logical commits. Review the complete diff and report commit SHAs, exact checks/results, changed files, migration/rollback risks, and any deviation from the shared contract.
