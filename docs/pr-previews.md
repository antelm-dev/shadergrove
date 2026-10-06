# PR preview environments

Apply the `preview` label to a non-draft PR from this repository targeting
`develop`. After CI succeeds, **PR previews** builds the exact merge commit tested
by CI and deploys it to `https://pr-N.45-155-170-120.sslip.io/`. A bot comment on the
PR links to the preview and identifies the deployed commit. The label can be
applied before or after CI; failed or pending CI never deploys. Fork PRs do not
qualify. Rerun CI if its seven-day preview source artifact has expired.

The environment has its own PostgreSQL volume, user credentials, authentication
secret, Mailpit service, and networks. Only Studio is publicly routed through
HTTPS. PostgreSQL and Mailpit publish no ports. Seeded test shaders are Aurora
Veil, Hex Pulse and Warp Tunnel. A verified `preview@example.test` account has a
random password, stored only on the VPS:

```sh
sudo cat /var/lib/shadergrove-previews/pr-N/credentials.json
```

Use its credentials to sign in. Additional accounts can sign up normally and
verify their email through that preview's private Mailpit. To find Mailpit's
container address, on the VPS run:

```sh
sudo docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \
  "$(sudo docker compose -p shadergrove-pr-N --env-file /var/lib/shadergrove-previews/pr-N/.env \
  -f /etc/shadergrove-previews/compose.yml ps -q mailpit)"
```

Then use the existing administrator SSH key to forward a local port to that
address on port 8025. Mailpit captures messages; it does not deliver real email.
Compromised-password checking is disabled for these disposable test accounts;
email verification and auth rate limits remain enabled.

New commits redeploy after passing CI, preserving the PR database and test
credentials. Removing the label, closing/merging the PR, or converting it to a
draft deletes the preview **including its database and emails**. Daily cleanup
also removes inactive previews missed by webhook events. Two previews may be
allocated at once; failed deployments retain their slot for recovery. Remove a
label to free one. An existing preview may represent an older successful commit
while the current PR is waiting for CI; the status comment makes that explicit.

## Deployment controls

`.github/workflows/pr-previews.yml` runs trusted workflow code for routing,
deployment and comments. The PR image builds in an isolated GitHub runner with
no VPS key. The source artifact is read as a bounded JSON record without
extracting files or executing artifact content. The record must match the live
PR number, head, base, merge commit, repository and successful CI run.

The root-owned controller repeats PR/CI validation on the VPS, checks the merge
parents and image revision, and pulls the image by immutable digest. Its SSH key
can only deploy a validated request, delete an inactive PR, or prune inactive
previews. Compose, hostnames, image repository, limits, network topology and
fixture payloads come from installed trusted files. PRs cannot mount host paths
or access the Docker socket, staging network, database or credentials. Registry
authentication uses the deploy job's ephemeral read-only token and is discarded
after pulling the image. Preview operations serialize through a VPS lock.

## Setup and recovery

Generate a dedicated SSH key. Run `generate-fixtures.mjs` from the repo root to
produce `fixtures.json`, then copy that file, the controller, Compose template,
installer, and public key to a temporary directory on the VPS. Run the installer
as root from that directory. Existing staging keys and services remain intact.

Create a GitHub environment named `previews`, allow only `master` and `develop`,
and store the private key as `PREVIEW_DEPLOY_SSH_KEY` in that environment. The
workflow must be present on the default branch (`master`) for CI completion and
scheduled events, and on `develop` for PR target events and source records.
Create the `preview` label. No permanent registry credential is required.

To retry after CI has passed:

```sh
gh workflow run pr-previews.yml --ref master -f pr=N
```

Temporary DNS uses the same `sslip.io` service as staging and individual HTTPS
certificates. Move to an owned preview domain with wildcard DNS for sustained
usage; update the controller, workflow URLs and browser URL validator together.
Previews cover the web Studio. Electron remains covered by desktop CI and
downloadable package artifacts.

Local checks:

```sh
node --test .github/scripts/preview-target.test.mjs
python3 -m unittest discover -s ops/previews -p 'test_*.py'
```

Preview lifecycle verification: CI source recording, image deployment, browser smoke and PR cleanup.
