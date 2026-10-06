# Worker 01: Plugins management tabs

## Mission, launch and isolation

Read the Phase 3 README and full roadmap supplied by the coordinator. Separate discovery and installed-plugin management through two accessible tabs, preserving deep links and all existing package actions.

Prerequisite: Phase 1 importer extraction accepted and merged. Normally execute after Phase 2; no API dependency on that phase. `default-branch-pr` to `origin/master`, base policy `latest-default`; record coordinator-supplied `EXACT_LAUNCH_BASE=<fetched full master SHA>` containing the importer dialog. Read current source instead of assuming the original page line numbers still apply.

```text
git worktree add E:/Adel/Documents/Orgs/shader-studio-explore-plugins-p3-01 -b codex/explore-plugins-p3-01-plugin-tabs <EXACT_LAUNCH_BASE>
cd E:/Adel/Documents/Orgs/shader-studio-explore-plugins-p3-01
git status --short --branch
```

## Owned scope

Primary ownership: `apps/studio/src/app/plugins/plugins-page.ts`, `plugins-page.spec.ts`, `apps/studio-e2e/src/plugins.spec.ts`, required `i18n/en.json`/`fr.json` keys and key definitions when needed. A small local presentation component is allowed; no detail-panel architecture. Read PluginInstallations, PluginCatalogueService, Phase 1's shared importer dialog and command tests. Do not refactor these services or app routes/shell.

## Required behavior

- Show compatible catalogue discovery/status/install/update controls in Browse; show installed package enable/remove/contribution actions in Installed. Keep file installation and its review reachable as one shared workflow from either tab.
- Use optional `tab=browse|installed` URL state with default Browse. User tab switches push one history entry; normalization replaces it. Preserve unrelated query params. Clear use on manual tab changes when it would force the old tab.
- Follow `use=<packageId>` links after both relevant load states settle: Installed if present there, otherwise Browse if listed, otherwise keep a valid requested/default tab. Highlight and scroll once the entry is rendered. Preserve route reuse, delayed-load and profile-switch behavior; avoid normalization loops.
- Successful new installation selects/focuses Installed but never auto-enables the package. Keep review/error/update/up-to-date messages and existing package validation. Do not duplicate state outside existing services or add a Preferences tab setting.
- Installed project-import actions use Phase 1's dialog. Keep file/effect imports, exporters, theme use and active contribution menus working. Switching panels must not cancel a separate dialog or discard an install review/progress state. Inactive content is absent from keyboard focus; tabs support appropriate keyboard controls and responsive layout.
- Preserve the selected shader and unsaved draft through every management/navigation action. No new page paths or plugin execution contracts.

Acceptance: **AC-P3-TABS**, **AC-P3-URL**, **AC-P3-FOCUS**, **AC-P3-INSTALL**, **AC-P3-ACTIONS**, **AC-P3-DRAFT**. Out of scope: detail panels, catalogue search/filtering, registry/dependency work, effect/theme redesign and persistent app navigation.

## Verification and handoff

Run the Task 01 commands from README. Adapt existing E2Es for direct tab links, use links, install/review/cancel/enable/update/remove, shared import dialog, themes/contributions and draft preservation. Unit-test loading/profile races and route reuse rather than mirroring the template. Serialize Playwright runs with any other task. Manually inspect desktop and narrow-screen/keyboard behavior, reporting unavailable evidence separately.

Make 1–3 logical commits, review the full diff, and report exact launch/commit SHAs, acceptance IDs, commands/exit results, skipped/manual-unverified checks and risks. Independently deployable without a new flag/migration; rollback is presentation revert. Do not push/open/merge without later authorization.
