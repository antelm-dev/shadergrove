# Explore and Plugins: phased delivery plan

## Goal, provenance and scope

Make Explore and Plugins fit the editor workflow through four separately executable milestones. The user requested the later phases after the Phase 1 plan was committed; this intentionally exceeds one coordination cycle while keeping each phase to 1–2 workers and at most two waves. Do not launch all six workers as one batch.

Source checkout: `E:/Adel/Documents/Orgs/shader-studio`, branch `develop`, source HEAD `bc9c705bf312359845c02ac0f81996ce00b69a93`. Existing Phase 1 planning commit: `aef78f4b77b693b2c1a198d9a5cde4cba9380314` on retained `codex/plan-explore-plugins-phase1`. This full plan extends that commit on `codex/plan-explore-plugins`; all phase READMEs below use the full planning ref. No implementation has run.

`origin` is `https://github.com/antelm-dev/shadergrove.git`. The remote default was reverified on 2026-10-04 as `master` at `076b3dcb086da4200f3b261018c7c93dab4c67f5`; remote `develop` matched source HEAD. Relevant existing Explore/Plugins/coordinator code is identical between those source and default tips. Refresh at every launch.

The temporary planning worktree is `E:/Adel/Documents/Orgs/shader-studio/tmp/explore-plugins-plan`; remove only that clean worktree after a docs-only commit, retaining both planning branches. Original staged docs and `libs/desktop-api/src/ipc-bridge.ts`, plus untracked `.bruno/collection.bru`, are excluded and preserved. No applicable AGENTS.md was found; recheck at launch.

## Milestones and execution order

| Phase | Plan | Workers / waves | Unlock | Outcome |
| --- | --- | --- | --- | --- |
| 1 | [Phase 1](../explore-plugins-phase1/README.md) | 2 / 1 | Existing source prerequisites present | Generic project-import dialog; Explore q/results/cursor/scroll restoration |
| 2 | [Phase 2](../explore-plugins-phase2/README.md) | 2 / 2 | Both Phase 1 slices accepted and merged to master | Public title/description/author search; published/updated sorting with compatible cursors |
| 3 | [Phase 3](../explore-plugins-phase3/README.md) | 1 / 1 | Phase 1 importer extraction merged; normally schedule after Phase 2 | Plugins Browse and Installed tabs, preserving use deep links |
| 4 | [Phase 4](../explore-plugins-phase4/README.md) | 1 / 1 | Phases 1–3 accepted and merged | Persistent top-bar navigation without destroying editor state |

Phase 3 is technically independent of Phase 2; the default schedule is sequential to keep review and delivery bounded. Only Phase 2 has an internal runtime dependency: the compatible API task must merge before the sort UI launches. Do not manufacture merge SHAs before implementation exists.

Every task is `default-branch-pr` with `latest-default`, intended for `origin/master` after its explicit merge gate. Fetch and record a full immutable launch SHA for each task. If prerequisites are merely open PRs or accepted commits on an integration branch, do not launch these prompts yet; replan classification/bases before integration-only work. Never silently substitute develop or a planning ref.

Give each worker its phase README and prompt directly, or an exact readable planning commit and paths using `git show`. Also provide this overview for cross-phase context. Keep each phase's review contract independent. Optional integration/review branches are listed in phase READMEs; they require no separate worker assignment. After an authorized merge, fetch and verify prerequisite results are reachable from master. Do not treat PR creation as completion.

## Shared delivery and review rules

- Each worker has unique branches and absolute sibling worktree names in its prompt. Inspect collisions and record suffixes; do not reuse user-owned worktrees. Create worker worktrees only when execution is requested.
- Workers make 1–3 logical commits, review complete diffs and report exact base/commit SHAs, acceptance IDs, command exit results, failed/skipped/manual-unverified checks and risks.
- On Windows use `NX_NO_CLOUD=true` and `NX_DAEMON=false`. Generate IPC through `pnpm gen:ipc` when checks need it; never commit generated IPC. Serialize Playwright: port 4322 and its temporary database are shared. Read the actual manifests rather than inventing project.json targets.
- Run targeted gates first, then each phase's aggregate gate once. Broaden/repeat only for a change, failure or unresolved concern. A test run must exit successfully, not merely print passing assertions.
- `review-feature-agents` handoffs use the individual phase contracts. Keep plan files out of implementation PRs unless explicitly requested. Reviewer-owned cross-phase conflicts go back to the slice owner.
- Planning does not authorize implementation, pushes, PRs or merges. A later instruction such as “Execute Phase 2 using its plan” authorizes local worker implementation. “Review completed Phase 2 tasks and open eligible PRs against master” authorizes opening PRs; merging needs explicit authorization.
- Preserve branches until accepted delivery. Clean up only workflow-created temporary worktrees with the skill's exact-path, clean-status and retained-branch checks. Keep the user's main checkout on develop.

## Cumulative acceptance and rollback

Across all phases: an unsaved shader survives browsing, cancellation and return navigation; menus reflect current active contributions; public Explore stays anonymous and web-only; hidden/unpublished content stays excluded on every backend request; desktop needs no publication HttpClient. Maintain stable `/shaders/:id`, `/explore`, `/explore/:id` and `/plugins` routes.

Phase 2 uses additive API behavior and an additive index migration. Preserve legacy updated-order cursors and all admin/report/audit cursor semantics. Phase 2 UI must follow the backend and use the same public sort contract in URL, API, cursor, cache and SSR. Do not rewrite publishedAt on snapshot updates or republishing.

Phase 3's management tabs are distinct from Phase 4's routed navigation links. Phase 4 must keep a single persistent nav and the editor mounted while moving content below it; CSS offsets alone must not leave the hidden editor focusable or the desktop title bar obscured.

Rollback consumer UI before its API if necessary. The migration runner rejects database versions newer than a build supports: after Phase 2's schema bump, an older release binary cannot start. A safe behavior rollback must retain the new migration/version support while reverting sort behavior, leaving the additive index installed; test that rollback candidate. Never downgrade the ledger, drop user data or edit shipped migrations. Other slices roll back by reverting presentation changes. No new feature flag is necessary for these complete milestones; existing Explore capabilities and web/desktop guards remain.

Each phase stops at its acceptance and integration gates. Remaining non-executable backlog: tags/capability filters, Popular/Hot ranking and social metrics, registry/catalogue growth, list-plus-detail layout, automatic live gallery previews, desktop Explore, theme/effect redesign and unrelated refactoring. These require new evidence and a new plan.
