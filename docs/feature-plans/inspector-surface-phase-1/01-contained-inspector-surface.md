# Task 01 — contained inspector surface

Read the coordinator README for `inspector-surface-phase-1` before starting.

## Mission

Deliver Phase 1’s usable inspector surface: preserve the right-docked default, while enabling contained floating, drag/resize, minimize/maximize/restore, close/reopen, persisted geometry/tab, accessibility, and compact-screen fallback.

## Launch and isolation

Delivery is a `default-branch-pr` because the feature is backward-compatible and fully usable on its own. Base policy is `latest-default`: immediately before launch, the coordinator refreshes `origin/master` and replaces `<exact-launch-base>` below with its immutable SHA. No prerequisites.

```text
git worktree add E:\Adel\Documents\Orgs\shader-studio-inspector-surface-01 -b codex/inspector-surface-01 <exact-launch-base>
cd E:\Adel\Documents\Orgs\shader-studio-inspector-surface-01
git status --short --branch
```

Start clean. Preserve unrelated user changes; do not edit outside this mission. Make 1–3 logical commits.

## Context and owned scope

Primary implementation ownership:

1. `apps/web/src/app/ui/inspector/` — add an `InspectorShell` and any narrowly scoped inspector chrome/control component; keep `InspectorPanel` content alive through placement changes.
2. `apps/web/src/app/surfaces/surface-layout.ts` and its focused tests — hydrate/register/expose the inspector singleton and persist compatible inspector state.
3. `apps/web/src/app/app.html`, `app.ts`, and `app.scss` — replace fixed inspector rail/legacy resize wiring with the surface host while preserving responsive layout.
4. `libs/shared/src/surfaces/capabilities.ts` plus focused shared tests — enable contained inspector floating only; right docking remains the sole dock side.

Use `EditorShell`, `PreviewShell`, `SurfaceGeometryGesture`, `SurfaceResizeHandles`, `SurfaceTitleBar`, `projectSurfaceFrame`, and `SurfaceLayoutService` as established patterns. Update `i18n` keys/locales only if existing copy cannot accurately label the new chrome; run the repository i18n checker then.

## Required behavior

- Ensure `surface:inspector` is hydrated from the migrated layout and expose a typed accessor/id from `SurfaceLayoutService`; synchronize the selected inspector tab with `chrome.tab` rather than leaving two competing durable sources.
- Allow `layout.float(inspectorId)` and project floating/maximized/minimized frames inside `.workspace-main`. Pointer drag uses the title bar; all floating resize edges and right-docked resize use the shared accessible controls. Commit only at gesture end, activate on pointer/focus, and persist through the layout service.
- Provide a concise inspector window menu/controls for float, dock right, minimize, maximize/restore, reset geometry, and close. The existing “show controls” affordance must reopen a closed/minimized inspector.
- Preserve the fixed, stacked inspector sheet at the compact breakpoint; do not allow an off-screen floating state to make it unreachable.
- Cover AC-FLOAT, AC-DOCK, AC-WINDOW, AC-PERSIST, AC-COMPACT, and AC-A11Y with focused unit/component tests where feasible. Maintain existing legacy preference compatibility as the app migrates to `surfacesLayout`.

## Out of scope

No Electron `BrowserWindow`, IPC, native externalization, satellite route, cross-window synchronization, drag-to-dock targets, non-right inspector docks, shader browser/bottom-panel work, or unrelated surface refactoring.

## Verification and delivery

Run focused shared surface tests and targeted web layout/component tests; run `pnpm check:i18n` if translations change. Review the entire diff for responsive and z-index regressions. Report: commits; exact launch base; commands/results; evidence for each AC; files changed; remaining risks (especially native detachment, which remains deferred). Do not push or open a PR without explicit authorization.
