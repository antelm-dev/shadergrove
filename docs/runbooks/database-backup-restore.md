---
type: runbook
area: data
last_verified:
related: [deployment-rollback.md, deploying-authentication.md, staging.md]
---

# Database backup and restore

Shaders, accounts, sessions and publications all live in one PostgreSQL database, so one dump is a
complete, consistent backup. Use this runbook to take a backup, to prove it restores, and to restore
it over a broken database.

A backup that stays on the same host is not a backup: it is lost with the host. Always copy the dump
off the machine that runs PostgreSQL.

## Before you start

- **Self-hosted (Docker Compose):** a shell in the directory holding `docker-compose.yml` and `.env`.
  The defaults are database `shader_studio` and user `shader_studio`; use `POSTGRES_DB` and
  `POSTGRES_USER` from `.env` if you changed them.
- **Staging:** SSH access as `ADMIN_USER` (see [VPS security](vps-security.md)). The database name and
  user are in the `DATABASE_URL` of the Dokploy application's environment
  (`postgres://USER:PASSWORD@HOST:5432/DATABASE`).
- Run the commands below in a POSIX shell (`sh`, bash, Git Bash). Do not redirect `pg_dump` output
  through Windows PowerShell 5.1: its `>` re-encodes the stream and corrupts the binary dump. The
  steps write the dump inside the container and copy it out with `docker cp` to avoid this.
- In Git Bash on Windows, run `export MSYS_NO_PATHCONV=1` first. Otherwise Git Bash rewrites the
  container paths (`/tmp/…`) into Windows paths and every step fails.

## Take a backup

### Self-hosted

```sh
stamp=$(date -u +%Y%m%dT%H%M%SZ)
docker compose exec -T postgres pg_dump -U shader_studio -d shader_studio -Fc -f /tmp/shadergrove.dump
docker compose cp postgres:/tmp/shadergrove.dump "./shadergrove-$stamp.dump"
docker compose exec -T postgres rm /tmp/shadergrove.dump
```

Copy `shadergrove-$stamp.dump` to storage on another machine.

### Staging

On the VPS:

```sh
db=$(sudo docker ps --filter ancestor=postgres:16 --format '{{.Names}}' | head -n 1)
[ -n "$db" ] || db=$(sudo docker ps --format '{{.Names}} {{.Image}}' | awk '/postgres/ { print $1; exit }')
echo "$db"
sudo docker exec "$db" pg_dump -U USER -d DATABASE -Fc -f /tmp/shadergrove.dump
sudo docker cp "$db:/tmp/shadergrove.dump" "/home/ADMIN_USER/shadergrove-$(date -u +%Y%m%dT%H%M%SZ).dump"
sudo docker exec "$db" rm /tmp/shadergrove.dump
sudo chown ADMIN_USER: /home/ADMIN_USER/shadergrove-*.dump
```

Check that `echo "$db"` printed the staging database container, not a PR preview's: preview
databases run in Compose projects named `shadergrove-pr-N`. Then, from your machine, copy the dump
off the VPS and delete the VPS copy:

```sh
scp -i ~/.ssh/vps-lab-01 'ADMIN_USER@45.155.170.120:shadergrove-*.dump' ./
ssh -i ~/.ssh/vps-lab-01 ADMIN_USER@45.155.170.120 'rm shadergrove-*.dump'
```

**Scheduled off-server backups are not configured yet.** Until a destination is chosen and set up
(for example a Dokploy S3 backup destination on the PostgreSQL service), this manual backup is the
only one. Take it before every deployment that changes the schema — see
[deployment rollback](deployment-rollback.md).

## Verify: restore drill

A backup counts only once it has been restored. Restore it into a disposable container, never into
a live database:

```sh
docker run -d --rm --name sg-restore-drill -e POSTGRES_PASSWORD=drill postgres:16-alpine
until docker exec sg-restore-drill pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
docker cp ./shadergrove-STAMP.dump sg-restore-drill:/tmp/restore.dump
docker exec sg-restore-drill createdb -U postgres shadergrove
docker exec sg-restore-drill pg_restore -U postgres -d shadergrove --no-owner --exit-on-error /tmp/restore.dump
docker exec sg-restore-drill psql -U postgres -d shadergrove -c "
  SELECT value AS schema_version FROM storage_metadata WHERE key = 'schema_version';
  SELECT (SELECT count(*) FROM users) AS users,
         (SELECT count(*) FROM shaders) AS shaders,
         (SELECT count(*) FROM publications) AS publications;"
docker stop sg-restore-drill
```

`pg_restore` must finish without errors, `schema_version` must match the running build, and the
counts must be plausible against the live service. Record the date, dump name and counts in the
release PR or wherever you track backups, then set `last_verified` on this runbook.

## Restore over a live database

This replaces everything written since the dump. Every session, shader and account change made after
the backup is lost.

1. Take a fresh backup of the current state first, even if it is broken — it may be needed later.
2. Stop the application so nothing writes during the restore:
   - self-hosted: `docker compose stop shader-studio`;
   - staging: stop the **Shadergrove web staging** application in Dokploy.
3. Recreate the database and restore into it. Self-hosted example:

   ```sh
   docker compose cp ./shadergrove-STAMP.dump postgres:/tmp/restore.dump
   docker compose exec -T postgres dropdb -U shader_studio --if-exists shader_studio
   docker compose exec -T postgres createdb -U shader_studio shader_studio
   docker compose exec -T postgres pg_restore -U shader_studio -d shader_studio --no-owner --exit-on-error /tmp/restore.dump
   docker compose exec -T postgres rm /tmp/restore.dump
   ```

   On staging, run the same `dropdb`, `createdb` and `pg_restore` with `sudo docker exec "$db"` and
   the user and database from `DATABASE_URL`.

4. Start a build whose schema version is at least the dump's `schema_version`. A build that supports
   an older schema refuses to start ("newer than this build supports"); a newer build migrates the
   restored database forward on startup.
5. Check `GET /api/health` returns HTTP 200 with `{"status":"ok"}`, then sign in and open a shader.

## Roll back

A restore cannot be undone except by restoring the backup taken in step 1.
