# Worker 01: Compatible public search and sort API

## Mission, base and isolation

Read this phase's README and the full roadmap supplied by the coordinator. Ship a complete additive public listing contract, preserving old clients and non-public pagination.

Prerequisite: Phase 1 accepted and merged. Delivery `default-branch-pr` to `origin/master`; base `latest-default`. Coordinator supplies `EXACT_LAUNCH_BASE=<fetched full master SHA>` and readable plan commit. Record the SHA and confirm a clean worktree before edits.

```text
git worktree add E:/Adel/Documents/Orgs/shader-studio-explore-plugins-p2-01 -b codex/explore-plugins-p2-01-api <EXACT_LAUNCH_BASE>
cd E:/Adel/Documents/Orgs/shader-studio-explore-plugins-p2-01
git status --short --branch
```

## Ownership and context

Own the public-list contract boundary: shared `libs/shared/src/publication.ts`; backend `publication-library.ts`, `publication-store.ts`; studio server `publications.controller.ts`; additive SQLite/PostgreSQL migration entries; matching conformance/API/migration tests and `docs/public-explore-api.md`. This exceeds five primary files because one compatible contract spans both persistence engines and the endpoint. No UI/cache/shell changes.

Current public/admin listings share `PublicationLibrary.page()`. The old before/nextCursor helpers also serve report/audit lists. Store defaults are title-only search and updated-time sorting. Both migration lists currently end at 4; recheck at launch. Published timestamps already exist and represent the original publication.

## Required work and contracts

- Add shared public sort values `updated`/`published`, default updated; reject unsupported API values. Keep existing response DTOs, bounds, error envelope, no-store headers and anonymous access.
- Public search matches title OR description OR author_label with grouped visibility/paging conditions and literal wildcard escaping. Never join private shader/user data; preserve admin title-only matching.
- Select sort columns through a fixed allowlist. Page by descending selected timestamp/id. Updates and republishing must not reset publishedAt.
- Emit public `{v:2,sort,search,at,id}` cursors bounded and validated as specified in README. Bind new cursors to normalized search and sort; accept legacy `{at,id}` only for updated order. Keep every admin/report/audit cursor path unchanged; test these separately. Avoid modifying the shared page helper in a way that changes admin behavior.
- Append a contiguous published-list index migration in both engines. Do not edit shipped migrations or their schema generator. Validate a real version-4 upgrade and a fresh database, preserving rows/history. An older binary refuses the upgraded ledger; test a behavior-rollback build that retains the new migration/version support. Keep migration changes separable from behavior changes within the commit budget.
- Update API documentation/OpenAPI wording and add conformance fixtures where publish/update times differ, timestamps tie, matches occur only in description/author, and hidden/restricted rows cannot appear. Include malformed and cross-query/sort cursors plus SQL wildcard literals.

Acceptance: **AC-P2-SEARCH**, **AC-P2-SORT**, **AC-P2-CURSOR**, **AC-P2-MIGRATION**, **AC-P2-REGRESSION**. Deferred: ranking, tags, full-text engines, admin search expansion, concurrent-feed snapshot guarantees and UI.

## Checks and delivery

Run Task 01 commands from README. Configure `SHADER_TEST_DATABASE_URL` for an isolated PostgreSQL test database; SQLite success does not satisfy PostgreSQL migration/conformance acceptance. Report unavailable setup as skipped with the gate unresolved. Record simple query-plan/cost evidence without asserting current-volume performance.

Review the full diff, produce 1–3 commits and report exact base/commit SHAs, acceptance IDs, commands/exit results, migrations and risks. No new flag; old requests remain valid. Rollback retains migration/version support and the index while reverting behavior, never redeploying an unsupported older binary. No remote actions are authorized. Wave 2 unlocks after this API is accepted, merged and reachable from refreshed master.
