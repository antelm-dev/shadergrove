# Phase 2: Public Explore search and sorting

## Milestone and prerequisites

Search public titles, descriptions and author labels, and choose Recently updated or Recently published through URL state. Two tasks, two waves: additive backend contract first, then the full web UI consumer. Read the [roadmap](../explore-plugins/README.md) and inherit its Git, worker, review and remote-action rules.

Planning ref: `codex/plan-explore-plugins`; source inspection base: `bc9c705bf312359845c02ac0f81996ce00b69a93`; remote/default: `origin/master` (observed `076b3dcb086da4200f3b261018c7c93dab4c67f5`). No implementation prerequisite SHAs exist yet. Both Phase 1 tasks must be accepted and merged before this phase; re-inspect their actual cache/SSR interfaces. Coordinator supplies this README, the prompt and the exact readable planning commit. Optional review branch: `codex/integrate-explore-plugins-phase2`.

| ID / wave | Primary outcome | Depends on | Delivery / base | Branch / sibling worktree |
| --- | --- | --- | --- | --- |
| 01 / 1 | Compatible public search/sort API | Phase 1 merged | default-branch-pr / latest-default | codex/explore-plugins-p2-01-api / E:/Adel/Documents/Orgs/shader-studio-explore-plugins-p2-01 |
| 02 / 2 | URL-backed sort UI and restored browsing | Task 01 merged to master, refreshed and acceptance gate passed | default-branch-pr / latest-default | codex/explore-plugins-p2-02-ui / E:/Adel/Documents/Orgs/shader-studio-explore-plugins-p2-02 |

Resolve each launch base to a fetched full master SHA; Task 02 must include the accepted API commit. Task 01 is independently useful to API clients, backward compatible and complete without its selector UI. Task 02 is deployable only with that API included; the same-app release contains both. No integration-tip fallback or new feature flag. Preserve the existing public Explore gate.

## Contracts and acceptance

- **AC-P2-SEARCH:** Public `search` keeps its 64-character bound and matches `(LOWER(title) LIKE term OR LOWER(description) LIKE term OR LOWER(author_label) LIKE term)`, with one grouped predicate ANDed with visibility/paging. Escape `!`, `%` and `_` literally and bind values. Search only publication snapshot fields, never private shaders/users. Preserve admin title-only search unless separately authorized.
- **AC-P2-SORT:** Export one shared public enum/type with `updated` and `published`. API `sort` defaults to `updated`; unsupported values return 400. Both sorts descend by their respective timestamp and then publication id. Published uses the existing first-publication timestamp, untouched by update/republish. Limit/envelope/no-store/visibility behavior stays intact.
- **AC-P2-CURSOR:** Newly emitted public cursors are bounded base64url JSON `{v:2, sort, search, at, id}`, bound to normalized search and sort. Reject malformed/version/type/timestamp/id/context mismatches as 400. Accept existing `{at,id}` public cursors only in updated mode, documenting that legacy cursors have no query binding. Keep admin/report/audit cursor encoding and parsing unchanged. Do not reuse a newly sorted public cursor in admin helpers.
- **AC-P2-MIGRATION:** Add a contiguous migration to SQLite and PostgreSQL for `(published_at DESC,id DESC)` indexing; inspect next versions at launch (currently both end at 4). Never modify shipped migration 4 or its schema generator to slip in new DDL. Verify fresh stores and upgrade from actual version-4 stores without changing data. The migration runner refuses an older binary against the new ledger: keep migration/version support in a behavior-rollback build and test that candidate against the upgraded store. Report query-plan measurements without promising scalability of substring search.
- **AC-P2-URL:** `/explore?q=...&sort=published` maps to the same public API sort; omit default updated. Invalid client sort normalizes to updated via replace navigation. User sort changes push history once, clear cursor/results/scroll for that query+sort, and prevent stale response delivery. Browser Back, detail's return link, direct URLs, SSR and hydration agree.
- **AC-P2-CACHE:** Extend Phase 1 cache keys and SSR transfer matching to normalized `(q,sort)`. Preserve its capacity/expiry and scroll restoration. Never append updated pages into published pages. Static thumbnails and opt-in preview behavior remain.
- **AC-P2-REGRESSION:** Existing callers omitting sort, legacy cursors, all moderation visibility paths, admin pagination, and unsaved drafts continue to work. New navigation/shell and metadata filters are out of scope.

Public cursor compatibility requires a separate public listing path or explicit public options: `PublicationLibrary.page()` currently serves public and admin listings, while `before()`/`nextCursor()` also serve report/audit lists. Shared store defaults stay title search and updated order for existing non-public callers. Use a fixed allowlist for choosing SQL columns, never raw query interpolation.

## Ownership and checks

Task 01 owns one narrow public-list contract boundary across shared `libs/shared/src/publication.ts`, backend `publication-library.ts`/`publication-store.ts`, server `publications.controller.ts`, migration entries in both engines, adjacent conformance/server/migration tests, and `docs/public-explore-api.md`. This is a justified primary-file exception: the cursor, query, docs and both schema versions must change together to ship a compatible API. It must not edit publication UI/cache files.

Task 02 owns `explore-page.ts`, `publication-api.ts`, Phase 1 `explore-browse-state.ts`, return context in `publication-page.ts`, matching SSR transfer state if needed, adjacent tests, `apps/studio-e2e/src/explore-navigation.spec.ts` and necessary en/fr keys. Backend and migration work remains Task 01's responsibility.

Task 01 targeted commands:

- `pnpm --filter @shadergrove/backend exec vitest run src/publication/publication.spec.ts src/persistence/postgres/postgres-repository.spec.ts`
- `pnpm --filter @shadergrove/backend typecheck`
- `pnpm --filter @shadergrove/studio exec vitest run --config vitest.server.config.ts src/server/api/publications/publications.spec.ts src/server/api/core/swagger.spec.ts`
- `pnpm --filter @shadergrove/studio typecheck:server`

Use an isolated PostgreSQL test database with `SHADER_TEST_DATABASE_URL` to run the existing cross-engine conformance harness. Without one, mark PostgreSQL skipped and keep the migration acceptance gate unresolved; never label its placeholder skipped test as PostgreSQL validation. Unit/conformance fixtures must deliberately differ publishedAt from updatedAt, include tied timestamps, description-only/author-only matches and hidden rows. A full page walk over a static dataset must have no repeated/skipped entries; do not claim snapshot isolation under concurrent updates.

Task 02: `pnpm --filter @shadergrove/studio exec ng test --watch=false --include='src/app/publications/**/*.spec.ts'`, `pnpm --filter @shadergrove/studio typecheck:web`, `pnpm check:i18n`, `pnpm gen:ipc`, then `pnpm --filter @shadergrove/studio-e2e exec playwright test src/explore-navigation.spec.ts`.

Coordinator aggregate gate: `pnpm lint`, `pnpm format:check`, `pnpm check`, `pnpm typecheck`, `pnpm --filter @shadergrove/backend test`, `pnpm --filter @shadergrove/studio test:server`, `pnpm --filter @shadergrove/studio test:web`, `pnpm build`, and `pnpm --filter @shadergrove/studio-e2e typecheck`; then named Explore and shader-switch E2Es after IPC generation. Inspect built SSR HTML/hydration for both q/sort combinations. Run the backend conformance with PostgreSQL configured; record setup and evidence.

E2E must cover sort switching with a page-two cursor, both return paths/back-forward, description/author queries, update-versus-first-publication order, invalid cursors and hidden rows. Mocked browser navigation tests prove UI behavior; use real backend conformance/server tests for SQL, migration and visibility evidence. Do not add publishing machinery to the shared E2E fixtures solely for this phase.

Rollback UI first if separating deployment. Retain the newly shipped migration/version support when reverting API behavior; deploying the old version-4 binary against the upgraded database would fail at startup. Keep migration and behavior changes separable within the worker's 1–3 commits, and verify a rollback candidate that retains the new ledger support, additive index and legacy updated behavior. Never lower the ledger or remove the index as rollback. New-public-cursor compatibility must be checked for updated mode. A reverted API cannot serve published order to a still-deployed new UI. Deferred: ranking, tags/capability filters, full-text search infrastructure, concurrent-feed snapshot guarantees, admin search expansion, shell and Plugins layout.

## Review handoff

```yaml
review_contract:
  milestone: explore-plugins-phase2
  planning_ref: codex/plan-explore-plugins
  source_base: bc9c705bf312359845c02ac0f81996ce00b69a93
  remote: origin
  default_branch: master
  integration_branch: codex/integrate-explore-plugins-phase2
  tasks:
    - id: "01"
      branch: codex/explore-plugins-p2-01-api
      depends_on: []
      acceptance: [AC-P2-SEARCH, AC-P2-SORT, AC-P2-CURSOR, AC-P2-MIGRATION, AC-P2-REGRESSION]
      checks:
        - "pnpm --filter @shadergrove/backend exec vitest run src/publication/publication.spec.ts src/persistence/postgres/postgres-repository.spec.ts"
        - "pnpm --filter @shadergrove/backend typecheck"
        - "pnpm --filter @shadergrove/studio exec vitest run --config vitest.server.config.ts src/server/api/publications/publications.spec.ts src/server/api/core/swagger.spec.ts"
        - "pnpm --filter @shadergrove/studio typecheck:server"
      delivery: default-branch-pr
      base_policy: latest-default
    - id: "02"
      branch: codex/explore-plugins-p2-02-ui
      depends_on: ["01"]
      acceptance: [AC-P2-URL, AC-P2-CACHE, AC-P2-REGRESSION]
      checks:
        - "pnpm --filter @shadergrove/studio exec ng test --watch=false --include='src/app/publications/**/*.spec.ts'"
        - "pnpm --filter @shadergrove/studio typecheck:web"
        - "pnpm check:i18n"
        - "pnpm gen:ipc"
        - "pnpm --filter @shadergrove/studio-e2e exec playwright test src/explore-navigation.spec.ts"
      delivery: default-branch-pr
      base_policy: latest-default
  integration_checks:
    - "pnpm lint"
    - "pnpm format:check"
    - "pnpm check"
    - "pnpm typecheck"
    - "pnpm --filter @shadergrove/backend test"
    - "pnpm --filter @shadergrove/studio test:server"
    - "pnpm --filter @shadergrove/studio test:web"
    - "pnpm build"
    - "pnpm --filter @shadergrove/studio-e2e typecheck"
    - "pnpm gen:ipc"
    - "pnpm --filter @shadergrove/studio-e2e exec playwright test src/explore-navigation.spec.ts src/shader-switch.spec.ts"
  e2e_scenarios:
    - "Search title, description and public author label; hidden rows remain excluded"
    - "Switch sort after page two; back/forward and detail return preserve query, sort and scroll"
    - "Published order stays stable after snapshot update and legacy updated cursors still work"
    - "Real cross-engine conformance and version-4 upgrades validate API and migrations"
  deferred: [ranking, filters, full-text-search, admin-search-expansion, concurrent-feed-snapshots]
```
