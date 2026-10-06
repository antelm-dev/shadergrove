# Task 01 — Conditional delete

Read the coordinator `README.md` first; contract C1 is the spec.

## Mission

A client can delete a shader only if the shader has not changed since it last read it.

## Launch base

`latest-default` on `develop`, no prerequisites. Base: `<exact-launch-base>`.

```text
git worktree add <abs>/shader-studio-wt-desktop-sync-m2-01 -b codex/desktop-sync-m2-01 <exact-launch-base>
```

## Context

- `libs/backend/src/library/shader-library.ts`: `remove(id)`, and how `update` and `replaceFromPayload` use `expectedRevision` (`parseExpectedRevision`).
- `libs/backend/src/persistence/{sqlite,postgres}/*-repository.ts`: `deleteShader` and the conditional `WHERE … revision = ?` pattern already used for updates.
- `libs/backend/src/library/conformance.ts`: the shared suite both engines run.
- `apps/server/src/api/api.controller.ts`: `DELETE shaders/:id`, the audit record, Swagger decorators. `router.spec.ts` holds the REST tests.

## Owned scope

`shader-library.ts`, the two repositories (only the delete path), `conformance.ts`, `api.controller.ts`, `router.spec.ts`.

## Required work

1. `remove(id, expectedRevision?)`: when a revision is given, check it and delete in **one transaction**. A stale revision gives `conflict` and deletes nothing; an unknown or another user's shader gives `not_found`; a template is refused, as today. With no revision, behaviour is unchanged.
2. REST: an optional `?expectedRevision=` query parameter. It must be a positive integer, otherwise 400. A stale revision gives 409. Document it in Swagger. The audit line is written only after a successful delete.
3. Conformance tests: stale revision (the shader still exists); matching revision; missing; another user's shader; template; no parameter. REST tests: 204, 409, 400.

## Out of scope

Desktop and web code.

## Verification

```text
pnpm nx run @shader-studio/backend:test
pnpm nx run @shader-studio/server:test
pnpm nx run-many -t typecheck --projects "@shader-studio/*"
pnpm lint
```

Also run `oxfmt --check` on the changed files. Covers AC-API-03. The Postgres suite needs `SHADER_TEST_DATABASE_URL`; if it is not set, say so in the report.

## Delivery

A PR to `develop`: additive, no migration. Make 1–2 commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, and do not push. Report: the commits, the result of each check, and the risks.
