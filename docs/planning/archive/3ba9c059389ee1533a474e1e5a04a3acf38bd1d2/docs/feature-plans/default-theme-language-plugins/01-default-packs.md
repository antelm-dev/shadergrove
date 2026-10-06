# Worker 01 — Validated packs and one-time bootstrap

## Mission and launch

Deliver the shared data-only default-pack boundary: validated contracts,
deterministic official assets and durable seeding into the existing plugin stores.
Read the coordinator README supplied directly or through the planning ref; C1–C4
are binding. Do not start theme/language UI implementation.

Delivery: `integration-only`; intended destination is
`codex/integrate-default-theme-language-plugins`, eventually `origin/master`.
Base policy: `latest-default`; no prerequisites. Coordinator refreshes master and
records `LAUNCH_BASE_01=<exact SHA>` before dispatch.

Create branch `codex/default-packs-01` in the new sibling worktree
`E:\Adel\Documents\Orgs\shader-studio-default-packs-01` from that SHA. Verify
clean initial status and applicable repository instructions. Never use the user's
checkout or import its staged files.

## Owned boundary

Primary files: `libs/shared/src/plugin/{package,themes}.ts`,
`apps/studio/src/app/plugins/{plugin-installations,plugin-store}.ts`,
`tools/workspace/src/generate/official-plugins.ts`.
Supporting ownership is limited to shared language/key/ref contracts,
`prefs/preferences.ts` contracts/sanitizers, official default sources/release
assets, catalogue consumers, plugin persistence IPC/contracts/generated bridge,
and their tests. This is one cross-platform bootstrap boundary, not general
plugin architecture cleanup.

## Required work

1. Add protocol 3, language schema 1 and grouped theme schema 2 per C1/C3/C4.
   Preserve old package protocols and schema 1. Validate manifest-wide groups,
   locale identifiers, dictionary keys/placeholders and concrete bounds. Move/
   re-export canonical key metadata into browser-safe shared code; maintain
   typed application keys and the existing i18n checker.
2. Generate the three exact default packs in C1 as data without a Worker.
   Source en/fr from root dictionaries; derive the English boot fallback from
   the same source. Preserve current house UI/Monaco palettes and deterministic
   output of existing Worker packages. Include hashes and release assets.
3. Add versioned bootstrap/suppression metadata to web and desktop stores.
   Keep management confined to main-window IPC; regenerate its bridge.
   Seed app-allow-listed defaults enabled once after profile resolution.
   Preserve installed versions/disabled records, explicit removals and ordinary
   install/update-off behavior. Make partial failure and concurrent seeding
   recoverable; retain profile/load-generation protections and store capture.
4. Define/sanitize `appThemeMode`, `languagePackId`, validated locale support
   and separate theme/language migration markers in preferences. Retain legacy
   fields and pinned editor IDs. Export pure migration helpers if needed;
   runtime migration/selection belongs to 02/03.
5. Seeding must not wait inside `provideI18n` for auth/plugins. SSR/no storage/
   asset failure remains usable. Publish typed readiness/settled state for
   workers, with no DI dependency back into theme/i18n services. Do not seed
   satellite/output windows or automatically activate arbitrary packages.

Before handing off, report exact public types, bootstrap API, asset paths and
failure/readiness semantics to the coordinator. Freeze that contract for wave 2.

## Verification and delivery

Run `pnpm gen:ipc`, `pnpm gen:plugins`, README task-01 checks and the shared/
Studio affected typechecks. Add behavioral persistence/bootstrap tests including
profile switch during slow writes, two initializers, partial failure, removal
during seed and restart. Validate code-free packages and old ISF/project/theme
packages. Demonstrate deterministic regeneration without a second source of
translations or changed Worker output.

Provide AC-CONTRACT, AC-DEFAULTS and AC-BOOT evidence. This task alone is not
deployable: its new language consumer is pending. No PR/push/merge authorization.
Commit 1–3 logical changes, inspect the complete diff, report SHAs, checks with
exit status, owned/supporting files and remaining risks. Leave the worker
worktree for coordinator review.
