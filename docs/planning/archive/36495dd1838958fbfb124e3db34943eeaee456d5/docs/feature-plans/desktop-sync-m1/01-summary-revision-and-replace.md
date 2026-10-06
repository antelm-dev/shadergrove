# Task 01 — Summary revision and replace-with-revision

Read the coordinator `README.md` supplied with this prompt first. Contracts C1 and C2 are the spec.

## Mission

Give sync clients what they need to detect changes and push a whole shader safely: a `revision` on every summary, and an atomic, scoped replace-from-bundle that checks `expectedRevision`.

## Launch base

`latest-default` on `develop`, no prerequisites. Base: `<exact-launch-base>`.

```text
git worktree add <abs>/shader-studio-wt-desktop-sync-01 -b codex/desktop-sync-01 <exact-launch-base>
cd <abs>/shader-studio-wt-desktop-sync-01
git status --short --branch
```

## Context

- `libs/shared/src/model/records.ts`: `ShaderSummary` and `toSummary`.
- `libs/backend/src/library/shader-library.ts`: `update` (the `expectedRevision` handling), `importPayloads` (delete then insert, which resets the revision to 1; do not reuse it for replacing), `insertPayload`, `materialize` (the template rules).
- `libs/backend/src/persistence/{sqlite,postgres}/*-repository.ts`: how revision and the scoped `WHERE owner_user_id` are enforced. The `revision = revision + 1 … AND (? IS NULL OR revision = ?)` pattern is already there.
- `libs/backend/src/library/conformance.ts`: the shared suite both engines run. Add tests there, not per engine.
- `apps/server/src/api/api.controller.ts` and `swagger.ts`: route, validation and Swagger conventions. The existing `POST import` shows how to parse a bundle.

## Owned scope

`records.ts`, `shader-library.ts`, the two repositories (only the methods needed), `conformance.ts`, `api.controller.ts` (+ `swagger.ts` if needed).

## Required work

1. Add `revision` to `ShaderSummary` from both engines' list queries.
2. Add `ShaderLibrary.replaceFromPayload(id, payload, expectedRevision)`. It runs in one transaction: a scoped load, then refuses a template (`invalid`), refuses a stale revision (`conflict`), and refuses an unknown or foreign shader (`not_found`). It replaces fields, project, controls, render, presets, textures and thumbnail, and keeps `id`, owner, `kind` and `createdAt`. The new revision is `expectedRevision + 1`. Validate the payload with the same validators import uses.
3. Add `PUT /api/shaders/:id/bundle` with `{ bundle, expectedRevision }`. `bundle` must be a single-shader bundle. Respond `{ shader }`. The status codes come from `StorageError` (409 and 404 already map).
4. Check that **every** mutation increments `revision`: update, preset save and delete, texture set and clear, thumbnail. Sync relies on this to detect changes. If one of them does not, fix it and cover it in the conformance suite.

## Out of scope

Desktop code, auth, the `ShaderApi` abstraction (no new abstract method), web UI.

## Verification

```text
pnpm nx run @shader-studio/backend:test
pnpm nx run @shader-studio/server:test
pnpm nx run-many -t typecheck --projects "@shader-studio/*"
pnpm lint && pnpm format:check
```

Covers AC-API-01 and AC-API-02. Conformance cases: stale revision gives 409 and changes nothing; another user's shader gives 404; a template is refused; children are replaced (a preset that was removed is gone, a texture that was removed is gone); the revision is exactly expected + 1; a summary's revision matches the record's.

## Delivery

A `default-branch-pr` to `develop`. The change is additive: one new optional field on the summary, one new endpoint that nothing calls yet. No migration and no flag.

## Commits

1 to 3 logical commits, for example `feat(backend): replace a shader from a bundle under expectedRevision` and `feat(server): expose PUT /shaders/:id/bundle`. Report: commits, check output, acceptance IDs, risks.
