# Task 02 — Desktop sign-in handoff (server + web)

Read the coordinator `README.md` supplied with this prompt first. Contract C3 is the spec.

## Mission

Let a native client get a revocable bearer session for a signed-in web user through a PKCE-bound one-time code, without the client ever seeing a password or a cookie.

## Launch base

`latest-default` on `develop`, no prerequisites. Base: `<exact-launch-base>`.

```text
git worktree add <abs>/shader-studio-wt-desktop-sync-02 -b codex/desktop-sync-02 <exact-launch-base>
cd <abs>/shader-studio-wt-desktop-sync-02
git status --short --branch
```

## Context

- `apps/server/src/auth/auth.ts`: the Better Auth setup (plugins, hooks, cookie attributes, `FRESH_ONLY`, audit). `auth.spec.ts` and `session-policy.spec.ts` show how to test it.
- `apps/server/src/api/auth.guard.ts`: how a request becomes a `Principal`. It must accept `Authorization: Bearer`.
- `libs/backend/src/persistence/*/auth-schema.ts`: the `verifications` and `sessions` tables, which already exist on both engines. **No migration.**
- `apps/web/src/app/app.routes.ts`, `auth/auth-link.guard.ts`, `auth/auth.service.ts`, `auth/auth-prompt.ts`: how email links open the auth dialog over the app. `/desktop/connect` follows the same pattern.
- `docs/authentication-authorization-plan.md` §3: why the system browser is used.

## Owned scope

`auth.ts`, a new `apps/server/src/auth/desktop-handoff.ts` (+ spec), its registration in the API module, the web route and guard for `/desktop/connect`, i18n keys (`i18n/en.json`, `i18n/fr.json`, `apps/web/src/app/i18n/keys.ts`).

## Required work

1. Enable Better Auth's `bearer` plugin. Existing cookie behaviour must not change.
2. `POST /api/desktop/handoff { codeChallenge }` requires a cookie session with a verified email. It stores `{ userId, codeChallenge }` under a random one-time code in `verifications`, valid for 60 s, and returns `{ code }`. Use Better Auth's internal adapter if it is reachable; otherwise use the repository.
3. `POST /api/desktop/token { code, codeVerifier }` is public and rate-limited like the credential endpoints. It consumes the code: delete first, then check expiry and `base64url(sha256(verifier)) === challenge`. On success it creates a new session for the user with the user agent `Shader Studio Desktop` and returns `{ token, user: { id, name, email } }`. Every failure returns the same generic 400. Write one audit event per issued token.
4. Make sure Better Auth's origin and CSRF checks do not reject bearer requests that carry no cookie (for example `POST /api/auth/sign-out` from the desktop). Test it. If the check does reject them, document the minimal fix and apply it; do not disable the check globally.
5. Web `/desktop/connect?state&code_challenge`: validate both parameters (length, charset), make the user sign in if needed (the existing dialog; an unverified user sees the existing "verify" state), call the handoff endpoint, then `location.assign('shader-studio://auth/callback?code=…&state=…')`. Show a short "Return to Shader Studio" message in English and French, with a retry link. The route must never log the code.

## Out of scope

The desktop client (Task 03), sync endpoints (Task 01), refresh tokens (the idle and absolute session lifetimes still apply).

## Verification

```text
pnpm nx run @shader-studio/server:test
pnpm nx run @shader-studio/web:test
pnpm check:i18n
pnpm lint && pnpm format:check
```

Covers AC-AUTH-01 and AC-AUTH-02. The specs must show: a code is single-use; an expired code fails; a wrong verifier fails; an anonymous or unverified caller cannot get a code; the token authenticates `GET /api/shaders`; a revoked token gets 401; bearer sign-out works.

## Delivery

A `default-branch-pr` to `develop`, safe on its own: the endpoints and the page stay inert until a desktop client calls them, and cookie flows do not change.

## Commits

1 to 3 logical commits (server handoff, web page). Report: commits, check output, acceptance IDs, and the finding on the origin check (item 4).
