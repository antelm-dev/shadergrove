# Desktop Account Sync — Milestone 2 (pull and deletion)

## Goal and milestone

Milestone 1 (`docs/feature-plans/desktop-sync-m1/`, merged in #18–#21, fixed in `ffbc5e8`) pushes linked local shaders to the account. The desktop never reads the account on its own, so manual testing showed three gaps:

- shaders created on the web never appear on the desktop;
- a shader deleted on the web keeps showing "synced";
- deleting a linked shader on the desktop leaves the account untouched.

Milestone 2 closes these gaps. It is complete when:

1. every run first reads the account's list;
2. shaders created or changed on the web are pulled;
3. shaders deleted on the web are unlinked and kept locally;
4. deleting a linked shader asks "Delete from this computer" or "Delete everywhere", and "Delete everywhere" works offline through a queue;
5. "synced" means "checked against the account during the last run".

### Decisions

- **Sync goes both ways.** The only conflict resolution is "keep both", which already exists: `keepBoth` in `sync-service.ts`.
- **A shader deleted on the web** is unlinked, and its local copy is kept.
- **Deleting a linked shader locally** asks the user to choose:
  - "Delete from this computer": the account copy stays, and this computer ignores it from then on.
  - "Delete everywhere": the local copy goes now, and the account copy is deleted on the next run. If the account copy changed after the last sync, it is **not** deleted: it comes back into the local library and the user is told.
- **Simplification compared with what was said earlier.** Pulled shaders are stored in the **local scope**, exactly like uploaded ones. So they stay visible after sign-out or with another account signed in, where they show `other-account`. The earlier idea of storing them under the account's scope and hiding them would have required the desktop API to read two scopes and route every write accordingly. The desktop is a single-OS-user app, and uploaded shaders already behave this way. Revisit only if a shared-machine requirement appears.
- **When runs happen:**
  - at sign-in;
  - when the network comes back;
  - 2 s after a local write;
  - **every 60 s while signed in**;
  - **when the window gains focus**, at most once every 15 s.

### Non-goals

Merging content at field level; sync history; byte-level progress; server push notifications (polling is enough); de-duplicating shaders that have the same name.

## Planning and launch context

- Planning ref: `codex/plan-desktop-sync`, path `docs/feature-plans/desktop-sync-m2/`
- Source base: `6bd6aaa` (`origin/develop`, which contains milestone 1 and the `/desktop/connect` fix)
- PR target: `develop`. Remote: `origin` (`https://github.com/antelm-dev/shader-studio.git`). Nothing needs an integration branch.
- Give each worker this README and its prompt directly. Replace `<exact-launch-base>` with the SHA recorded at launch.
- Worktrees in fresh checkouts: run `pnpm install --frozen-lockfile` and `pnpm gen:ipc` (the generated bridge is gitignored). Run nx with `NX_DAEMON=false NX_TUI=false`. Repo-wide `format:check` fails locally on Windows line endings; check the changed files with `oxfmt --check`, since CI checks out LF.

## Shared contracts

- **C1 — Conditional delete (Task 01).** `DELETE /api/shaders/:id?expectedRevision=N` deletes only if the stored revision is still `N`; otherwise it returns `409 conflict`. Without the parameter, behaviour is unchanged. `ShaderLibrary.remove(id, expectedRevision?)` does the same in one transaction on both engines.
- **C2 — Link and state (Tasks 02 and 03).**
  - A link becomes `{ remoteId, remoteRevision, localRevision, localThumbnail, remoteThumbnail }`, where `remoteThumbnail` is the account's `thumbnail.updatedAt` at the last sync, or `null`. Older links without it are read as `undefined`, which means "unknown": pull the thumbnail once.
  - `sync_ignored:<accountUserId>` holds a JSON array of remote ids this computer must never pull.
  - `sync_tombstones:<accountUserId>` holds a JSON array of `{ remoteId, remoteRevision, name }`, the "Delete everywhere" operations still to run.
  - Links, the ignored list and tombstones are always read and written under the account the run started for. The milestone 1 identity checks (`assertAccount`) cover every new request.
- **C3 — Run order (Task 02, extended by Task 03).** Each run:
  1. sends pending tombstones (Task 03);
  2. `GET /api/shaders` (non-template), for the pull and to detect remote deletions;
  3. pushes dirty links (as in milestone 1);
  4. pulls.
  If a link's local shader is missing and no tombstone covers it (deleted locally without a choice, including milestone 1's leftover links), the link is dropped and its remote id is added to the ignored list.
- **C4 — Pull rules (Task 02).** For each remote shader:
  - linked, remote revision higher, local not dirty → export, replace locally (`replaceFromPayload`, then `setThumbnail`/`clearThumbnail`), update the link;
  - linked, both sides changed → `keepBoth`;
  - linked, only the remote thumbnail changed → pull the thumbnail alone;
  - neither linked nor ignored → export, `importPayloads` locally in `rename` mode, link to the new local id;
  - a linked remote id missing from the list → unlink, keep the local copy, status `local-only`.
  Pulls report `{ done, total }` progress like pushes. When a pull replaces the open shader, the id is reported in `replaced`, and the renderer reloads it through the existing `ShaderStore.reloadReplaced`, which keeps any unsaved draft.
- **C5 — Deletion IPC (Task 03).** `sync.remove(localId, mode: 'local' | 'everywhere')` deletes the local shader and records either the ignored id or a tombstone, in one step from the renderer's point of view. `SyncChangedEvent` gains `notices?: { kind: 'restored-after-delete'; name: string }[]`, sent once. The renderer shows the two-choice dialog only for a shader linked to the signed-in account; otherwise the existing single-choice delete dialog is used.

## Acceptance criteria

- **AC-API-03:** a conditional delete with a stale revision gives 409 and deletes nothing; a matching revision deletes; no parameter behaves as before. Conformance on both engines, plus REST tests.
- **AC-PULL-01:** a shader created on the web appears on the desktop within one run, linked and `synced`.
- **AC-PULL-02:** a web edit to a shader not edited locally replaces its local content and thumbnail. A web change while the local copy is dirty gives "keep both".
- **AC-PULL-03:** a shader deleted on the web becomes `local-only` and its local copy is kept. An ignored remote id is never pulled.
- **AC-PULL-04:** runs also start every 60 s and on window focus (at most once every 15 s). The identity checks hold for pulls: a mid-run account switch writes nothing further.
- **AC-PULL-05:** an open shader replaced by a pull reloads without losing an unsaved draft.
- **AC-DEL-01:** "Delete from this computer" removes the local shader, keeps the account copy and never pulls it back.
- **AC-DEL-02:** "Delete everywhere" removes the local copy and deletes the account copy on the next run, offline included, through the tombstone queue.
- **AC-DEL-03:** if the account copy changed since the last sync, "Delete everywhere" does not delete it. It is pulled back and the user sees a notice.

## Tasks and delivery

| ID | Outcome | Depends on | Branch / worktree | Delivery | Base |
|---|---|---|---|---|---|
| 01 | Conditional delete (library, both engines, REST) | — | `codex/desktop-sync-m2-01` / `shader-studio-wt-desktop-sync-m2-01` | PR → `develop` | `latest-default` |
| 02 | Pull engine, remote-deletion unlink, ignored list, timer/focus runs, reload of the open shader | — | `codex/desktop-sync-m2-02` / `shader-studio-wt-desktop-sync-m2-02` | PR → `develop` | `latest-default` |
| 03 | Delete dialog, `sync.remove`, tombstone queue, conditional remote delete, restore notice | 01 and 02 merged | `codex/desktop-sync-m2-03` / `shader-studio-wt-desktop-sync-m2-03` | PR → `develop` | `latest-default` |

Each task is safe to merge on its own:
- 01 is additive.
- 02 only changes behaviour when an account URL is configured, and it can only add or unlink local shaders, never delete them.
- 03 only changes the delete dialog of linked shaders.

**Waves.** Wave 1 runs 01 and 02 in parallel; its gate is both PRs merged. Wave 2 runs 03 from the refreshed `develop`.

## Verification

Integration gate, after each merge and run by the coordinator:
- `pnpm gen:ipc`, `pnpm lint`, `pnpm check`;
- typecheck of all projects;
- `pnpm test`, `pnpm build:desktop`;
- `oxfmt --check` on the changed files.

Manual E2E, with `pnpm dev` (`BETTER_AUTH_URL=http://localhost:4200`) and `pnpm dev:desktop` (`SHADER_STUDIO_ACCOUNT_URL=http://localhost:4200`):

1. **E2E-6:** create a shader on the web; it appears on the desktop within 60 s, or at once on focus, linked.
2. **E2E-7:** edit it on the web; the desktop picks up the change, including while that shader is open, without losing a local draft.
3. **E2E-8:** delete a linked shader on the web; the desktop keeps it as `local-only`.
4. **E2E-9:** "Delete from this computer": gone locally, still on the web, never pulled back.
5. **E2E-10:** "Delete everywhere" while the server is stopped: gone locally at once; after the restart, gone from the web.
6. **E2E-11:** "Delete everywhere" after a web edit that the desktop has not pulled yet: the shader comes back locally with a notice, and the web copy is kept.

## Policies

- Planning does not authorize remote actions. The coordinator opens PRs when the user asks.
- A PR counts as landed only when it is merged and reachable from the refreshed `develop`.
- Workers never touch `.env` or the main checkout, never push, and each makes 1–3 commits.

```yaml
review_contract:
  milestone: desktop-sync-m2
  planning_ref: codex/plan-desktop-sync
  source_base: "6bd6aaa"
  default_branch: master
  pr_target: develop
  tasks:
    - id: "01"
      branch: codex/desktop-sync-m2-01
      depends_on: []
      acceptance: [AC-API-03]
      checks: ["pnpm nx run @shader-studio/backend:test", "pnpm nx run @shader-studio/server:test"]
      delivery: default-branch-pr
      base_policy: latest-default
    - id: "02"
      branch: codex/desktop-sync-m2-02
      depends_on: []
      acceptance: [AC-PULL-01, AC-PULL-02, AC-PULL-03, AC-PULL-04, AC-PULL-05]
      checks: ["pnpm gen:ipc", "pnpm nx run @shader-studio/desktop:test", "pnpm nx run @shader-studio/web:test", "pnpm check"]
      delivery: default-branch-pr
      base_policy: latest-default
      feature_flag: SHADER_STUDIO_ACCOUNT_URL
    - id: "03"
      branch: codex/desktop-sync-m2-03
      depends_on: ["01", "02"]
      acceptance: [AC-DEL-01, AC-DEL-02, AC-DEL-03]
      checks: ["pnpm gen:ipc", "pnpm nx run @shader-studio/desktop:test", "pnpm nx run @shader-studio/web:test", "pnpm check"]
      delivery: default-branch-pr
      base_policy: latest-default
  integration_checks: ["pnpm lint", "pnpm check", "pnpm test", "pnpm build:desktop"]
  e2e_scenarios: [E2E-6, E2E-7, E2E-8, E2E-9, E2E-10, E2E-11]
  deferred: [field-level-merge, account-scoped-storage, server-push]
```
