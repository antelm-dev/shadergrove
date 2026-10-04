# Dependency maintenance

Renovate proposes updates to `develop` every Monday before 06:00 Europe/Paris,
with at most five ordinary PRs open and no automatic merging. Angular, Nx and
Nest packages are grouped; major updates are separated from minor/patch updates.
Ordinary releases wait three days. Security fixes bypass that delay and schedule.
GitHub Actions are pinned by SHA and Docker base images are configured for digest
pinning. Node, pnpm, Trivy and cdxgen pins are also tracked.

## GitHub setup

Dependabot alerts are enabled on `antelm-dev/shadergrove`. Keep the dependency
graph enabled. Renovate owns update PRs; enabling a second bot for update PRs is
unnecessary. Alerts describe the dependency graph of the default branch (`master`),
so they complement image scans and do not inventory every deployed desktop copy.

Install the official [Renovate GitHub App](https://github.com/apps/renovate) with
access only to this repository. GitHub Apps need the configuration on the default
branch: promote `renovate.json` to `master` through the normal release/integration
process to activate this policy, even though update PRs target `develop`.

Make `Dependency review` and the Docker security job required in branch rules
if merges must be blocked by their failures. Adding a failing check alone does
not make it mandatory; `develop` currently has no branch protection.

## Reproducible SSR runtime

`ops/runtime-deps/package.json` and its npm lockfile describe the external `pg`
and Swagger dependencies installed in the final studio image. Docker uses
`npm ci --omit=dev --ignore-scripts`, fixing transitive versions and checking
registry integrity hashes. The root dependency versions must stay aligned;
`check-runtime-deps.mjs` rejects drift. Renovate groups updates across manifests.

A scoped npm override patches Swagger's pinned `js-yaml@5.2.1` to `5.2.2` for
[GHSA-pm4m-ph32-ghv5](https://github.com/advisories/GHSA-pm4m-ph32-ghv5).
Remove the override when Swagger depends on a patched version upstream; it does
not suppress findings or alter the workspace dependency graph.

To update this inventory manually, update the root and runtime manifests, then:

```sh
npm install --package-lock-only --ignore-scripts --no-audit --no-fund --prefix ops/runtime-deps
node .github/scripts/check-runtime-deps.mjs
node --test .github/scripts/dependency-security.test.mjs
```

## CI and releases

PRs get Dependency Review, failing on newly introduced HIGH/CRITICAL known
vulnerabilities. The existing Docker job now builds both final images, generates
CycloneDX SBOMs, and runs Trivy. Fixable HIGH/CRITICAL image vulnerabilities fail
the job. Complete JSON reports retain unfixed and lower-severity findings for
triage; no blanket ignore list or silent scanner failure is configured.

The `dependency-security` artifact is retained for 30 days and contains:

- `workspace.cdx.json`: all lockfile dependencies, including development/build
  tools and Electron. It is an inventory of the workspace, not a claim that every
  component ships in every product. Release version and source commit are recorded.
- `studio-image.cdx.json` and `website-image.cdx.json`: components detectable in
  the final images, including OS packages and external Node dependencies.
- `studio-vulnerabilities.json` and `website-vulnerabilities.json`: full reports.

Stable and beta workflows inventory their exact source commit, attach the three
SBOM files to the draft GitHub release, and verify their presence before publishing.
The workspace SBOM complements image inventories because bundled Angular/SSR code
may not be identifiable from a final filesystem scan. No Dependency-Track server
or upload credential is required.

When a gate fails, inspect the report, update the affected package or base image,
and rerun CI. A successful upload is not a vulnerability clearance. Framework major
updates may require `ng update` or `nx migrate`; review migration notes and exercise
the desktop application after Electron updates.
