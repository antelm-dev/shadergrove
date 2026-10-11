---
type: runbook
area: deploy
last_verified:
related: []
---

# Deploying Shadergrove with accounts

Each web user gets a private library. Desktop editing remains local and works
offline. Desktop builds configured with `SHADER_STUDIO_ACCOUNT_URL` can sign in
through the system browser and upload local shaders to an account; they do not
yet download the full web library. See [desktop account setup](../../README.md#desktop-accounts-and-uploads).

## What you need before you start

- **HTTPS.** Session cookies are issued `Secure` in production, so a browser
  will not send them back over plain HTTP; the app will appear to sign you out
  on every request. Terminate TLS at a reverse proxy in front of the container.
- **An SMTP server.** Without one nobody can confirm an address or recover an
  account. Production refuses to start without `MAIL_SMTP_URL` for that reason.
- **A secret.** `openssl rand -base64 32`. It signs cookies; changing it signs
  everybody out.

## First run

1. Copy `.env.example` to `.env` and fill in `POSTGRES_PASSWORD`,
   `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `MAIL_SMTP_URL` and `MAIL_FROM`.
   `BETTER_AUTH_URL` is the origin **browsers** reach — `https://shaders.example`,
   not `http://localhost:4000`. It is what email links are built from and the
   only origin allowed to drive a cookie-authenticated request.
2. `docker compose up -d --build`. The schema migrates on the first API request;
   the container readiness probe triggers that request automatically.
3. Open the app and sign up. Confirm the address from the email.
4. If the instance is private, set `AUTH_REGISTRATION=invite-only` and restart.
   Sign-in keeps working; sign-up stops.

Put `TRUST_PROXY=1` in `.env` **only** once a reverse proxy you control is
actually in front. It makes `x-forwarded-for` believed, and that header is what
per-IP throttling and the audit log key on — exposed directly, any caller could
forge it and choose their own rate-limit bucket.

## Existing shaders

The ownership migration gives every shader that predates authentication to a
`system` account nobody can sign in as. They are invisible until you claim them:

```bash
docker compose --profile claim run --rm claim --email=you@example.com --dry-run
docker compose --profile claim run --rm claim --email=you@example.com
```

The account has to exist first, so sign up before running this. Bundled examples
are **not** claimed: they are templates, readable by everyone and writable by
nobody. Editing one gives the editor a copy in their own library and leaves the
example alone.

## What is enforced, and where

Ownership is enforced in SQL, not in the UI or the controller. Every query
carries `owner_user_id = <the session's user>`, so a request for someone else's
shader cannot be answered by any path through the app — and a shader you do not
own is reported exactly as one that does not exist, so its existence cannot be
probed.

| Control                                                             | Where                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------- |
| Session cookies: `HttpOnly`, `SameSite=Lax`, `Secure` in production | `auth.ts`                                               |
| Origin/CSRF check on every cookie-authenticated mutation            | `auth.ts`                                               |
| Idle and absolute session expiry                                    | `AUTH_SESSION_IDLE_SECONDS`, `AUTH_SESSION_MAX_SECONDS` |
| Password reset revokes every other session                          | `auth.ts`                                               |
| Per-IP throttling on credential endpoints                           | `auth.ts`, `AUTH_RATE_LIMIT`                            |
| Breached-password rejection                                         | `AUTH_CHECK_COMPROMISED_PASSWORDS`                      |
| HSTS, `X-Frame-Options`, `nosniff`, `Referrer-Policy`               | `security-headers.ts`                                   |
| Audit log                                                           | `audit.ts`                                              |

## Operating notes

**Readiness:** `GET /api/health` needs no session and performs a database metadata
read after the API has initialized. It returns `200` with `{ "status": "ok" }`
or a generic `503` on initialization/database failure, with `Cache-Control: no-store`.
The Docker healthcheck uses this endpoint. It does not check SMTP delivery or
the browser UI. Library endpoints, including `/api/shaders`, remain authenticated.

**Sessions are database rows.** Revoking one takes effect on the next request —
there is no cached copy to wait out. "Sign out everywhere" is in the account
menu, and a password reset does it for you.

**The audit log** is one JSON line per event on stdout: sign-in success and
failure, sign-up, sign-out, password reset requested and completed, session
revocation, and shader deletion. It never contains a cookie, a password, a
reset or verification token, or a session id. An email address appears only on a
failed sign-in, where there is no user id to name and an operator looking at a
password-spraying run has nothing else to correlate on. Ship these lines
somewhere append-only if you need a tamper-evident trail — this is a log, not an
audit database.

**The breached-password check fails closed.** If `api.pwnedpasswords.com` is
unreachable, sign-up and password reset are refused rather than accepting a
password that might be in a breach. That is the right default and a real
availability trade-off; `AUTH_CHECK_COMPROMISED_PASSWORDS=0` turns it off for an
air-gapped deployment.

**Rotating `BETTER_AUTH_SECRET`** signs everyone out. Sessions survive a restart
otherwise, because they live in PostgreSQL rather than in memory.

## Backups

`docker compose exec postgres pg_dump …` covers shaders and accounts together —
they are one database on purpose, so a restore can never leave a session
pointing at a user who no longer exists, or a shader at an owner who does not.
