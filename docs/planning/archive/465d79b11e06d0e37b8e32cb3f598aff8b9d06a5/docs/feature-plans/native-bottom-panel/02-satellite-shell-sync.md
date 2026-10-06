# 02 — Satellite shell and session sync

Read the coordinator README before starting.

## Mission

Make `/bottom-panel` a focused native Problems/Output window that mirrors live main-session diagnostics and logs, sends diagnostic navigation back to main, and exposes Dock/Close controls.

## Launch and isolation

Start only after Task 01 is accepted at the integration tip. The coordinator supplies the exact `integration-tip` SHA. Create a clean worktree:

```text
git worktree add <sibling>/shader-studio-native-bottom-panel-02 -b codex/native-bottom-panel-02 <exact-launch-base>
```

This is `integration-only`; make 1–3 logical commits, do not push/open a PR.

## Owned scope

Primary paths: `apps/web/src/app/app.ts`, `apps/web/src/app/output-mode.ts` (or a successor mode helper), `apps/web/src/app/ui/bottom-panel/*`, and one narrowly scoped workspace session-sync service with its tests. Coordinate before editing unrelated startup or rendering code.

## Required work

1. Detect `/bottom-panel` safely and render a dedicated full-window shell rather than the normal workspace. It must not initialize the main window's routing, global shortcuts, or editing workflow.
2. Add a browser-safe, bounded synchronization service over a named `BroadcastChannel`. Main publishes initial and incremental diagnostics/output snapshots; the satellite requests/resynchronizes on start. No session output is written to preferences, and lack of channel support fails gracefully.
3. Reuse existing presentational Problems and Output components where practical. Satellite tab selection is local or safely synchronized; output clearing and diagnostic activation must communicate intent to main rather than mutate an isolated store.
4. On a satellite diagnostic activation, ask main to open/focus the editor and reveal the line through existing `EditorNavigation`/surface paths. Add visible, accessible Dock and Close actions: Dock calls `surfaceReturn`; Close invokes the satellite surface-close IPC.
5. Test mode detection, sync protocol cleanup/recovery, rendering only the satellite shell, live update behavior, and main-side navigation intent.

## Out of scope

Do not add generic arbitrary-surface synchronization, persist satellite visibility, or change the live preview `/output` transport unless a minimal shared helper is genuinely necessary and preserves its behavior.

## Verification and delivery

Run `pnpm exec nx test @shader-studio/web`, `pnpm exec nx run @shader-studio/web:typecheck`, and targeted desktop IPC tests if touched. Review the complete diff, then report commits, test evidence, risks, and clean status to the coordinator for integration.
