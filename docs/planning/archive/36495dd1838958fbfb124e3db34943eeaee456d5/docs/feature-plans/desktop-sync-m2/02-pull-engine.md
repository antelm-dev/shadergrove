# Task 02 — Pull engine

Read the coordinator `README.md` first. Contracts C2, C3 and C4 are the spec.

## Mission

Every sync run reads the account first. It pulls shaders created or changed on the web, unlinks the ones deleted there, and runs regularly on its own. After this task, the desktop's statuses reflect the account.

## Launch base

`latest-default` on `develop` (at least `6bd6aaa`), no prerequisites. Base: `<exact-launch-base>`.

```text
git worktree add <abs>/shader-studio-wt-desktop-sync-m2-02 -b codex/desktop-sync-m2-02 <exact-launch-base>
```

## Context

- `apps/desktop/main/src/sync/sync-service.ts` and its spec:
  - `run`/`enqueue` serialize runs;
  - `batch` handles progress;
  - `assertAccount` and `call` bind a run to one account;
  - `push`, `keepBoth`, `unlink`, `readLinks`/`writeLinks`;
  - the `replaced` list is sent with `sync-changed`.
  Read the milestone 1 rule carefully: a request sent under account A that succeeds keeps its result under A; only the check made before a request stops a run without writing.
- `libs/backend/src/library/shader-library.ts`: `importPayloads` (`rename`), `replaceFromPayload` (ignores thumbnails), `setThumbnail`, `clearThumbnail`, `exportOne`.
- Server endpoints: `GET /api/shaders` returns summaries with `revision`, `kind` and `thumbnail.updatedAt`; `GET /api/shaders/:id/export` returns the bundle.
- `apps/desktop/main/src/main.ts`: how `SyncService` is wired, the save debounce, the `online` trigger.
- Renderer: `apps/web/src/app/desktop/desktop-sync.ts` and `ShaderStore.reloadReplaced`.

## Owned scope

`sync-service.ts` and its spec, and the few lines of `main.ts` that wire the timer and window focus. Touch `desktop-sync.ts` only if the refresh after a pull needs it.

## Required work

1. Follow the run order and pull rules in C3 and C4.
   - The account list is read in a single `GET /api/shaders` per run, and templates are excluded.
   - Pulls are identity-bound exactly like pushes.
   - Pulls add to the same `{ done, total }` progress as pushes.
2. Add the `remoteThumbnail` field to links. A link written before this change has no such field: pull its thumbnail once.
3. Store the ignored list in `sync_ignored:<account>`, with read and write helpers. Links whose local shader is missing (and not covered by a tombstone; tombstones don't exist yet, Task 03 adds them) are dropped, and their remote id goes into the ignored list.
4. When a pull imports a shader locally, the local id may differ from the remote one. The link maps them.
5. A pull that replaces an existing local shader reports its id in `replaced`, so an open editor reloads it without losing its draft. A new import only refreshes the list.
6. Add two triggers in `main.ts`:
   - a 60-second interval while the account is signed in, cleared on sign-out and on dispose;
   - `BrowserWindow` `focus`, at most one run every 15 s.
   Both go through `run()`, so they merge with a run already queued.
7. Statuses: a shader counts as `synced` only once the last run checked it against the account's list. Remote deletions give `local-only`.

## Out of scope

The delete dialog, tombstones and remote deletes (Task 03). Server changes.

## Tests (`sync-service.spec.ts`, fake server)

- a remote-only shader is pulled and linked;
- a remote edit is pulled, thumbnail included and a removed thumbnail cleared;
- a change on both sides gives keep-both;
- a thumbnail-only remote change;
- a remote deletion unlinks and keeps the local copy;
- an ignored id is never pulled;
- a link whose local shader is missing moves its remote id to the ignored list;
- an account switch mid-pull writes nothing further;
- an older link without `remoteThumbnail`;
- the timer and focus triggers merge into one run (fake timers).

## Verification

```text
pnpm gen:ipc
pnpm nx run @shader-studio/desktop:test
pnpm nx run @shader-studio/web:test
pnpm check
pnpm lint
pnpm nx run-many -t typecheck --projects "@shader-studio/*"
pnpm build:desktop
```

Also run `oxfmt --check` on the changed files. Covers AC-PULL-01 to AC-PULL-05.

## Delivery

A PR to `develop`, with `SHADER_STUDIO_ACCOUNT_URL` as the flag. Make 1–3 commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, and do not push. Report: the commits, the result of each check, the files you touched outside the owned scope, and the risks.
