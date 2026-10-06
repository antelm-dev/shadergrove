# 01 — Native bottom-panel lifecycle

Read the coordinator README before starting.

## Mission

Create the secure, typed desktop lifecycle for one native `bottom-panel` satellite and connect the main docked panel's Detach action to it, without implementing the satellite's session mirror.

## Launch and isolation

Launch from the coordinator-recorded `latest-default` SHA (initial placeholder: `8825716e62598d5655e7540542986e132f687fb6`). Create a clean worktree:

```text
git worktree add <sibling>/shader-studio-native-bottom-panel-01 -b codex/native-bottom-panel-01 <exact-launch-base>
```

This is `integration-only`; do not push or open a PR. Make 1–3 logical commits.

## Owned scope

Primary paths: `apps/web/src/app/ui/bottom-panel/bottom-panel.ts`, `apps/web/src/app/desktop/desktop-platform.ts`, `apps/web/src/app/surfaces/surface-layout.ts`, plus the smallest necessary desktop/window tests or typed contract regeneration inputs. Coordinate before expanding beyond five primary files.

## Required work

1. Use `WELL_KNOWN_SURFACE_IDS.bottomPanel` and the existing generic IPC; request a safe `/bottom-panel` satellite path with `kind: 'bottom-panel'` and bounds derived from the docked panel only when useful.
2. Make externalization transactional: call typed native open first; commit the layout's native placement only on `ok`/`focused`; retain the contained panel on rejection. Repeated Detach focuses the same window.
3. Subscribe to typed `surface-changed` and `surface-returned` notifications so OS close hides the main panel and Dock restores its bottom-docked contained placement. Do not hand-edit generated IPC bridge output; regenerate it if contracts change.
4. Render the Detach command only in Electron, retain standard web panel controls, and ensure the main DOM does not render a duplicate panel while native placement owns it.
5. Cover path safety, singleton/focus behavior, failed opens, close, and return transitions with existing desktop/shared/web test conventions.

## Out of scope

The `/bottom-panel` renderer shell, log/diagnostic mirroring, and diagnostic reveal are Task 02. Do not alter output-preview semantics or generalize other tool surfaces.

## Verification and delivery

Run `pnpm exec nx test @shader-studio/desktop`, targeted affected web/shared tests, and `pnpm check:ipc` if IPC sources change. Review the entire diff and report exact commits, test evidence, risks, and clean status to the coordinator.
