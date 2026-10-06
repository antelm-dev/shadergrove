# Native Problems and Output Window — Phase 1

## Goal and milestone

Replace the failed contained-float experiment with a real Electron satellite for the existing Problems/Output surface. The smallest usable milestone is: **on desktop, Detach opens one independently resizable native window that shows the main workspace's live diagnostics and output log; Dock returns it to the main window; closing it hides the panel rather than losing state.** The web build keeps today's docked panel and does not show the desktop-only command.

This plan does not execute source changes. Give each worker this README and its numbered prompt, or point it to `codex/plan-native-bottom-panel` at this directory.

Source base: `8825716e62598d5655e7540542986e132f687fb6` (`develop`). Default branch: `master` (`origin/master` currently resolves from `2ff95981411655dc7c4c83e32d6cd28623b3ec91`). Integration branch: `codex/integrate-native-bottom-panel`. Remote PR actions require explicit authorization: `Review completed tasks and open or merge eligible PRs.`

## Shared contract

- Reuse `WELL_KNOWN_SURFACE_IDS.bottomPanel`, `SurfaceWindowManager`, and typed `window.surfaceOpen/surfaceReturn` IPC. Add only a short, safe app path such as `/bottom-panel`; it must pass `assertSafeSurfacePath`.
- The main renderer alone owns project edits, editor navigation, and persistence. The satellite is a view of the main renderer's session state, not a second editable `ShaderStore` session.
- A browser-safe `BroadcastChannel` service carries bounded snapshots of `OutputLog` entries and diagnostics and a narrowly typed `reveal-diagnostic` intent back to main. It must tolerate missing `BroadcastChannel`, close channels on destroy, and never persist session-only log entries.
- Native lifecycle: successfully opening externalizes the record only after `surfaceOpen` succeeds; duplicate opens focus the existing satellite; Dock calls `surfaceReturn`; OS close marks the main panel closed; `surface-returned` restores the contained docked record. Failed opens leave the contained panel untouched.
- Satellite mode must render only its dedicated bottom-panel shell and skip startup/routing/global actions intended for the main workspace. It needs an accessible Dock/Close control.

Acceptance criteria: **AC-1** one native bottom-panel window opens/focuses; **AC-2** main and satellite show the same current diagnostics/output entries and main additions arrive live; **AC-3** diagnostic activation focuses/reveals in the main editor; **AC-4** Dock restores main docked panel and OS close hides it; **AC-5** web behavior is unchanged; **AC-6** navigation and IPC remain typed and path-safe.

## Tasks and waves

| Wave | Task | Branch / worktree | Delivery | Base | Depends on |
| --- | --- | --- | --- | --- | --- |
| 1 | [01 Native lifecycle](01-native-lifecycle.md) | `codex/native-bottom-panel-01` / `../shader-studio-native-bottom-panel-01` | integration-only | latest-default at launch | none |
| 2 | [02 Satellite shell and session sync](02-satellite-shell-sync.md) | `codex/native-bottom-panel-02` / `../shader-studio-native-bottom-panel-02` | integration-only | integration-tip at launch | 01 accepted at integration tip |

The coordinator records each exact launch SHA after refreshing the stated base. Task 01 must be integrated before Task 02 starts; neither is a safe standalone default-branch PR because the public command and native route are incomplete without the other.

## Checks and review gate

Workers run their targeted checks and report commands/results, commits, risks, complete diff review, and clean status. Coordinator integrates in wave order, resolves cross-task conflicts only in the integration worktree, then runs:

- `pnpm exec nx test @shader-studio/web`
- `pnpm exec nx test @shader-studio/desktop`
- `pnpm exec nx run @shader-studio/web:typecheck`
- `pnpm check:ipc`

Critical manual/E2E scenarios: open from a visible panel; reopen to focus rather than duplicate; add compiler output and verify live satellite update; activate a satellite diagnostic; Dock; close via OS chrome; retry after failed open; confirm browser build has no detach command.

Workers must use clean sibling worktrees, preserve unrelated changes, make 1–3 logical commits, and not push/open PRs. Coordinator owns integration, broad tests, and any cleanup after review.

## Deferred backlog

- Cross-window selection/focus state beyond diagnostic reveal.
- Persisting satellite visibility across relaunch.
- Externalizing inspector, browser, or arbitrary editor groups.
- Multi-monitor placement UX beyond the existing remembered native bounds.

```yaml
review_contract:
  milestone: native-bottom-panel-phase-1
  planning_ref: codex/plan-native-bottom-panel
  source_base: 8825716e62598d5655e7540542986e132f687fb6
  default_branch: master
  integration_branch: codex/integrate-native-bottom-panel
  tasks:
    - id: "01"
      branch: codex/native-bottom-panel-01
      depends_on: []
      acceptance: [AC-1, AC-4, AC-5, AC-6]
      checks: ["pnpm exec nx test @shader-studio/desktop", "pnpm check:ipc"]
      delivery: integration-only
      base_policy: latest-default
    - id: "02"
      branch: codex/native-bottom-panel-02
      depends_on: ["01"]
      acceptance: [AC-2, AC-3, AC-4, AC-5]
      checks: ["pnpm exec nx test @shader-studio/web", "pnpm exec nx run @shader-studio/web:typecheck"]
      delivery: integration-only
      base_policy: integration-tip
  integration_checks: ["pnpm exec nx test @shader-studio/web", "pnpm exec nx test @shader-studio/desktop", "pnpm exec nx run @shader-studio/web:typecheck", "pnpm check:ipc"]
  e2e_scenarios: ["open or focus one native panel", "live log and diagnostics mirror", "satellite diagnostic reveals in main editor", "dock and OS-close lifecycle", "web remains dock-only"]
  deferred: ["cross-window focus state", "relaunch visibility", "other externalized tool panels"]
```
