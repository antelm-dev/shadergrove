# Task 03 — Desktop sign-in client

Read the coordinator `README.md` supplied with this prompt first. Contracts C3 (consumed) and C4 (provided) are the spec.

## Mission

A desktop user signs in through the system browser and signs out, and the main process holds an encrypted bearer session that the rest of the app reaches only through `AccountSession`.

## Launch base

`latest-default` on `develop`, after the Task 02 PR is **merged**. Base: `<exact-launch-base>`.

```text
git worktree add <abs>/shader-studio-wt-desktop-sync-03 -b codex/desktop-sync-03 <exact-launch-base>
cd <abs>/shader-studio-wt-desktop-sync-03
git status --short --branch
```

## Context

- `apps/desktop/main/src/main.ts`: single-instance lock, the `second-instance` handler, IPC registration through `createIpcContainer().loadAll`, and the `shader-studio` scheme, already privileged for serving the bundle at `shader-studio://bundle/`. The callback uses host `auth`; do not break bundle serving.
- `apps/desktop/main/src/env.ts`: add `accountUrl`, taken from `SHADER_STUDIO_ACCOUNT_URL` at build time (see how `__ELECTRON_PRODUCTION__` is injected in `rollup.config.mjs`).
- `apps/desktop/main/src/ipc/*.ipc.ts` + `pnpm gen:ipc` → `libs/desktop-api/src/ipc-bridge.ts`, plus `preload/src/preload.ts` for events. `update.ipc.ts` and `desktop-updater.ts` are a good model: main-process state pushed to a renderer signal.
- `apps/web/src/app/app.ts` (`cloudAccounts`) and `app.html`: the account button that is hidden on the desktop today.
- `apps/web/src/app/workspace/routing-coordinator.ts`: follows `AuthService` identity and **must stay unaffected on the desktop**. Do not provide a desktop `AuthService`; add a separate `DesktopAccount` service.

## Owned scope

A new `apps/desktop/main/src/account/account-session.ts` (+ spec), a new `apps/desktop/main/src/ipc/account.ipc.ts`, `env.ts`, the wiring in `main.ts` (keep it to a few lines), a new `apps/web/src/app/desktop/desktop-account.ts`, the account menu in `app.ts`/`app.html`, and i18n keys.

## Required work

1. `AccountSession` (C4): status `disabled` without `accountUrl`. `signIn()` generates `state` and a PKCE verifier, opens `<accountUrl>/desktop/connect?…` with `shell.openExternal`, and waits for the callback (5-minute timeout). `handleCallback(url)` checks `state`, then calls `POST /api/desktop/token` via `net.fetch` and stores the token encrypted with `safeStorage` in `userData/account.bin`. If `safeStorage` is unavailable, sign-in is refused; never store the token in plain text. `fetch()` adds the bearer header, and a 401 moves the state to `reauth-required`. `signOut()` calls `POST /api/auth/sign-out`, then deletes the file and clears the state even if the server cannot be reached. On startup, restore the stored token and check it with `GET /api/auth/get-session`. If the network fails, keep `signed-in` with the cached user: offline is not signed out.
2. The deep link: `app.setAsDefaultProtocolClient('shader-studio')` (with `process.execPath` and args in dev). Handle the URL from `second-instance` argv, from the initial `process.argv` and from `open-url` (macOS). Only `shader-studio://auth/callback` goes to `handleCallback`; every other URL is ignored.
3. `account.ipc.ts`: `state`, `signIn`, `signOut`, `openAccountPage` (opens the web app for session management), plus the pushed event `account-changed`.
4. Renderer `DesktopAccount`: a signal filled from the bridge. The account menu is shown only when the status is not `disabled`: sign in; user name and email; manage account (web); sign out; and a "Sign in again" state for `reauth-required`. English and French strings.

## Out of scope

Sync, status icons, the progress bar and upload actions (Task 04). The web `AuthService`, `AuthDialog` and `AccountDialog` on the desktop.

## Verification

```text
pnpm gen:ipc
pnpm nx run @shader-studio/desktop:test
pnpm nx run @shader-studio/web:test
pnpm check
pnpm lint && pnpm format:check
```

Unit tests for `AccountSession` with a fake `net.fetch`, `safeStorage` and `shell`: a wrong state is rejected, the callback times out, a 401 gives `reauth-required`, a network failure on startup keeps the cached user, and sign-out clears the state even offline. Then run the manual pass of E2E-1 (sign-in part) and E2E-4 against `pnpm dev:server` with Task 02 merged. Covers AC-DESK-01 to AC-DESK-03.

## Delivery

A `default-branch-pr` to `develop`. The flag is `SHADER_STUDIO_ACCOUNT_URL`: when it is unset, nothing changes for users.

## Commits

1 to 3 logical commits (main-process session and deep link, IPC and renderer menu). Report: commits, check output, acceptance IDs, the manual E2E notes, risks (Windows protocol registration in dev and packaged builds).
