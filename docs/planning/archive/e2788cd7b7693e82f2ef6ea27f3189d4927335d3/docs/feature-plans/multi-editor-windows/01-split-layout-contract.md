# Task 01 — persisted split-layout contract

## Mission

Add the framework-free, versioned contained-editor split-tree contract, sanitization, migration, and pure mutations. Preserve the exact current single-editor layout when old preferences are loaded. Read the coordinator `README.md` before starting.

## Launch base and isolation

- Base policy: `latest-default`; prerequisite: none.
- Coordinator replaces `<exact-launch-base>` with the immutable refreshed `master` SHA.
- Branch: `codex/multi-editor-windows-01`.
- Sibling worktree: `<repo-parent>/shader-studio-multi-editor-01`.

```text
git worktree add <absolute-sibling-path> -b codex/multi-editor-windows-01 <exact-launch-base>
cd <absolute-sibling-path>
git status --short --branch
```

The initial status must be clean.

## Context and owned scope

Primary ownership is `libs/shared/src/surfaces/types.ts`, `sanitize.ts`, `migration.ts`, their focused specs, and a narrowly named pure helper module if needed. Existing `SurfaceRecord.chrome.editorGroupId`, `editorSurfaceId`, `LAYOUT_VERSION`, and preferences migration are the compatibility boundary.

## Required work

- Define serializable leaf/split nodes. Splits need stable IDs, horizontal/vertical axis, a finite clamped ratio, and exactly two children; leaves reference editor surface IDs.
- Include the root in `LayoutPreferences`, bump the version, and migrate version 1 or legacy preferences to the default editor leaf without altering other surfaces or z-order.
- Sanitize malformed nodes, unknown or duplicate editor surfaces, invalid ratios, missing children, and stale references deterministically. Guarantee one default leaf and exactly one tree occurrence per open contained editor surface.
- Add pure mutations needed by UI integration: split a leaf, commit a ratio, find an adjacent merge target, and remove/replace a leaf. Return explicit failure results rather than throwing for user-state errors.
- Cover round-trip, idempotence, corruption recovery, version-1 migration, duplicate repair, ratio clamping, and deterministic adjacent-leaf selection.

## Out of scope and contracts

Do not touch Angular, Electron, preferences UI, editor-group tab state, or render a second editor. Do not add native placement to the split tree. The default generated layout must remain visually and semantically identical, making this safe to deploy alone. Coordinate any contract deviation before coding.

## Verification and delivery

Acceptance: `AC-LAYOUT`.

```text
pnpm --filter @shader-studio/shared test
pnpm --filter @shader-studio/shared typecheck
pnpm format:check
```

Review the complete diff. Make 1–3 logical commits. Intended destination is a default-branch PR, but do not push or open it without explicit authorization. Report exact base/HEAD SHAs, commits, changed paths, checks, migration examples, and risks.
