# Task 04 — Push sync engine, status icons and progress

Read the coordinator `README.md` supplied with this prompt first. Contracts C1 and C2 (consumed), C4 (consumed; may still be in progress) and C5 (provided) are the spec.

## Mission

Linked local shaders stay in sync with the account in the push direction. Upload is on demand, dirty linked shaders are pushed automatically, conflicts resolve as "keep both", and the user sees a status icon on each shader and a progress bar.

## Launch base

`latest-default` on `develop`, after the Task 01 PR is **merged**. Task 03 may run in parallel: code against C4 and use a fake `AccountSession` in tests. The coordinator merges this branch into `codex/integrate-desktop-sync-m1` after Task 03 lands. Base: `<exact-launch-base>`.

```text
git worktree add <abs>/shader-studio-wt-desktop-sync-04 -b codex/desktop-sync-04 <exact-launch-base>
cd <abs>/shader-studio-wt-desktop-sync-04
git status --short --branch
```

## Context

- `apps/desktop/main/src/main.ts`: the `library` (`ShaderLibrary` in `LOCAL_SCOPE`) and the IPC registration.
- `apps/desktop/main/src/ipc/shader.ipc.ts`: the local operations, and how bundles are built (`buildShaderBundle`, `exportOne`).
- `libs/backend/src/library/shader-library.ts`: `getMeta`/`setMeta`, `importPayloads`, and `replaceFromPayload` (Task 01).
- Server: `POST /api/import` (mode `rename`) for the first upload (the remote id may differ from the local one), `PUT /api/shaders/:id/bundle` for pushes, `GET /api/shaders/:id/export` to fetch the account version on conflict.
- Renderer: `apps/web/src/app/ui/browser/shader-browser.ts` (where each shader row is drawn), `app.html` (a `MatProgressBar` is already imported in `app.ts`).

## Owned scope

A new `apps/desktop/main/src/sync/sync-service.ts` (+ spec), a new `apps/desktop/main/src/ipc/sync.ipc.ts`, a new `apps/web/src/app/desktop/desktop-sync.ts`, the status icon and upload actions in `shader-browser.ts`, the progress bar in `app.html`, a small hook in `main.ts`, and i18n keys.

## Required work

1. Links (C5) are kept in `storage_metadata` under `sync_links:<accountUserId>`. Add a `ponytail:` comment noting that the whole JSON map is rewritten on each change and that a table is the upgrade path. Runs are serialized: never two at once.
2. `upload(ids)`: export the local shader, `POST /api/import` in `rename` mode, then store `{ remoteId, remoteRevision: 1, localRevision }`. Templates and already-linked shaders are skipped.
3. `run()` is triggered on sign-in, on `account-changed` → `signed-in`, when the network comes back (`online` event or a periodic retry with backoff), and after each local save while signed in (debounced). It pushes every dirty link with `PUT …/bundle` and `expectedRevision = remoteRevision`, then updates both revisions.
   - 409: download the account version, replace the local shader with it (`replaceFromPayload`), create an unlinked copy named `<name> (conflict)` holding the local edits, update the link, and set the status to `conflict-resolved` until the next edit.
   - 404: unlink, status `local-only`.
   - 401: stop the run, status `reauth-required`, keep the dirty links.
   - Any other failure: `error` for that shader, and move on to the next one.
4. Statuses (C5) are computed for every non-template shader. Links belonging to another account (other `sync_links:*` keys) show `other-account` and are never pushed. Emit `sync-changed` with `progress: { done, total }` during a run and `null` once it ends.
5. IPC `sync`: `statuses`, `upload(ids)`, `uploadAll()`, `run()`, plus the event.
6. Renderer: a `DesktopSync` signal; an icon with an accessible label and tooltip on each shader row (no icon when the account status is `disabled` or `signed-out`); "Upload to account" on a row and "Upload all" in the account menu; a determinate progress bar showing "n / total" while a run is going. English and French strings.

## Out of scope

Pulling shaders that are not linked, deletions, any resolution other than "keep both" (milestone 2), and changes to the account session (Task 03).

## Verification

```text
pnpm gen:ipc
pnpm nx run @shader-studio/desktop:test
pnpm nx run @shader-studio/web:test
pnpm check
pnpm lint && pnpm format:check
```

`sync-service.spec.ts` uses a real `ShaderLibrary` on a temporary SQLite database and a fake `AccountSession.fetch`. It covers: upload links the shader; an edit makes it dirty and the push clears that; on 409 there are two local shaders with the right content and nothing is lost; on 404 the shader is unlinked; on 401 the run stops and the links are kept; with account B signed in, A's links are never pushed; two triggers at once run only once. Covers AC-SYNC-01 to AC-SYNC-05. After integration, the coordinator runs E2E-1 to E2E-5.

## Delivery

`integration-only` → `codex/integrate-desktop-sync-m1`. It needs Task 03 at runtime. The flag is inherited: with no account URL, no icon and no sync.

## Commits

1 to 3 logical commits (engine, IPC and renderer). Report: commits, check output, acceptance IDs, and any files touched outside the owned scope (for the coordinator to resolve conflicts).
