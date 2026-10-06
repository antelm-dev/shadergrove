# Worker 01: Generic project-importer dialog

## Mission and launch

Read the coordinator README supplied with this prompt. Make each supported active project importer usable from editor commands in a focused host-rendered dialog, sharing that dialog with the Installed-page action.

Delivery: `default-branch-pr` to `origin/master`; base policy: `latest-default`; prerequisites: none. Coordinator supplies `EXACT_LAUNCH_BASE=<full fetched origin/master SHA>`; record it before editing. Do not branch from the planning commit. Use branch `codex/explore-plugins-01-import-dialog` and sibling worktree `E:/Adel/Documents/Orgs/shader-studio-explore-plugins-01`; coordinator must resolve collisions safely.

```text
git worktree add E:/Adel/Documents/Orgs/shader-studio-explore-plugins-01 -b codex/explore-plugins-01-import-dialog <EXACT_LAUNCH_BASE>
cd E:/Adel/Documents/Orgs/shader-studio-explore-plugins-01
git status --short --branch
```

## Context and ownership

Own `apps/studio/src/app/plugins/project-import-dialog.ts` (new), `plugin-commands.ts`, the project-import presentation in `plugins-page.ts`, and adjacent tests. A small lazy opener helper within the same boundary is permitted if needed to avoid DI cycles. Own the plugin E2E updates in `apps/studio-e2e/src/plugins.spec.ts` and necessary en/fr translation changes. Read `host-adapters.ts`, `project-actions.ts`, `plugin-installations.ts`, Preferences, NewShaderDialog and WorkspaceActions. Existing Material dialogs provide accessibility/lazy-opening conventions.

## Required behavior

- Project importer commands open the dialog directly, without `/plugins` navigation. Resolve the current installed contribution by package/contribution IDs; preserve generic dispatch and disambiguated labels. No Shadertoy-specific command branch.
- The dialog presents manifest-supported provider/paste modes and host adapter fields. Preserve host credential remembering, input limits, translations and content-rights guidance.
- Replace the Installed-page project-import form with an action that opens this same dialog. Keep install/review/enable/remove behavior and `/plugins?use=` highlighting. Leave effect/file importers, exporters and theme actions unchanged.
- Reuse `ProjectPluginActions.runImport`; do not copy provider fetch, validation, adoption or export code. Resolve live context at open and submit. Invalidate the dialog when profile, install identity/version or active state changes, even before submission.
- Surface progress, errors, cancellation/stale outcomes and success warnings. Keep successful warnings readable until an explicit return to the editor. Closing while running cancels only its own operation and waits for settlement. Another running action disables submission. Preserve the existing unsaved-changes guard.
- Avoid cyclic injection involving PluginCommands, WorkspaceActions and NewShaderDialog. Load dialog code lazily. Browser and desktop must work without adding HttpClient to the desktop build. Restore keyboard focus after close.

Contracts/acceptance: **AC-IMPORT-ENTRY**, **AC-IMPORT-LIFECYCLE**, **AC-IMPORT-UI**, **AC-WORKSPACE** in README. No backend, protocol, IPC, route or publication changes. No Plugins tabs, catalogue redesign or effect/theme work.

## Verification and delivery

Run the exact Task 01 checks in README. Add meaningful command/dialog tests for a generic second importer, stale kept command, context invalidation, cancel ownership, warning retention and unsaved-draft decline. Adapt the existing mocked Shadertoy browser E2E to editor and New Shader entry points. Serialize Playwright with other workers. Manually check the desktop renderer; mark it unverified if unavailable.

Produce 1–3 logical commits; review the complete diff for scope and generated files. Report exact commits/base, acceptance coverage, command exit results and residual risks. Independently deployable, no new feature flag or migration; rollback is a revert. Do not push, open or merge a PR without later authorization.
