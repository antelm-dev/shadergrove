# Task 02: History timeline and guarded restore

## Mission

Expose the accepted history API as a usable, localized History dialog with inline checkpoints and a draft-safe restore flow on both web and desktop.

Read the supplied coordinator README first. Consume the merged Task 01 contract without redesigning it.

## Launch base and isolation

- Base policy: `latest-default`
- Exact base: `<exact-launch-base>` — resolve only after Task 01 is merged and reachable from refreshed `master`.
- Prerequisite: Task 01 PR merged; an open PR is not sufficient.
- Branch: `codex/shader-history-02`
- Sibling worktree: `E:\Adel\Documents\Orgs\shader-studio-wt-shader-history-02`

```text
git worktree add E:\Adel\Documents\Orgs\shader-studio-wt-shader-history-02 -b codex/shader-history-02 <exact-launch-base>
cd E:\Adel\Documents\Orgs\shader-studio-wt-shader-history-02
git status --short --branch
```

Start only from a clean worker worktree.

## Context and owned boundary

Primary boundary:

- HTTP/desktop clients in `apps/web/src/app/api/shader-api.ts` and `apps/web/src/app/desktop/desktop-shader-api.ts`
- Persistence/store adoption in `apps/web/src/app/workspace/persistence.service.ts` and `shader-store.ts`
- New focused dialog and tests under `apps/web/src/app/ui/dialogs/`
- Orchestration/entry point in `apps/web/src/app/ui/workspace-actions.ts` and `ui/editor/editor-panel.ts`
- Translation keys plus `i18n/en.json` and `i18n/fr.json`

Reuse `WorkspaceActions.guardedTransition`, lazy dialog imports, store notices/reporting, Angular Material patterns, and existing API fakes/test harnesses.

## Required work

1. Implement typed list/checkpoint/restore methods in both `ShaderApi` transports.
2. Add a lazy-loaded History dialog reachable from the editor context menu. Load newest-first entries for the open shader and show loading, empty, retryable error, and populated states.
3. Each row shows revision, relative/absolute time accessibly, checkpoint name, cause, and restore provenance when present. Copy must explicitly describe coverage as source, settings, and presets; do not imply textures or previews are historical.
4. Support setting, editing, and clearing a checkpoint name inline with validation, disabled in-flight controls, error feedback, and refreshed history without closing the dialog.
5. Restore only through the existing dirty-draft guard. Cancel preserves the draft and history. A confirmed restore sends the current record revision as `expectedRevision`, adopts the returned record as the clean saved state, preserves appropriate live/store invariants, removes matching draft recovery, refreshes summaries/history, and reports a stale conflict without overwriting the draft.
6. Prevent duplicate checkpoint/restore submissions. If selection changes or the dialog’s shader is deleted, close or invalidate safely rather than applying an action to the new shader.
7. Add focused tests covering AC-HIST-06 through AC-HIST-08 in HTTP/desktop adapter, dialog, action, and store boundaries as appropriate. Keep snapshots brittle-free and include English/French catalog completeness.

## Out of scope

Diff viewers, revision thumbnails, duplicate-from-revision, texture history, compile status, retention settings, new keyboard shortcuts, and unrelated editor/store refactors.

## Contracts and verification

History opening is read-only and allowed with a dirty draft; only restore enters `guardedTransition`. Checkpoint edits do not change the current record revision. The returned restore record is authoritative. Do not add a second unsaved-changes implementation.

Run:

```text
pnpm --filter @shader-studio/web test
pnpm --filter @shader-studio/web typecheck
pnpm check:i18n
pnpm build
pnpm build:desktop
git diff --check
```

Manually exercise dirty cancel, clean restore, stale conflict, checkpoint edit/clear, empty history, and both transports where available.

## Delivery and commit discipline

Intended destination: independent `default-branch-pr` to `master` after Task 01 has landed; no feature flag because this completes the Phase 1 user flow. Do not push or open a PR without later authorization. Make 1–3 logical commits. Review the complete diff and report commit SHAs, exact checks/results, changed files, UI/accessibility evidence, and remaining risks.
