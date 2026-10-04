# Worker 02 — Themes through plugin selections

## Mission and launch

Make the default Light/Dark palettes ordinary active plugin choices, with
host-owned System mode, preserved legacy settings and safe fallback.
Read the supplied coordinator README and consume C1–C3; do not recreate the
shared contracts or seeding machinery.

Delivery: `integration-only`, targeting
`codex/integrate-default-theme-language-plugins`, eventually `origin/master`.
Base policy: `integration-tip`; prerequisite: 01 accepted, its checks passed and
commits reachable on integration. Coordinator records
`LAUNCH_BASE_02=<exact accepted integration SHA>` before launch.

Create `codex/default-themes-02` in new sibling worktree
`E:\Adel\Documents\Orgs\shader-studio-default-themes-02` from that SHA. Confirm
clean status, applicable instructions and availability of 01's frozen handoff.

## Owned scope

Primary files: `apps/studio/src/app/themes/{app-themes,theme-catalog,theme-menu}.ts`,
theme sections of `apps/studio/src/app/plugins/plugin-commands.ts`, and theme-only
settings/palette sections of `apps/studio/src/app/app.ts`.
Supporting scope: corresponding tests, `apps/studio-e2e/src/plugin-themes.spec.ts`,
theme panel consumers and minimal fallback CSS corrections necessary for parity.
Shared preference/schema/default asset contracts remain owned by 01; language
menu, i18n runtime and new UI text keys are owned by 03. Request any required text
through the coordinator, with default English wording and keys.

## Required work

1. Resolve active schema-2 variant groups per C3 without changing schema-1
   fixed-theme behavior. System observes OS changes independently of remembered
   fallback `colorScheme`; it resolves the selected package's pair only.
   Light/Dark choose concrete contributions in fixed mode. Expose System only
   when a valid complete group exists.
2. Replace fixed built-in Light/Dark/System palette commands/rows with official
   plugin entries plus the host mode control. Reuse ThemeMenu and PluginCommands
   across web/titlebar/preview surfaces. Do not add a second theme registry or
   duplicate builtin/default entries. Native radio state and keyboard behavior
   must reflect effective selections.
3. Once defaults settle, migrate legacy builtin light/dark/system once using
   the preferences contract from 01. Preserve existing third-party references
   and pinned Monaco choices. Migration must not repeatedly overwrite changes
   on login, reinstall or restart, and must not select an unavailable pack.
4. Clear previous tokens, paint current UI and define Monaco before selecting.
   Editor auto follows the resolved variant; fixed editor overrides persist.
   Missing/disabled/corrupt/incompatible selections apply fallback immediately
   while retaining stored references. Selecting from an old palette command
   revalidates the active package/ref, so stale profile or package state cannot
   replace current preferences.
5. Retain deterministic SSR/startup fallback and safe preview/output/satellite
   behavior. Verify existing optional-role CSS inheritance. Do not delete the
   fallback palettes or redesign existing house colours.

## Verification and delivery

Run `pnpm gen:ipc`, README task-02 commands and the affected Studio typecheck.
Extend resolution/DOM tests for migration, live OS changes, fixed schema-1 themes,
invalid groups, profile switches and commands captured before disable/update.
E2E covers default packs, no duplicate rows, radio selection, restart/removal,
UI overlays and Monaco, with screenshots showing Light/Dark parity. Record
manual desktop scope separately; packaging is not installed-app proof.

Deliver AC-THEMES and the theme portions of AC-MIGRATION/AC-LIFECYCLE. Inspect
the whole diff; make 1–3 logical commits. Report SHAs, exact commands/exits,
acceptance evidence, screenshots, changed ownership sections and risks. No remote
actions or worktree removal; coordinator reviews and integrates.
