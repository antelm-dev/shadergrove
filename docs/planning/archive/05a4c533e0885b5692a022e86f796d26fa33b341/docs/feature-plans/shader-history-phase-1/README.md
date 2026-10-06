# Shader History — Phase 1

## Goal and milestone

Give shader authors a trustworthy first recovery loop: saved document states become immutable history entries, important entries can be named, and an older entry can be restored without deleting the newer timeline.

Phase 1 versions the logical document only: `project`, controls, render settings, and presets. A restore deliberately preserves shader identity/metadata, channel settings, texture bytes, and the current library thumbnail. The UI must say “source, settings, and presets” rather than promise an exact visual reproduction.

The milestone is complete when both HTTP and desktop users can open History, name an entry, and restore it as a new head revision with optimistic-concurrency and dirty-draft protection.

## Planning and launch context

- Planning ref: `codex/plan-shader-history`
- Plan path: `docs/feature-plans/shader-history-phase-1/`
- Immutable source base used for planning: `c42a649cdd4b6bf766c83ef6d35d45edcc174ff7`
- Default branch: `master`
- Remote: `origin` (`https://github.com/antelm-dev/shader-studio.git`)
- Planned integration branch: `codex/integrate-shader-history-phase-1`

Give every worker this README and its numbered prompt directly. Alternatively, give it the readable planning ref and both paths; a source branch based on `master` must not be assumed to contain these unmerged plan files. At launch, replace `<exact-launch-base>` with a recorded commit SHA resolved according to the task’s base policy.

## Shared contracts

- A history entry is immutable document content keyed by shader and the existing persisted `revision`; gaps are allowed when a non-versioned mutation increments the shader revision.
- Versioned content is `project`, controls, render settings, and presets. Texture bytes, channel settings, shader name/description/author, and thumbnails remain current-state data in Phase 1.
- Relevant create/import/duplicate operations establish an initial entry. Source/config/render updates and preset save/delete operations create entries in the same transaction as their head mutation.
- For an existing pre-feature shader with no entries, its pre-mutation state is captured before the first versioned mutation so the first edit does not erase the baseline.
- Restoring copies versioned content into a new head revision; it never rewinds the counter or deletes intervening entries. It requires `expectedRevision` and records the source revision.
- Naming or clearing a checkpoint changes history metadata without changing shader revision or content.
- Retention keeps the newest 50 unnamed entries per shader and every named checkpoint. Pruning is transactional with entry creation; deleting a shader cascades its history.
- Repository migrations are additive for SQLite and PostgreSQL. Do not edit shipped migration 1.
- No feature flag is required: Task 01 is a backward-compatible API with no automatic UI exposure, and Task 02 exposes a complete Phase 1 flow.

## Acceptance criteria

- **AC-HIST-01 — Atomic snapshots:** every in-scope committed mutation has the correct immutable document entry; a failed mutation or snapshot rolls back both.
- **AC-HIST-02 — Baseline and parity:** pre-feature shaders retain their baseline on first mutation, imports/copies start with history, and SQLite/PostgreSQL behavior agrees through library conformance tests.
- **AC-HIST-03 — Checkpoints and retention:** checkpoint names can be set/cleared, named entries survive pruning, and only the newest 50 unnamed entries remain.
- **AC-HIST-04 — Safe restore:** restore requires an unstale expected head, preserves out-of-scope current data, creates a new entry linked to its source, and leaves the selected historical entry immutable.
- **AC-HIST-05 — Transport parity:** list/checkpoint/restore work through REST and generated Electron IPC with shared types and standard errors.
- **AC-HIST-06 — Usable timeline:** web and desktop show newest-first entries, checkpoint names and restore provenance, with loading/empty/error states and an inline checkpoint-name action.
- **AC-HIST-07 — Draft-safe UI:** opening History is read-only; restore uses the existing unsaved-changes guard, adopts the returned record cleanly, clears matching recovery, refreshes summaries/history, and reports conflicts without losing the draft.
- **AC-HIST-08 — Honest scope:** English and French UI copy identifies Phase 1 as source/settings/preset history and does not imply texture or thumbnail restoration.

## Tasks and delivery

| ID | Primary outcome | Depends on | Branch / sibling worktree | Delivery | Base policy |
| --- | --- | --- | --- | --- | --- |
| 01 | Transactional history domain plus HTTP/IPC contracts | None | `codex/shader-history-01` / `shader-studio-wt-shader-history-01` | `default-branch-pr` → `master` | `latest-default` |
| 02 | History dialog, checkpoints, and guarded restore | Task 01 PR merged and reachable from refreshed `master` | `codex/shader-history-02` / `shader-studio-wt-shader-history-02` | `default-branch-pr` → `master` | `latest-default` |

Task 01 is independently deployable because migrations are additive and its new endpoints/IPC methods are opt-in. Task 02 may launch only after Task 01 is merged, not merely after its PR opens.

## Execution waves

### Wave 1

Run Task 01. Gate: all backend conformance, REST routing, IPC generation, and relevant typechecks pass; migration rollback and retention behavior have direct tests; review accepts the API contract and Task 01 is merged into `master`.

### Wave 2

Refresh `origin/master`, record its exact SHA, then run Task 02 from that SHA. Gate: focused UI/store tests pass, English/French catalogs are complete, both web and desktop builds typecheck, and the critical scenarios below pass on the integrated result.

No separate source integration task is planned. The coordinator owns conflicts and the final gate on the updated destination branch or, if combined validation is needed before merge, on `codex/integrate-shader-history-phase-1`.

## Verification

Worker checks are in each prompt. After accepted work is integrated, the coordinator runs:

```text
pnpm ci
pnpm build:desktop
git diff --check
```

Critical E2E scenarios:

1. Create a shader, make two source/settings saves, restart the SQLite-backed desktop app, and see both entries newest first.
2. Name an older entry, create enough automatic entries to cross the limit, and verify the named checkpoint remains while excess unnamed entries are pruned.
3. With a dirty draft, cancel restore and lose nothing; then discard and restore, yielding a clean new head while the former head remains in history.
4. Save/change a preset, restore the older entry, and recover the prior preset state while current texture bytes and channel settings remain unchanged.
5. Repeat list/checkpoint/restore through the HTTP-backed web app and verify a stale `expectedRevision` returns the standard conflict without changing head or history.

## Worktree, review, and integration policy

- Create worker worktrees as siblings of the repository, never inside it. Confirm a clean initial `git status --short --branch`.
- Workers preserve unrelated changes, stay inside owned boundaries, use 1–3 logical commits, review their complete diff, and report commit SHAs, checks, remaining risks, and changed files.
- Planning does not authorize pushes, PRs, or merges. A later coordinator/reviewer invocation should explicitly say: **“Review completed tasks and open or merge eligible PRs.”**
- Resolve conflicts by ownership: Task 01 owns shared/backend/transport contracts; Task 02 rebases onto the merged contract and owns client/UI integration. Do not silently redesign the accepted Task 01 API in Task 02.
- Remove worker worktrees and branches only after their commits are merged and reachable from the destination. Never clean pre-existing user files as part of worktree cleanup.

## Deferred backlog

No worker prompt is created for these items:

- Revision thumbnails and revision-targeted asynchronous capture
- Source/config/render/preset visual diff, including Monaco side-by-side views
- Duplicate-from-revision
- Content-addressed texture blobs and exact asset restoration
- Configurable storage limits, storage meter, age-based retention, and downsampling
- Compile-health metadata
- Arbitrary revision-to-revision comparison
- History-aware bundle export/import

```yaml
review_contract:
  milestone: shader-history-phase-1
  planning_ref: codex/plan-shader-history
  source_base: "c42a649cdd4b6bf766c83ef6d35d45edcc174ff7"
  default_branch: master
  integration_branch: codex/integrate-shader-history-phase-1
  tasks:
    - id: "01"
      branch: codex/shader-history-01
      depends_on: []
      acceptance: [AC-HIST-01, AC-HIST-02, AC-HIST-03, AC-HIST-04, AC-HIST-05]
      checks:
        - "pnpm --filter @shader-studio/backend test"
        - "pnpm --filter @shader-studio/server test"
        - "pnpm gen:ipc"
        - "pnpm --filter @shader-studio/desktop typecheck"
      delivery: default-branch-pr
      base_policy: latest-default
    - id: "02"
      branch: codex/shader-history-02
      depends_on: ["01"]
      acceptance: [AC-HIST-06, AC-HIST-07, AC-HIST-08]
      checks:
        - "pnpm --filter @shader-studio/web test"
        - "pnpm --filter @shader-studio/web typecheck"
        - "pnpm check:i18n"
        - "pnpm build"
        - "pnpm build:desktop"
      delivery: default-branch-pr
      base_policy: latest-default
  integration_checks: ["pnpm ci", "pnpm build:desktop", "git diff --check"]
  e2e_scenarios:
    - "history persists across a desktop restart and is newest first"
    - "a named checkpoint survives retention pruning"
    - "dirty-draft cancel is lossless and restore creates a new head"
    - "preset state restores while texture bytes and channel settings remain current"
    - "HTTP restore rejects a stale expected revision atomically"
  deferred:
    - revision thumbnails and visual diffs
    - duplicate-from-revision
    - texture asset history
    - configurable and age-based retention
    - compile-health metadata
    - history-aware bundles
```
