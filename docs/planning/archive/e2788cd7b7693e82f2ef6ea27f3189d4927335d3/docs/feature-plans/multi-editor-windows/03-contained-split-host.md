# Task 03 — contained split host and end-to-end behavior

## Mission

Integrate the accepted split-layout contract and group-aware editor components into a usable contained split-editor experience: split right/down, resize, close/merge, shader-switch reconciliation, persistence, and responsive behavior. Read the coordinator `README.md` before starting.

## Launch base and isolation

- Base policy: `integration-tip`.
- Prerequisite: Tasks 01 and 02 have passed review and their accepted commits are both reachable from the integration branch.
- Coordinator replaces `<exact-launch-base>` with that immutable integration-tip SHA.
- Branch: `codex/multi-editor-windows-03`.
- Sibling worktree: `<repo-parent>/shader-studio-multi-editor-03`.

```text
git worktree add <absolute-sibling-path> -b codex/multi-editor-windows-03 <exact-launch-base>
cd <absolute-sibling-path>
git status --short --branch
```

The initial status must be clean.

## Context and owned scope

Primary ownership is a new narrow editor split-host component and spec, `apps/web/src/app/surfaces/surface-layout.ts`, `ui/editor/editor-groups.ts`, `app.ts/html/scss`, and required English/French i18n keys. Reuse existing resize gesture conventions and the group/surface identities from Tasks 01–02.

## Required work

- Recursively render the persisted contained split tree, passing each leaf’s surface/group IDs to one `EditorShell`. Keep floating/maximized editor surfaces in the existing surface stack and ensure Monaco relayout after geometry changes.
- Add accessible “Split right” and “Split down” commands. Create the surface and shader group transactionally, move the active document, focus the new group, and roll back cleanly if any step fails.
- Implement pointer and keyboard splitters with minimum-size clamping. Preview ratios during motion; persist only on commit.
- Reconcile visible group IDs when selecting a shader: create missing slots with valid fallback documents, prune stale documents, retain unique ownership, and keep one deterministic active group.
- Closing a non-final leaf merges all tabs into the deterministic adjacent group, preserving dirty source and applicable view state, then removes the group/surface/tree leaf. Reject closing the final group.
- Restore split geometry on reload. Below the compact breakpoint, use a safe single-column presentation while retaining the durable ratio/tree.
- Add focused unit/component tests for creation rollback, reconciliation, resize commit, merge ordering, last-group guard, restored layout, and compact rendering.

## Out of scope and contracts

Do not implement native `BrowserWindow` externalization, cross-renderer broker wiring, tab drag-out, arbitrary split reordering, or collaborative editing. Keep all existing inspector, preview, bottom-panel, and single-editor behavior working.

## Verification and delivery

Acceptance: `AC-SPLIT`, `AC-RESIZE`, `AC-CLOSE`, `AC-RESTORE`, `AC-RESPONSIVE`.

```text
pnpm --filter @shader-studio/web test
pnpm check:i18n
pnpm --filter @shader-studio/web typecheck
pnpm format:check
```

Drive all four E2E scenarios from the README using `.claude/skills/verify/SKILL.md`, and include screenshots or exact observations. Review the complete diff. Make 1–3 logical commits. Deliver to the integration branch only; do not push or open a PR without explicit authorization. Report exact base/HEAD SHAs, commits, checks, E2E evidence, and remaining risks.
