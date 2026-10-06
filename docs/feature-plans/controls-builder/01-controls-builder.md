# Task 01 — Complete the Config Builder

## Mission and launch

Implement the usable Controls Builder milestone specified in the supplied coordinator README. Read it before coding; it contains shared contracts, acceptance IDs, exact checks, and deferred scope. No hidden chat context is needed.

- Delivery: `default-branch-pr`, intended destination `origin/master`, no feature flag.
- Base policy: `latest-default`; exact launch base: `<coordinator-recorded-full-SHA>`.
- Prerequisites: none; refresh `origin/master`, verify integration points, and record its immutable SHA before launch. Do not branch from the planning commit or the unrelated shader-tooling worker.
- Branch: `codex/controls-builder-01`.
- Worktree: `E:/Adel/Documents/Orgs/shader-studio-controls-builder-01`.

```text
git worktree add E:/Adel/Documents/Orgs/shader-studio-controls-builder-01 -b codex/controls-builder-01 <exact-launch-base>
cd E:/Adel/Documents/Orgs/shader-studio-controls-builder-01
git status --short --branch
```

Require a clean initial checkout; preserve unrelated files and follow applicable repository instructions.

## Ownership and context

Own the narrow Config-authoring boundary, normally these five primary files:

1. New `apps/studio/src/app/ui/editor/controls-builder.ts`.
2. New `apps/studio/src/app/ui/editor/controls-builder-state.ts` for bounded form/selection transactions and transformations, if needed.
3. `apps/studio/src/app/ui/editor/editor-panel.ts` for view selection and document integration.
4. `apps/studio/src/app/editor/code-editor.ts` for the minimal undoable programmatic edit entry point, if needed.
5. `apps/studio/src/app/ui/inspector/gui-panel.ts` for Edit controls entry/empty state.

Allowed supporting scope: adjacent unit specs, existing `workspace/state/workspace-state.spec.ts`, new `apps/studio-e2e/src/controls-builder.spec.ts`, `libs/shared/src/i18n/keys.ts`, `i18n/en.json`, `i18n/fr.json`, and relevant outputs of `pnpm gen:plugins`. Inspect all generated diffs. No edits to shared control schema, engine, backend, exports, or persistence. Reuse current `validateControls`, `controlsToText`, `parseControls`, `ShaderStore`, `CONFIG_DOC`, editor navigation, and surface layout.

## Required work

- Put Builder / JSON in Config; preserve Monaco models while switching. Default to Builder for valid newly selected shaders. Source diagnostics open JSON. Wire a labeled inspector shortcut that restores the existing editor.
- Grouped list plus responsive selected-control form for all four existing types. Support create/edit, fresh-key duplication, confirmed deletion, folder changes, and keyboard move-up/down within a group.
- Existing keys stay read-only in Builder; show the uniform name/type. Existing type changes explain possible GLSL declaration changes; never rewrite source or presets.
- Apply a fully validated proposal through the current document mutation once. Preserve no-op behavior and compatible live params. Preview changes current values, never schema defaults.
- Keep invalid JSON untouched, even though the store exposes a fallback schema. Reject invalid definitions with useful field feedback and enforce existing limits. Preserve numeric select values and reject duplicate option labels before converting rows into a map.
- Protect local pending edits and reject stale transactions after external JSON/MCP edits or shader replacement. Preserve ordinary view-toggle undo/history; make Builder edits undoable when the current Config model exists, without cross-shader history leakage.
- Use existing Material/theme/translation conventions; keyboard actions and English/French layouts must work at a 340px dock.

## Verification and delivery

Meet AC-CREATE, AC-MANAGE, AC-VIEWS, AC-VALIDATE, AC-VALUES, AC-LIFECYCLE, AC-ENTRY, and AC-ACCESS. Run the README's targeted unit, web typecheck, generation/i18n/plugin, and Controls Builder E2E commands. Capture narrow/wide screenshots. Report environment blockers accurately; do not claim unrun native desktop checks.

Review the complete diff and deliver 1–3 logical commits with exact launch/commit SHAs, changed paths, acceptance evidence, command results, and remaining risks. No source refactors outside this boundary, GLSL discovery, custom-effect reuse, drag-and-drop, or new storage contracts. Do not push, open, or merge a PR without later user authorization. Keep the worktree for review.
