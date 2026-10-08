# Staging on vps-lab-01

The temporary staging origin is <https://staging.45-155-170-120.sslip.io/>. It
points to the PulseHeberg VPS at `45.155.170.120`. Replace this hostname and
`BETTER_AUTH_URL` when Shadergrove has its own domain. The VPS runs Dokploy,
Traefik, the web application, PostgreSQL 16, and Mailpit. Only ports 22, 80,
and 443 are open; PostgreSQL, Mailpit, and the Dokploy dashboard have no public
port or domain.

## Access

The Dokploy dashboard is reachable through a local SSH tunnel. From PowerShell:

```powershell
ssh -N -i "$env:USERPROFILE\.ssh\vps-lab-01" -L 127.0.0.1:3000:172.18.0.4:3000 root@45.155.170.120
```

Open <http://127.0.0.1:3000/> in a browser. Mailpit, which captures staging
verification and password-reset emails, uses a separate tunnel:

```powershell
ssh -N -i "$env:USERPROFILE\.ssh\vps-lab-01" -L 127.0.0.1:8025:172.18.0.7:8025 root@45.155.170.120
```

Open <http://127.0.0.1:8025/>. The `172.18.0.x` addresses are Docker gateway
addresses and can change when services are recreated. On the VPS, find the new
address with `docker ps` followed by `nsenter -t $(docker inspect -f '{{.State.Pid}}' CONTAINER_ID) -n ip -4 addr`.

## Deployments

Dokploy's **Shadergrove / staging / Shadergrove web staging** application builds
the repository's Dockerfile from the `develop` branch. Dokploy's Autodeploy
switch is on so its private webhook accepts the CI request; this generic Git
source has no provider push webhook configured. When studio inputs change,
the `check`, `studio-check`, `smoke`, `e2e`, and `docker` GitHub Actions jobs
must pass on a push to `develop` before `deploy-staging` queues the studio
deployment. Website validation and deployment run independently; see
[CI routing](ci.md). The restricted SSH command receives `studio COMMIT_SHA`
and queues only the studio service. The `staging` GitHub environment allows
deployments only from
`develop` and holds the CI private key in its `STAGING_DEPLOY_SSH_KEY` secret.
Its public key in `/root/.ssh/authorized_keys` has a
forced command and the OpenSSH `restrict` option, so that key can only execute
`/usr/local/sbin/deploy-shadergrove-staging`. The script is versioned at
[`ops/staging/deploy-on-vps.sh`](../ops/staging/deploy-on-vps.sh); copy changes to
the same VPS path when updating it. The Dokploy deploy token lives only in
`/root/.config/shadergrove-staging-deploy-token` (mode 600), not in GitHub.

The application's **Build-time Arguments** contain `VERSION_REF=develop`. The
Dockerfile then labels the build with `git describe --tags` of `develop` (for
example `2.2.0-beta.15-1-g7593d1a`), which the About dialog and plugin
compatibility checks report, instead of the last stable version committed in
`package.json`.

The GitHub job confirms that Dokploy accepted the deployment request. Check the
Dokploy **Deployments** tab for the final build and rollout result. To deploy
manually, use the application's **Deploy** button. To verify the running app:

```powershell
curl.exe --fail-with-body https://staging.45-155-170-120.sslip.io/api/health
```

The response should be HTTP 200 with `{"status":"ok"}`. This checks the app
and PostgreSQL, not email delivery or the browser UI.

## Configuration and data

The app listens on container port 4000. Its Dokploy environment contains
`DATABASE_URL`, `NODE_ENV=production`, `PORT=4000`, `NG_ALLOWED_HOSTS`,
`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `MAIL_SMTP_URL`, `MAIL_FROM`,
`AUTH_REGISTRATION`, `TRUST_PROXY=1`, and the staging feature flags. PostgreSQL
and Mailpit are internal Dokploy services with no published ports. User data
resides in PostgreSQL's volume. Do not put secrets in Git or Docker build args.

The first account was verified through Mailpit. Registration is set to
`AUTH_REGISTRATION=invite-only` in Dokploy. Mailpit is a capture service: mail
never reaches an external mailbox.
No off-server database backup is configured yet. Set up a Dokploy S3 backup
destination before relying on staging data; a backup on this VPS alone would
be lost with the VPS.

The `sslip.io` hostname is a temporary DNS service. Its individually issued
Let's Encrypt certificate is valid now, but shared certificate rate limits and
third-party DNS availability make an owned domain preferable for a durable
environment.
