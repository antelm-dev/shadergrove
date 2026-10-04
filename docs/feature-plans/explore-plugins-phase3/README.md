# Phase 3: Plugins Browse and Installed tabs

## Milestone, launch and delivery

Separate package discovery from local installation management without adding a detail panel or redesigning execution. One worker, one wave. Read the [full roadmap](../explore-plugins/README.md); its Git isolation, evidence, remote-action and cleanup rules apply.

Planning ref: `codex/plan-explore-plugins`; inspected source base `bc9c705bf312359845c02ac0f81996ce00b69a93`; remote/default `origin/master`. Phase 1's importer dialog must be accepted and merged before launch. Normally deliver this after Phase 2; it has no technical dependency on Phase 2. Re-inspect actual Phase 1 extraction and current installation tests. No prerequisite merge SHA exists yet.

Task 01: branch `codex/explore-plugins-p3-01-plugin-tabs`; sibling worktree `E:/Adel/Documents/Orgs/shader-studio-explore-plugins-p3-01`; `default-branch-pr`, base policy `latest-default`, intended destination `origin/master`. Coordinator records the fetched full SHA containing importer extraction and supplies this README/prompt using an exact readable planning commit. Optional review branch: `codex/integrate-explore-plugins-phase3`. No new feature flag, API, protocol or persistence migration. Revert presentation changes for rollback.

## Contracts and acceptance

- **AC-P3-TABS:** `/plugins` offers Browse and Installed management tabs using existing Angular Material conventions. Browse shows compatible official catalogue entries/status/actions; Installed shows activation, removal and contribution actions. The file-install entry and review workflow remain reachable from either tab through a shared page action/review region. No duplicate plugin management forms. Both tabs have useful loading/error/empty states and counts derived from existing services, if counts are displayed.
- **AC-P3-URL:** Optional `tab=browse|installed` query state, default Browse with empty/default omitted. Normalize invalid values via replace navigation. Manual tab selection creates one history entry, preserves unrelated params, and clears `use` when it would otherwise force the old tab. Navigation/reload/back-forward keep the selected tab.
- **AC-P3-FOCUS:** Existing `?use=<packageId>` remains authoritative for focusing a package: once installation/catalogue loading settles, choose Installed if present there, otherwise Browse if the catalogue has it. If absent from both, retain a valid requested/default tab without redirect loops. Focused entry highlights and scrolls after the matching panel renders. Route reuse to a different use ID, switching profile, and install/update/removal re-evaluate safely; no early normalization against an incomplete loading state.
- **AC-P3-INSTALL:** A successful new installation selects Installed and focuses its package; installed remains disabled until explicitly enabled. Catalogue install/update labels and up-to-date markers stay correct. Review cancellation, invalid packages, incompatible/disabled/problem packages and profile changes preserve existing behavior. Update without installation identity changes must not lose review messages.
- **AC-P3-ACTIONS:** Installed project import actions open Phase 1's shared dialog. File/effect importers, exporters, theme selection and active-contribution menu visibility retain behavior. Switching tabs never destroys an active import/dialog or exports unexpectedly. Preserve relevant pending review/progress state; inactive content cannot receive keyboard focus. Accessible tab keyboard navigation and focus indicators work on narrow screens.
- **AC-P3-DRAFT:** Plugin management/tab navigation never switches or discards the open shader or unsaved draft. No app shell/navigation, catalogue fetch strategy, theme/effect redesign or detail-panel work.

The current page highlights/scrolls from `queryParamMap` and prefers an installed card over the catalogue card. Do not regress this intent when splitting the views. Keep PluginInstallations and PluginCatalogueService as sources of truth; do not introduce a second plugin registry or persist tab choices in Preferences.

## Ownership, gates and scenarios

Task 01 owns `apps/studio/src/app/plugins/plugins-page.ts`, `plugins-page.spec.ts`, `apps/studio-e2e/src/plugins.spec.ts`, and necessary en/fr translation keys. A local tab presentation component is permitted only if it makes this extraction materially clearer; no new detail-view architecture. Read the Phase 1 dialog, service interfaces and deep-link tests; avoid changes to execution/catalogue/installations services.

Targeted commands:

- `pnpm --filter @shadergrove/studio exec ng test --watch=false --include='src/app/plugins/plugins-page.spec.ts' --include='src/app/plugins/plugin-commands.spec.ts'`
- `pnpm --filter @shadergrove/studio typecheck:web`
- `pnpm check:i18n`
- `pnpm gen:ipc`, then `pnpm --filter @shadergrove/studio-e2e exec playwright test src/plugins.spec.ts src/plugin-themes.spec.ts`

Aggregate gate: `pnpm lint`, `pnpm format:check`, `pnpm check`, `pnpm typecheck`, `pnpm --filter @shadergrove/studio test:web`, `pnpm build`, `pnpm --filter @shadergrove/studio build:renderer`, and `pnpm --filter @shadergrove/studio-e2e typecheck`. Run targeted E2E only once unless a later edit/failure requires another run. Manually inspect browser/desktop layouts and keyboard behavior; unavailable desktop evidence is manual-unverified.

Critical E2E: direct Browse/Installed URLs; use deep links into existing/missing/newly installed packages; route reuse/back-forward; install/review/cancel/enable/update/remove workflow across tabs; importer dialog from Installed and editor command; theme selection and effect/file actions; unsaved-draft retention. Tests should assert task visibility and outcomes rather than fixed tab markup. Unit tests cover delayed loading/profile changes and loop prevention.

Produce 1–3 commits and report exact bases/SHAs, acceptance evidence, command exit results and risks. Stop when these gates pass. Deferred: plugin detail panel, catalogue search/categories, registry updates, dependency management and persistent app navigation (Phase 4).

## Review handoff

```yaml
review_contract:
  milestone: explore-plugins-phase3
  planning_ref: codex/plan-explore-plugins
  source_base: bc9c705bf312359845c02ac0f81996ce00b69a93
  remote: origin
  default_branch: master
  integration_branch: codex/integrate-explore-plugins-phase3
  tasks:
    - id: "01"
      branch: codex/explore-plugins-p3-01-plugin-tabs
      depends_on: []
      acceptance: [AC-P3-TABS, AC-P3-URL, AC-P3-FOCUS, AC-P3-INSTALL, AC-P3-ACTIONS, AC-P3-DRAFT]
      checks:
        - "pnpm --filter @shadergrove/studio exec ng test --watch=false --include='src/app/plugins/plugins-page.spec.ts' --include='src/app/plugins/plugin-commands.spec.ts'"
        - "pnpm --filter @shadergrove/studio typecheck:web"
        - "pnpm check:i18n"
        - "pnpm gen:ipc"
        - "pnpm --filter @shadergrove/studio-e2e exec playwright test src/plugins.spec.ts src/plugin-themes.spec.ts"
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
  e2e_scenarios:
    - "Browse/Installed URL, back-forward and use links choose the visible package without loops"
    - "Review/install/update/enable/remove and shared importer dialog remain usable"
    - "Themes, contributions, keyboard navigation and unsaved draft survive tab changes"
  deferred: [plugin-detail-panel, catalogue-filters, registry-changes, persistent-navigation]
```
