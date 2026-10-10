---
type: runbook
area: deploy
last_verified:
related: [database-backup-restore.md, website-vps.md, staging.md, pr-previews.md]
---

# Deployment rollback

Use this when a deployment is live and broken: health check failing, sign-in broken, shaders not
rendering. The goal is to get the previous working build back, then fix forward.

## Before you start

Check whether the bad deployment changed the database schema. The schema is migrated on startup, and
**a build refuses to start against a schema newer than it supports**, so rolling code back across a
migration also requires restoring the database.

```sh
git diff --stat GOOD_SHA BAD_SHA -- libs/backend/src/persistence/postgres/migrations.ts libs/backend/src/publication/publication-store.ts
```

- No output: code-only rollback, follow the steps for your environment.
- Any change: you also need the backup taken before the bad deployment. Follow
  [database backup and restore](database-backup-restore.md) → _Restore over a live database_ after
  rolling back the code. Everything written since that backup is lost; if that is unacceptable, fix
  forward instead.

`GOOD_SHA` is the last commit that worked. For staging, find it in the Dokploy application's
**Deployments** tab or the `deploy-staging` runs of the CI workflow.

## Staging studio and website

Staging only ever deploys the current head of `develop`: the deploy script ignores a request for
any other commit, and Dokploy builds from the branch. Rolling back therefore means making `develop`
point at working code again.

1. Revert the bad commits on `develop` (one revert per bad commit, newest first, or a merge revert
   with `-m 1` for a merged PR):

   ```sh
   git switch develop && git pull
   git revert --no-edit BAD_SHA
   git push origin develop
   ```

2. CI runs on the push and, once the required jobs pass, deploys the revert. Studio waits for
   `check`, `studio-check`, `smoke`, `e2e` and `docker`; the website deploys independently after its
   own checks (see [CI routing](../ci.md)).
3. If CI itself is broken and you cannot wait, use the application's **Deploy** button in Dokploy
   after pushing the revert. It builds the head of `develop`.

The studio and the website are separate Dokploy applications: rolling one back does not touch the
other.

## PR previews

A preview is disposable. Remove the `preview` label to delete it, or push a fix to the PR: the next
successful CI run redeploys it, keeping its database. See [PR previews](pr-previews.md).

## Self-hosted (Docker Compose)

The image is built locally from the checkout (`shadergrove:latest`), so roll back by building the
previous version:

```sh
git fetch --tags
git checkout GOOD_TAG_OR_SHA
docker compose up -d --build shader-studio
```

## Verify

```sh
curl --fail-with-body https://staging.45-155-170-120.sslip.io/api/health
```

Expect HTTP 200 with `{"status":"ok"}` (use your own origin when self-hosted), then sign in and open
a shader. For the website, load the home page and check its JavaScript and CSS assets load. Confirm
the About dialog shows the expected version.

## Roll back the rollback

Revert the revert commit on `develop` (or check out the newer version when self-hosted) once the
problem is fixed. If you restored the database, the newer build migrates it forward on startup.
