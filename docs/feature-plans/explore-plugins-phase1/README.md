# Explore and Plugins usability, Phase 1

## Goal and bounded milestone

Make project importers usable directly from editor commands, and let visitors return from a public shader to their exact Explore browsing context. Two independent vertical slices, one execution wave. This is documentation only; no workers have been launched.

The larger agreed order remains: importer dialog; Explore URL/cache restoration; broader search and sort-aware pagination; Plugins Browse/Installed tabs; persistent top-bar navigation. Only the first two are executable in this phase. Later phases now have separate bounded plans linked from the [full roadmap](../explore-plugins/README.md); do not launch their prompts as part of this cycle.

## Repository evidence and planning provenance

- Original checkout: `E:/Adel/Documents/Orgs/shader-studio`, branch `develop`.
- Source HEAD: `bc9c705bf312359845c02ac0f81996ce00b69a93`.
- Planning ref for the full roadmap: `codex/plan-explore-plugins`; plan directory: `docs/feature-plans/explore-plugins-phase1/`. The original Phase 1 planning branch remains retained at `aef78f4b77b693b2c1a198d9a5cde4cba9380314`.
- Remote: `origin`, `https://github.com/antelm-dev/shadergrove.git`; remote default is `master`, verified on 2026-10-04. Its observed tip was `076b3dcb086da4200f3b261018c7c93dab4c67f5`. Relevant plugin/publication source and RoutingCoordinator have no diff against source HEAD. Refresh again at launch.
- Original staged changes were `docs/future-plans.md`, `docs/plugin-adapters-plan.md`, `docs/shadertoy-wallpaper-plugins-sketch.md`, and `libs/desktop-api/src/ipc-bridge.ts`; `.bruno/collection.bru` was untracked. None is part of this plan or a worker base.
- The original Phase 1 temporary worktree at `E:/Adel/Documents/Orgs/shader-studio/tmp/explore-plugins-phase1-plan` was removed after its docs-only commit; its branch was retained. The full-roadmap planning worktree lifecycle is recorded in the overview.
- No applicable `AGENTS.md` was found. Recheck applicable instructions at execution time.

`PAGE_STYLES` fixes each page over the editor and makes the host its scroll container. Explore currently owns search in a component signal and uses `PublicationApi.list(search, cursor)`. The server searches title and orders by `(updated_at, id)`. Plugins contains installation management and contribution forms; project importer commands currently navigate to `/plugins?use=<packageId>`. Active contribution menus and theme/effect commands already exist. `ProjectPluginActions` owns execution, cancellation, context invalidation and guarded adoption. Host adapters declare provider fields, including credentials; manifests declare importer modes.

## Launch and delivery

| Task | Outcome | Dependencies | Delivery | Base policy | Branch | Sibling worktree |
| --- | --- | --- | --- | --- | --- | --- |
| 01 | Generic project-importer dialog | None | default-branch-pr | latest-default | codex/explore-plugins-01-import-dialog | E:/Adel/Documents/Orgs/shader-studio-explore-plugins-01 |
| 02 | Explore URL and browsing restoration | None | default-branch-pr | latest-default | codex/explore-plugins-02-explore-state | E:/Adel/Documents/Orgs/shader-studio-explore-plugins-02 |

Intended PR destination: `origin/master`; no new feature flag is needed because each complete slice is independently usable and introduces no migration or incomplete API. Task 02 retains the existing Explore feature gate. A rollback reverts the relevant slice without persisted-data changes.

Before launch, fetch `origin`, resolve `origin/master` to a full immutable SHA, and record that SHA separately for each worker. Refuse to launch if prerequisite code disappeared or changed incompatibly; update the plan instead. Do not use the planning branch as a runtime base. Supply each worker this README and its prompt directly, or give the resolved planning commit and readable paths via `git show <planning-commit>:<path>`; source-based branches do not contain these documents automatically.

Create worktrees only during execution, with exact launch SHAs and clean initial status. If a name/path already exists, inspect ownership and use a recorded unique suffix. Independent workers may run in one wave, but serialize Playwright runs: the fixture uses port 4322 and one shared temporary database.

An optional coordinator review branch is `codex/integrate-explore-plugins-phase1`, based on the recorded default SHA and containing accepted worker commits. It has no implementation assignment. Resolve overlap with the owner of the affected slice. Opening a PR is not integration: after an authorized merge, fetch and verify the accepted result is reachable from `origin/master`.

Planning and execution do not authorize pushing, opening, or merging PRs. A later instruction such as “Review completed tasks and open eligible PRs against master” authorizes opening; merging requires explicit authorization. Preserve worker branches until delivery is accepted; never clean up user-owned worktrees.

## Shared contracts and acceptance

- **AC-IMPORT-ENTRY:** Every active supported `projectImporter` command opens its own host-rendered dialog directly from the menu, palette and New Shader choice. No package IDs are hard-coded; no navigation to the plugin manager is required. Installed-page project import actions use the same dialog, removing the duplicate inline project-import form. File/effect importers and exporters retain their behavior.
- **AC-IMPORT-LIFECYCLE:** Resolve live contribution/profile context at opening and submission; an update, removal, deactivation or profile switch invalidates the open dialog. Reuse `ProjectPluginActions.runImport` and its existing adoption/abort protections. Closing during work cancels that dialog's operation and waits for settlement; do not accidentally cancel another operation. Preserve progress, failure/stale/cancel messages, warnings and host-only credential preferences. Keep warnings visible after success with an explicit return to the editor; cancellation preserves the draft.
- **AC-IMPORT-UI:** Provider/paste modes, labels, keyboard focus and restoration work on browser and desktop. Open dialog code lazily using existing Material dialog conventions. Avoid a DI cycle: `ProjectPluginActions` already resolves WorkspaceActions on use, and NewShaderDialog consumes PluginCommands. Never expose credentials to workers or logs.
- **AC-EXPLORE-URL:** `?q=` is the sole search source of truth. Trim and apply `PUBLICATION_LIMITS.searchLength`, omit empty q, and keep the input synchronized on same-route navigation. A submitted changed query creates a history entry; normalization replaces the current entry. Do not push an entry per keystroke. Phase 1 exposes no sort selector or `sort` contract.
- **AC-EXPLORE-RESTORE:** Browser back and the detail page's Explore link restore normalized search, loaded pages, next cursor and host scroll position. A fresh direct detail link falls back to unfiltered Explore. Cache only public summaries in browser memory, keyed by normalized q and the existing updated-order policy; retain at most three query snapshots for at most five minutes. Do not persist to localStorage or transfer unrelated cached queries through SSR. Expired/missing cache starts a normal request.
- **AC-EXPLORE-ROBUST:** Restore scroll after cached cards render; stale requests/restoration callbacks cannot overwrite a newer query. Cache completed result snapshots, not errors or loading state. SSR and hydration honor q and transfer only the matching first page. Refresh/loading/error/unavailable and empty states still work; detail 404s do not break return navigation. Thumbnail-only listing, opt-in previews and existing web-only access remain intact.
- **AC-WORKSPACE:** Neither slice changes route paths, RoutingCoordinator's standalone-page exception, selected shader or unsaved draft while browsing/cancelling. Only a successful guarded import may switch selection. No generated IPC changes are committed.

## Ownership and verification

Worker 01 owns the plugins project-import presentation boundary: proposed `project-import-dialog.ts` (and local opener helper only if necessary), `plugin-commands.ts`, and the project-import portion of `plugins-page.ts`, plus adjacent tests. Read `host-adapters.ts`, `project-actions.ts`, `plugin-installations.ts`, preferences, NewShaderDialog and WorkspaceActions; do not redesign these execution services. It alone owns `apps/studio-e2e/src/plugins.spec.ts` changes. New/changed translation keys belong to worker 01 in `i18n/en.json`, `i18n/fr.json` and the existing key definitions if required; avoid unnecessary new wording.

Worker 02 owns `explore-page.ts`, `publication-page.ts`, a proposed `explore-browse-state.ts`, and the matching-query TransferState boundary in `page.ts` only if necessary. It owns adjacent Explore/cache tests and a new `apps/studio-e2e/src/explore-navigation.spec.ts`; it must not modify the plugin E2E fixture or shared server configuration. Backend/shared publication DTOs, routes and shell are read-only for both.

Commands run from a worker/review root after dependency setup. Use `NX_NO_CLOUD=true` and `NX_DAEMON=false` on Windows. A green assertion summary without process exit is not a passing run: bound it and report lifecycle/environment failures separately.

- Task 01: `pnpm --filter @shadergrove/studio exec ng test --watch=false --include='src/app/plugins/**/*.spec.ts'`; `pnpm --filter @shadergrove/studio typecheck:web`; `pnpm check:i18n`; `pnpm gen:ipc` then `pnpm --filter @shadergrove/studio-e2e exec playwright test src/plugins.spec.ts`.
- Task 02: `pnpm --filter @shadergrove/studio exec ng test --watch=false --include='src/app/publications/**/*.spec.ts'`; `pnpm --filter @shadergrove/studio typecheck:web`; `pnpm gen:ipc` then `pnpm --filter @shadergrove/studio-e2e exec playwright test src/explore-navigation.spec.ts`. Add meaningful tests for routing/history, cache isolation/expiry, request races and SSR query mismatch rather than implementation mirrors.
- Coordinator aggregate gate after both targeted gates pass: `pnpm lint`, `pnpm format:check`, `pnpm check`, `pnpm typecheck`, `pnpm --filter @shadergrove/studio test:web`, `pnpm build`, `pnpm --filter @shadergrove/studio build:renderer`, and `pnpm --filter @shadergrove/studio-e2e typecheck`. Then run both named E2E files plus `src/shader-switch.spec.ts` together, after IPC generation. Review RoutingCoordinator regression tests as part of the web suite. Run each broad check once unless a failure or later edit requires repeating it.

Critical E2E scenarios:

1. Install/enable Shadertoy; launch from editor menu and New Shader; paste/API imports produce a new shader and retain existing success warnings. Mock provider responses; no external Shadertoy requests.
2. Start an import with unsaved work; decline replacement or cancel progress and keep the original draft. Unit tests cover deterministic profile/plugin invalidation and a kept command after update.
3. Search `q`, load page two, scroll, open a publication, then return using both browser Back and the Explore link: same cards/cursor/query/scroll. Back/forward between two searches never mixes their pages.
4. Open a fresh q URL and reload; use the current search endpoint, not cached results from another query. Exercise slow responses, an expired cache, and a missing publication with controlled API fixtures.
5. Keep a modified shader open through all browsing and cancellation paths. The browser fixture may mock public `/api/capabilities` and `/api/publications` endpoints before navigation, without changing shared server env or claiming real publishing/backend validation.

Manually verify the importer in a running desktop renderer and the built SSR application's initial q HTML/hydration. Browser mocks do not prove desktop adapter behavior or SSR. Explicitly report passed, failed, skipped and manual-unverified checks. Each worker produces 1–3 logical commits, a complete diff review and an evidence report with exact SHAs, launch base, acceptance IDs, commands/exit results and residual risks. Stop when the acceptance and aggregate gates pass; do not expand into new features.

## Later milestones, not assignments for this phase

1. [Phase 2](../explore-plugins-phase2/README.md): description/author search and Recently published/Recently updated sorting, compatible sort-aware cursors and index migration.
2. [Phase 3](../explore-plugins-phase3/README.md): Plugins Browse/Installed tabs after importer extraction, preserving `/plugins?use=` behavior.
3. [Phase 4](../explore-plugins-phase4/README.md): persistent Editor/Explore/Plugins top-bar navigation; desktop shows Editor/Plugins, with mounted-state and routing validation.
4. Metadata/tag/capability filters, ranking/social metrics, live feed previews, desktop Explore, registry changes, theme/effect redesign and unrelated cleanup.

## Machine-readable review handoff

```yaml
review_contract:
  milestone: explore-plugins-phase1
  planning_ref: codex/plan-explore-plugins
  source_base: bc9c705bf312359845c02ac0f81996ce00b69a93
  remote: origin
  default_branch: master
  integration_branch: codex/integrate-explore-plugins-phase1
  tasks:
    - id: "01"
      branch: codex/explore-plugins-01-import-dialog
      depends_on: []
      acceptance: [AC-IMPORT-ENTRY, AC-IMPORT-LIFECYCLE, AC-IMPORT-UI, AC-WORKSPACE]
      checks:
        - "pnpm --filter @shadergrove/studio exec ng test --watch=false --include='src/app/plugins/**/*.spec.ts'"
        - "pnpm --filter @shadergrove/studio typecheck:web"
        - "pnpm check:i18n"
        - "pnpm gen:ipc"
        - "pnpm --filter @shadergrove/studio-e2e exec playwright test src/plugins.spec.ts"
      delivery: default-branch-pr
      base_policy: latest-default
    - id: "02"
      branch: codex/explore-plugins-02-explore-state
      depends_on: []
      acceptance: [AC-EXPLORE-URL, AC-EXPLORE-RESTORE, AC-EXPLORE-ROBUST, AC-WORKSPACE]
      checks:
        - "pnpm --filter @shadergrove/studio exec ng test --watch=false --include='src/app/publications/**/*.spec.ts'"
        - "pnpm --filter @shadergrove/studio typecheck:web"
        - "pnpm gen:ipc"
        - "pnpm --filter @shadergrove/studio-e2e exec playwright test src/explore-navigation.spec.ts"
      delivery: default-branch-pr
      base_policy: latest-default
  integration_checks:
    - "pnpm lint"
    - "pnpm format:check"
    - "pnpm check"
    - "pnpm typecheck"
    - "pnpm --filter @shadergrove/studio test:web"
    - "pnpm build"
    - "pnpm --filter @shadergrove/studio build:renderer"
    - "pnpm --filter @shadergrove/studio-e2e typecheck"
    - "pnpm gen:ipc"
    - "pnpm --filter @shadergrove/studio-e2e exec playwright test src/plugins.spec.ts src/explore-navigation.spec.ts src/shader-switch.spec.ts"
  e2e_scenarios:
    - "Editor and New Shader project-import commands use the same generic dialog"
    - "Paste/API import, warnings, cancellation and unsaved-draft preservation"
    - "Explore search, page-two and host-scroll restoration through both return paths"
    - "Direct query links, reload, back/forward, slow requests and missing publications"
  deferred:
    - broader-search-and-sort-aware-cursors
    - plugins-browse-installed-tabs
    - persistent-top-bar-navigation
    - filters-social-ranking-and-desktop-explore
```
