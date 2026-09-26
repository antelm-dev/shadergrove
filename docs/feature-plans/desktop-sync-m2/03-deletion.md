# Task 03 — Deleting linked shaders

Read the coordinator `README.md` first. Contracts C1 (consumed), C2, C3 and C5 are the spec.

## Mission

When the user deletes a shader that is linked to the signed-in account, they choose between "Delete from this computer" and "Delete everywhere". "Delete everywhere" goes through a queue so it also works offline, and it never destroys an account copy that someone changed in the meantime.

## Launch base

`latest-default` on `develop`, **after Tasks 01 and 02 are merged**. Base: `<exact-launch-base>`.

```text
git worktree add <abs>/shader-studio-wt-desktop-sync-m2-03 -b codex/desktop-sync-m2-03 <exact-launch-base>
```

## Context

- `apps/web/src/app/ui/workspace-actions.ts`: `deleteShader` (confirm dialog, `guardedTransition`). Also the existing dialog components in `apps/web/src/app/ui/dialogs/`, of which `confirm-dialog` is the model.
- `apps/web/src/app/desktop/desktop-sync.ts`: statuses, and which account the shader is linked to.
- `apps/desktop/main/src/sync/sync-service.ts` after Task 02: the run order, the ignored list, `readLinks`, the pull of a new shader.
- `apps/desktop/main/src/ipc/sync.ipc.ts` and `libs/desktop-api/src/contracts.ts`.
- Server: `DELETE /api/shaders/:id?expectedRevision=N` (Task 01).

## Owned scope

`sync-service.ts` and its spec (the deletion parts), `sync.ipc.ts`, `contracts.ts`, `workspace-actions.ts`, one small choice dialog (or a variant of the confirm dialog), `desktop-sync.ts` (to show notices), and the i18n files (`i18n/en.json`, `i18n/fr.json`, `keys.ts`).

## Required work

1. `sync.remove(localId, mode)`. The link must belong to the signed-in account; otherwise refuse and let the renderer fall back to a plain delete.
   - `local`: add the remote id to the ignored list, remove the link, delete the local shader.
   - `everywhere`: append `{ remoteId, remoteRevision: link.remoteRevision, name }` to `sync_tombstones:<account>`, remove the link, delete the local shader, then call `run()`.
   - Write the account state first, then delete the local shader, so a crash in between leaves at worst an orphan link. Task 02 already turns an orphan link into an ignored id, which loses nothing.
2. The run sends tombstones before anything else (C3), identity-bound: `DELETE …?expectedRevision=remoteRevision`.
   - 204 or 404: drop the tombstone.
   - 409: drop the tombstone and let the pull bring the shader back as a new local shader. Record a notice `restored-after-delete` with its name. **Make sure the pull does not skip it**: a tombstoned remote id must not be on the ignored list.
   - 401 or offline: keep the tombstone, stop as today.
3. A remote id with a pending tombstone is neither pulled nor listed as missing.
4. `sync-changed` carries the notices once, and the renderer shows them in a snackbar in English and French.
5. Renderer: in `deleteShader`, when the shader's status is linked to the signed-in account (`synced`, `pending`, `conflict-resolved`, `error`), show a dialog with three buttons: Cancel, Delete from this computer, Delete everywhere. Then call `sync.remove` inside the same `guardedTransition` and remove it from the store. Everything else keeps the current confirm dialog.

## Out of scope

Pull logic (Task 02) and server changes (Task 01).

## Tests

- **`sync-service.spec.ts`:**
  - `local` ignores the id and the account copy stays;
  - `everywhere` deletes on the next run;
  - `everywhere` while offline sends on reconnect;
  - a 409 brings the shader back with a notice;
  - a 404 drops the tombstone;
  - an account switch keeps tombstones per account;
  - refused when the shader is linked to another account.
- **A focused renderer spec:** the dialog choice routes to `sync.remove` with the right mode, and an unlinked shader keeps the plain dialog.

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

Also run `oxfmt --check` on the changed files. Covers AC-DEL-01 to AC-DEL-03.

## Delivery

A PR to `develop`. Make 1–3 commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, and do not push. Report: the commits, the result of each check, and the risks.
