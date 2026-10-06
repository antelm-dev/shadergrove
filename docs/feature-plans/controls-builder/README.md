# Controls Builder — Phase 1

## Goal and milestone

Let shader authors create and manage controls visually in the existing Config document. Deliver a complete Builder / JSON workflow for the four existing types, using the current portable config format, live inspector, save, and recovery paths. This is one vertical worker task in one wave; no API or schema migration is needed.

The agreed direction is a grouped control list and selected-control form in the Config tab, with an inspector shortcut. Keep the inspector focused on live values. The conversation mockup is illustrative, not an implementation dependency; this document defines the executable behavior.

## Repository and launch

- Source checkout: `E:/Adel/Documents/Orgs/shader-studio`, branch `develop`.
- Source base: `f4ad6d85e172d9e218bad78da65a872e29ef95a6`.
- Remote: `origin`, `https://github.com/antelm-dev/shadergrove.git`.
- Default branch: `master`, verified through remote HEAD on 2026-10-06. At planning time source HEAD and `origin/master` coincide.
- Planning ref: `codex/plan-controls-builder`; plan directory: `docs/feature-plans/controls-builder/`.
- Integration branch, if a review checkout is needed: `codex/integrate-controls-builder`.

Supply this README and `01-controls-builder.md` directly to the worker, or provide the readable planning ref and exact paths. The worker starts from source code, so do not assume these documents exist in its checkout. Before launch, fetch `origin/master`, resolve its full SHA, record that immutable launch base in the execution report, and verify these integration points still apply.

## Current integration points

- `libs/shared/src/model/controls.ts`: `ShaderControl` covers number, boolean, color, and numeric select; `UNIFORM_PREFIX` is `u_`.
- `libs/shared/src/validate/controls.ts` and `limits.ts`: authoritative validation and limits, including unique/reserved keys, finite ranges, defaults, colors, and select options. Reuse them; do not copy validation rules from the mockup.
- `apps/studio/src/app/workspace/state/document-state.ts`: draft `controlsText`, computed schema validity, live params, selected record, and dirty state. Invalid JSON exposes a fallback schema, so `store.controls()` alone is not evidence of a valid buffer.
- `apps/studio/src/app/workspace/state/project-mutations.ts`: `setControlsText` updates the config, re-projects params through `sanitizeParams`, and manages diagnostics. Call through `ShaderStore.setDocSource(CONFIG_DOC, text)`.
- `apps/studio/src/app/workspace/controls-text.ts` and `state/controls-schema.ts`: serialization, parsing, and config errors.
- `apps/studio/src/app/ui/editor/editor-panel.ts`: mounts `CodeEditor`, owns navigation, tabs, and toolbar. `apps/studio/src/app/editor/code-editor.ts` owns Monaco models; external `setValue` currently resets undo history.
- `apps/studio/src/app/ui/inspector/gui-panel.ts`: existing lil-gui controls and empty state. `EditorNavigation.reveal(CONFIG_DOC, 0)` and `SurfaceLayoutService.openEditor()` can provide a minimal shortcut; positive source-line navigation must show JSON.

## Shared behavior contract

1. **One document.** Builder validates and serializes the complete proposed `ShaderControl[]`, then commits via the existing config mutation. No second persisted schema or builder-specific backend state. A no-op must not create a new revision.
2. **Views.** Valid Config opens in Builder by default for a newly selected shader. JSON stays editable in Monaco. Changing view preserves raw text, diagnostics, normal JSON undo history, and cursor/scroll. Keep the existing editor component/models alive. For a Builder commit, use a bounded undoable edit into the current Config model when available, then the existing mutation path exactly once; do not change external synchronization for unrelated documents or retain edits across shader identities. If Monaco is not ready, commit safely through the store and initialize it from the resulting text.
3. **Authoring.** Add number, boolean, color, or select controls; edit labels, group, defaults, and type-specific settings; duplicate, delete, and reorder. New controls choose an available non-reserved key. Existing keys are read-only in Builder; deliberate key renaming remains available in JSON. Display `u_<key>` and its GLSL type. No automatic GLSL or preset rewriting. Changing an existing type requires an explicit notice that GLSL declarations may need updating.
4. **Groups and order.** `folder` remains optional text, not a new group entity. Show groups in first-occurrence order and controls in array order within each group; empty folders use a visible Parameters label. Reorder within a group with keyboard-accessible move-up/down actions; changing group is the form's folder field. Duplicates get fresh keys and independent option maps. Deletion confirms that the control will be removed and does not edit GLSL or stored presets.
5. **Values.** Form inputs edit definitions; Apply writes the schema and marks the shader dirty. An applied control's preview changes `store.setParam`, not its default or `controlsText`. Schema application preserves compatible live values through existing sanitation; new keys initialize from defaults, removed keys disappear, range changes clamp. Save/reset/presets retain existing semantics.
6. **Invalid or stale data.** Never serialize the fallback schema over invalid JSON. Show a repair action to JSON and disable structural commits until the actual buffer validates. Invalid form entries stay local with field-level feedback. Capture selected shader identity and source `controlsText` for a form transaction; refuse Apply if either changed, reload from current valid data, and explain the conflict. Unapplied forms are visibly marked; local control/view switches offer Apply, Discard, or Cancel. External shader/config replacement clears stale form state without writing it into the new document.
7. **Entry and layout.** Add a labeled Edit controls action in `GuiPanel`, available with a selected record even when there are zero controls; open/restore the editor and show Config Builder, or JSON repair when invalid. Do not modify lil-gui internals or add per-control context menus. Reflow the form/list at narrow editor widths; reuse Material components, theme tokens, and English/French translation infrastructure.

## Acceptance criteria

| ID           | Observable result                                                                                                                                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-CREATE    | Starting from `[]`, create and edit all four control types with valid defaults; matching inspector widgets appear without saving or reloading.                                                                                      |
| AC-MANAGE    | Duplicate safely, delete with confirmation, edit groups, and move controls up/down within a group; JSON and inspector ordering agree, including ungrouped controls.                                                                 |
| AC-VIEWS     | Builder and JSON edit the same buffer; view toggles preserve history/state; undo a Builder edit in an existing Config model and observe the inspector update. Config source navigation opens JSON.                                  |
| AC-VALIDATE  | Duplicate/reserved keys, range/default/step errors, invalid colors, invalid or duplicate select-option labels, and existing limits are rejected before commits. Empty `[]` remains valid. Invalid JSON is preserved and repairable. |
| AC-VALUES    | Current value differs from default without a config edit; Apply preserves compatible values and initializes/clamps/removes as defined. Save/reload persists the schema; reset uses defaults.                                        |
| AC-LIFECYCLE | Local pending edits are guarded; JSON/MCP edits or shader replacement cannot be overwritten by a stale form. No double revision or cross-shader undo leak.                                                                          |
| AC-ENTRY     | Inspector action works when editor is closed, minimized, or already showing another document, including an empty schema. No extra editor group appears.                                                                             |
| AC-ACCESS    | Keyboard entry, selection, move actions, validation, and mode switch work at a 340px dock and wider floating editor in English/French; no clipped actions or inaccessible hover-only controls.                                      |

## Task and wave

| Task | Outcome                                     | Dependencies | Worker branch / sibling worktree                                                         | Delivery / base                                   |
| ---- | ------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 01   | Complete Config Builder and inspector entry | None         | `codex/controls-builder-01` / `E:/Adel/Documents/Orgs/shader-studio-controls-builder-01` | `default-branch-pr` to `master`; `latest-default` |

**Wave 1:** launch task 01 at its recorded immutable default-branch SHA. It is independently deployable: all exposed behavior is included, storage is unchanged, and JSON remains usable. No feature flag. Reverting the UI commits restores the previous workflow without migrating data. Coordinator acceptance requires the complete diff, mapped acceptance evidence, checks below, and no implementation from deferred scope. There is no dependency on the other existing shader-tooling worktree.

## Verification and review gate

Worker checks, from repository root:

- `pnpm gen:ipc`, then `pnpm --filter @shadergrove/studio exec ng test --watch=false --include=src/app/ui/editor/controls-builder*.spec.ts --include=src/app/ui/editor/editor-panel.spec.ts --include=src/app/editor/code-editor.spec.ts --include=src/app/workspace/state/workspace-state.spec.ts --include=src/app/ui/inspector/gui-panel.spec.ts`.
- `pnpm --filter @shadergrove/studio typecheck:web`.
- `pnpm gen:plugins`, `pnpm check:i18n`, `pnpm check:plugins`; inspect and include only relevant generated translation/plugin artifacts.
- `pnpm --filter @shadergrove/studio-e2e e2e src/controls-builder.spec.ts --project=chromium` (isolated server/database and signed-in fixtures configured in this project).

Coordinator aggregate checks after accepting the worker: `pnpm lint`, `pnpm format:check`, `pnpm check`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm --filter @shadergrove/studio build:renderer`. Also run `pnpm --filter @shadergrove/studio-e2e e2e src/controls-builder.spec.ts src/editor-chrome.spec.ts src/shader-switch.spec.ts --project=chromium`. Inspect shared web/desktop renderer behavior; report desktop native window interactions as manually unverified unless actually exercised. Distinguish environment blockers, pre-existing failures, and skipped/pending checks from passes.

Critical E2E scenarios:

- Empty schema → inspector shortcut → create one of each type → try live values → save/reload → verify JSON, defaults, and widgets.
- Existing numeric control → change label/range/default → preserve or clamp current value → duplicate/regroup/reorder/delete → inspect JSON and persisted result.
- JSON edit → Builder → undo/redo; invalid JSON → blocked Builder writes → repair → Config diagnostic navigation opens JSON.
- Pending form + external config change or shader switch → stale Apply cannot write; verify no data/history leaks across shaders.
- Closed/minimized/floating editor and 340px dock → shortcut, keyboard actions, and English/French labels remain usable.

Use existing regression suites rather than a separate test worker. Add focused tests for state transitions and actual UI behaviors, not tests that mirror form implementation.

Worker delivery: 1–3 logical commits, exact launch SHA and commit SHAs, changed paths, full-diff review, acceptance results, commands and outcomes, screenshots of narrow/wide states, and residual risks. The coordinator owns any integration conflicts and broad verification; retain worker/review worktrees until evidence is captured and explicitly authorized cleanup runs.

Planning does not authorize pushing, opening, or merging PRs. Intended destination is `origin/master`. A later user instruction such as “Review completed tasks and open eligible PRs” authorizes publication; merging needs explicit authorization. If the user selects `develop` as delivery target, record the revised target/base policy before launch rather than silently changing this contract.

## Deferred backlog

- Create controls from GLSL declarations, detect unused uniforms, or rewrite source/presets on renames.
- Per-control inspector context menus and inline schema editing inside lil-gui.
- Drag-and-drop group management, nested groups, new control types, annotations, or inferred ranges.
- Reuse this Builder for custom post-processing effects; libraries, templates, shared schema refactors.
- A workspace-wide undo service or a new persistence/API contract.

```yaml
review_contract:
  milestone: controls-builder-phase-1
  planning_ref: codex/plan-controls-builder
  source_base: 'f4ad6d85e172d9e218bad78da65a872e29ef95a6'
  default_branch: master
  integration_branch: codex/integrate-controls-builder
  tasks:
    - id: '01'
      branch: codex/controls-builder-01
      depends_on: []
      acceptance:
        [AC-CREATE, AC-MANAGE, AC-VIEWS, AC-VALIDATE, AC-VALUES, AC-LIFECYCLE, AC-ENTRY, AC-ACCESS]
      checks:
        - 'pnpm gen:ipc'
        - 'pnpm --filter @shadergrove/studio exec ng test --watch=false --include=src/app/ui/editor/controls-builder*.spec.ts --include=src/app/ui/editor/editor-panel.spec.ts --include=src/app/editor/code-editor.spec.ts --include=src/app/workspace/state/workspace-state.spec.ts --include=src/app/ui/inspector/gui-panel.spec.ts'
        - 'pnpm --filter @shadergrove/studio typecheck:web'
        - 'pnpm gen:plugins'
        - 'pnpm check:i18n'
        - 'pnpm check:plugins'
        - 'pnpm --filter @shadergrove/studio-e2e e2e src/controls-builder.spec.ts --project=chromium'
      delivery: default-branch-pr
      base_policy: latest-default
  integration_checks:
    - 'pnpm lint'
    - 'pnpm format:check'
    - 'pnpm check'
    - 'pnpm typecheck'
    - 'pnpm test'
    - 'pnpm build'
    - 'pnpm --filter @shadergrove/studio build:renderer'
    - 'pnpm --filter @shadergrove/studio-e2e e2e src/controls-builder.spec.ts src/editor-chrome.spec.ts src/shader-switch.spec.ts --project=chromium'
  e2e_scenarios:
    - 'create all four types from empty config; preview values; save and reload'
    - 'edit range and default; duplicate, regroup, reorder, and delete'
    - 'JSON and Builder synchronization, undo, invalid JSON repair, and source navigation'
    - 'pending form plus external config replacement or shader switch cannot write stale data'
    - 'closed/minimized/floating editor and narrow keyboard-accessible English/French layout'
  deferred:
    - uniform-to-control-creation
    - automatic-source-or-preset-rewriting
    - per-control-inspector-context-menus
    - drag-and-drop-or-nested-groups
    - custom-effect-builder-reuse
    - workspace-wide-undo-service
```
