# CI application routing

The CI workflow keeps common lint and format checks, then validates and deploys
each affected application independently. No application jobs run for docs-only
changes. A manual workflow dispatch validates both applications; a push to
`preview` always produces the Windows preview package.

| Changed files                                                                                                                                           | Application checks and deployment |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `apps/website/`, `libs/brand/`, `ops/website/`, `Dockerfile.website`, `tools/workspace/src/website-smoke.ts`                                            | Website                           |
| `apps/studio/`, `apps/studio-e2e/`, other `libs/`, other `tools/`, `plugins/`, `examples/`, `i18n/`, `ops/staging/`, `Dockerfile`, `docker-compose.yml` | Studio                            |
| `libs/shared/`, CI routing, the shared SSH deploy scripts, root configuration, lockfile, unknown paths                                                  | Both                              |
| `docs/`, root Markdown, `.bruno/`, `LICENSE`, `NOTICE`                                                                                                  | Neither                           |

The branding library currently belongs to the website dependency graph. If the
studio starts consuming it, update `.github/scripts/ci-scope.mjs` and its tests
to include studio validation for brand changes.

`nrwl/nx-set-shas` selects the comparison range against the PR target or the
current push branch. Pushes compare with the last successful CI run, so a later
docs-only commit also revalidates application changes from a failed or cancelled
run. Initial runs without a successful baseline validate both applications.
Renames are treated as a deletion and addition to cover both old and new paths.

Studio validation retains domain/library/MCP tests, repository checks, production
SSR smoke, browser smoke, E2E, its Docker image and Windows packaging. Nx caches
its typecheck/test/build tasks. Website validation installs its filtered workspace
dependencies, typechecks the website and brand, runs brand tests and builds the
static export and its Docker image. It also runs the release pages browser smoke
against the static export before deployment.

On `develop`, `deploy-staging` waits for common checks plus studio validation,
browser smoke, E2E and the studio image. `deploy-website` waits for common checks
plus website validation and its image. Neither deployment waits for the other
application's jobs. Windows packaging remains a CI check, as before, rather than
a prerequisite for deploying the web studio.

The restricted VPS command accepts `studio COMMIT_SHA` or `website COMMIT_SHA`
and checks that the SHA is still the current `develop` head. It rejects other
targets. The legacy SHA-only command still queues both applications so older
workflow runs remain compatible.

Before pushing a change to this command's protocol, install
`ops/staging/deploy-on-vps.sh` as `/usr/local/sbin/deploy-shadergrove-staging`
on the VPS (root-owned, mode 755). Tokens and the authorized-key restrictions
stay unchanged. CI confirms queuing; Dokploy reports the final rollout status.

Run routing checks locally with:

```sh
node --test .github/scripts/ci-scope.test.mjs
bash .github/scripts/deploy-on-vps.test.sh
```
