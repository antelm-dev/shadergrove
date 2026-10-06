# Multi-editor windows: contained splits milestone

## Goal and milestone

Deliver the first usable multi-editor milestone in the web and desktop renderer: a user can split the source editor right or down, move a tab into the new group, resize the split, close/merge a group, switch shaders without losing the visible group slots, and reload with the contained split layout restored.

This milestone does not open native `BrowserWindow` editor satellites. It establishes the durable group/surface/layout contract that later externalization will reuse.

## Planning and launch context

- Planning ref: `codex/plan-multi-editor-windows`
- Plan path: `docs/feature-plans/multi-editor-windows/`
- Source base captured at planning start: `2cde60c02ff0817f3cc3ee19b224b9ad99e60b22`
- Default branch: `master`
- Remote: `origin` (`https://github.com/antelm-dev/shader-studio.git`)
- Integration branch: `codex/integrate-multi-editor-windows`

Give every worker this README and its task prompt directly, or provide a readable planning ref and both paths. At launch, the coordinator records the exact immutable base SHA in the prompt placeholder. `latest-default` means fetch/refresh `master` and use its exact current commit; `integration-tip` means use the exact accepted integration commit containing all prerequisites.

## Shared contracts

- Tabs belong to shader-scoped `EditorGroupId`s; each visible group slot has one editor `SurfaceRecord`, identified by `editorSurfaceId(groupId)`.
- The contained split tree references editor surface IDs. A leaf is one surface; a split has a stable ID, axis, clamped ratio, and two children. Every open contained editor surface appears exactly once.
- Layout sanitization repairs malformed, duplicate, stale, or empty trees to one default editor leaf. Existing version-1 preferences migrate without visible change.
- On shader change, `EditorGroups` reconciles all visible group IDs and seeds missing groups with a valid document. Document ownership remains unique within a shader.
- Each `EditorShell`, `EditorPanel`, tabs strip, window controls, active document, Monaco view state, commands, focus, and diagnostics resolve through its explicit group/surface identity. The existing single default group remains behaviorally unchanged.
- Splitting moves the active document to the new group; it does not duplicate ownership. Closing the final group is rejected. Closing another group moves its documents to the deterministic adjacent leaf before removing the group and surface.
- Split ratios persist only on committed resize, are keyboard-adjustable, and are clamped so both children remain usable.

## Acceptance criteria

- **AC-LAYOUT:** A versioned, sanitizable split-tree contract round-trips and migrates existing single-editor preferences to one default leaf.
- **AC-IDENTITY:** Two editor component instances show and activate documents from their own explicit group IDs; the legacy single-editor path is unchanged.
- **AC-SPLIT:** “Split right” and “Split down” create a visible sibling group and move the active tab into it.
- **AC-RESIZE:** Pointer and keyboard resizing update the ratio with minimum-size clamping and persist only the committed value.
- **AC-CLOSE:** Closing a non-final group merges its tabs into an adjacent group without losing draft text or active-document determinism; the last group cannot close.
- **AC-RESTORE:** Reload and shader switching preserve the split geometry and render valid group contents without duplicate document ownership.
- **AC-RESPONSIVE:** Below the existing compact breakpoint, multiple contained groups collapse to a safe single-column presentation without overflow or unreachable controls.

## Tasks and waves

| Task | Outcome | Depends on | Branch | Delivery | Base policy |
| --- | --- | --- | --- | --- | --- |
| 01 | Persisted split-tree domain contract and migration | — | `codex/multi-editor-windows-01` | `default-branch-pr` | `latest-default` |
| 02 | Group-aware editor shell/panel instances with default-compatible behavior | — | `codex/multi-editor-windows-02` | `default-branch-pr` | `latest-default` |
| 03 | Contained split host, commands, resizing, reconciliation, and UI integration | 01, 02 | `codex/multi-editor-windows-03` | `integration-only` | `integration-tip` |

Wave 1 runs Tasks 01 and 02 independently. Each can merge to `master` only after focused review proves it is backward compatible and exposes no unfinished behavior. Wave 2 starts after both accepted commits are reachable from the integration branch; Task 03 launches from that exact integration tip.

## Verification and integration gate

Workers run the targeted checks in their prompts. The coordinator then runs:

```text
pnpm --filter @shader-studio/shared test
pnpm --filter @shader-studio/web test
pnpm check
pnpm typecheck
pnpm lint
pnpm format:check
```

Critical browser scenarios, following `.claude/skills/verify/SKILL.md`:

1. Open the editor, split right, move the active tab, edit both groups, resize, reload, and confirm content plus ratio restoration.
2. Split down, switch shaders twice, and confirm both group slots stay valid with no document duplicated between groups.
3. Close one of two groups with dirty documents and confirm tabs merge to the adjacent group with edits intact; confirm the final group cannot close.
4. At widths above and below 900px, verify Monaco relayout, keyboard splitter resizing, focus/ARIA behavior, and no overlap with inspector or bottom panel.

The integration owner resolves conflicts in `surface-layout.ts`, `app.*`, shared layout types, and preference migration. Review authorization remains explicit: `Review completed tasks and open or merge eligible PRs`.

## Worktrees and completion evidence

Use unique sibling paths such as `../shader-studio-multi-editor-01`. Each worker starts clean, preserves unrelated changes, makes 1–3 logical commits, reviews the complete diff, and reports exact base/HEAD SHAs, commits, checks, acceptance evidence, and remaining risks. Retain worker worktrees until review accepts their commits; clean them only after the coordinator confirms reachability from the intended destination.

## Deferred backlog

- Externalize/re-attach an editor group as an Electron `BrowserWindow`.
- Cross-renderer session-broker ownership and crash/reconnect recovery.
- Drag tabs directly between groups or out of the window to create a satellite.
- More than two nested splits, split reordering, saved named layouts, and collaborative editing.

```yaml
review_contract:
  milestone: multi-editor-windows-contained-splits
  planning_ref: codex/plan-multi-editor-windows
  source_base: "2cde60c02ff0817f3cc3ee19b224b9ad99e60b22"
  default_branch: master
  integration_branch: codex/integrate-multi-editor-windows
  tasks:
    - id: "01"
      branch: codex/multi-editor-windows-01
      depends_on: []
      acceptance: [AC-LAYOUT]
      checks:
        - "pnpm --filter @shader-studio/shared test"
        - "pnpm --filter @shader-studio/shared typecheck"
      delivery: default-branch-pr
      base_policy: latest-default
    - id: "02"
      branch: codex/multi-editor-windows-02
      depends_on: []
      acceptance: [AC-IDENTITY]
      checks:
        - "pnpm --filter @shader-studio/web test"
        - "pnpm --filter @shader-studio/web typecheck"
      delivery: default-branch-pr
      base_policy: latest-default
    - id: "03"
      branch: codex/multi-editor-windows-03
      depends_on: ["01", "02"]
      acceptance: [AC-SPLIT, AC-RESIZE, AC-CLOSE, AC-RESTORE, AC-RESPONSIVE]
      checks:
        - "pnpm --filter @shader-studio/web test"
        - "pnpm check:i18n"
        - "pnpm --filter @shader-studio/web typecheck"
      delivery: integration-only
      base_policy: integration-tip
  integration_checks:
    - "pnpm --filter @shader-studio/shared test"
    - "pnpm --filter @shader-studio/web test"
    - "pnpm check"
    - "pnpm typecheck"
    - "pnpm lint"
    - "pnpm format:check"
  e2e_scenarios:
    - "split right, edit both groups, resize, and reload"
    - "split down and switch shaders without duplicate ownership"
    - "merge a dirty group and reject closing the final group"
    - "verify responsive and keyboard behavior around 900px"
  deferred:
    - native editor BrowserWindow externalization and return
    - cross-renderer session broker and recovery
    - tab drag-out and arbitrary nested split management
```
