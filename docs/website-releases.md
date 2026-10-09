# Website releases and desktop distribution

## Source and public API

GitHub Releases in `antelm-dev/shadergrove` remain the source for version, date,
Markdown notes and binaries. The website offers `/download` and `/changelog`;
version links use `?version=<semver>` so future releases work with the static export.
Stable releases are the default, and `?channel=beta` explicitly selects previews.
The complete release body is displayed on the changelog, and each version links to
its own downloads rather than silently downloading a newer version.

Studio exposes anonymous GET endpoints:

- `/api/releases?channel=stable&page=1`: `{ releases, nextPage }`, in published-date
  order within each upstream page. Pages contain 20 upstream releases before channel
  filtering; an empty page may still have `nextPage`. Pagination is bounded to 100 pages.
- `/api/releases/latest?channel=stable`: `{ release }`, using GitHub's designated latest
  stable release. Beta searches the first 100 upstream releases and never returns stable.
  A missing latest release returns `{ release: null }`.
- `/api/releases/1.5.0`: a single published version, or 404. Drafts remain invisible
  even if a server token can read them. Only stable and `-beta.N` versions are supported.

The DTO is defined in `libs/shared/src/model/releases.ts`. Only uploaded, nonempty
installers with canonical filenames and download URLs from this repository are
admitted. Source archives, blockmaps and updater manifests are not download options.
Legacy `shader-studio-*` binaries before the rename remain downloadable. Windows
filenames without an architecture identify x64; new Linux and macOS
filenames include the architecture.

GitHub calls have an eight-second timeout, five-minute cache, shared in-flight requests,
a bounded cache, and a one-minute retry delay after failures. Successful cached data
can remain available for up to 24 hours during a transient outage; a definitive 404
invalidates it. Successful HTTP responses are publicly cacheable for one minute.
Failures return a sanitized, uncached 503. Wildcard CORS applies only to these public
GET routes, with no credentials, leaving account and shader routes unchanged.

`GITHUB_RELEASES_TOKEN` is an optional server-only token for a higher GitHub API quota.
Never include it in website build arguments. Configure `NEXT_PUBLIC_STUDIO_URL` or
`NEXT_PUBLIC_RELEASES_API_URL` for the website as described in its README. Deploy the
Studio API before the website; an old API without these routes returns an explicit
unavailable state. A first deployment still requires rebuilding the website image.

## Notes

Review the notes in the release PR before merging it. The body of the published
GitHub release is the website changelog: use concise sections for new features,
fixes and upgrade instructions. An edit to published release notes reaches the site
after the cache refreshes, without maintaining a second handwritten changelog.
Beta releases remain visibly separate. Raw HTML, unsafe link protocols and remote
images are disabled by the website's Markdown renderer.

## Publication pipeline

Every push to `develop` starts `.github/workflows/prerelease.yml`. The upcoming
stable version is explicitly configured in `.github/beta-release.json` (currently
`2.9.0`); betas are numbered per base from `<base>-beta.0`, one past the highest
existing `<base>-beta.N` release, so changing the base restarts at 0. A commit that
already has a beta of that base reuses it, so reruns keep their number. Versions are
written to `package.json` and `APP_VERSION` only in the build checkout, without
committing version bumps back to `develop`. A new beta's base must be strictly
newer (by semver) than the highest published stable release, for automatic and
manual versions alike; otherwise the workflow fails and asks for a new base. Drafts
and prereleases do not count as published stable releases.

Manual dispatch on `develop` can omit `version` to use automatic numbering or
provide an explicit `-beta.N` version. To recover a failed draft, rerun the original
workflow so its version and commit remain identical. A matching published beta is
skipped; a draft is resumed only at its original commit, even if a stable release
has since overtaken its base. A bare tag without a release gets no such exemption.
Reusing a beta version for another commit fails. Published betas use
`prerelease=true`, `latest=false`, and the `beta` updater manifest.

Release decisions read the complete paginated release list (drafts are visible
because the resolving job has `contents: write`). An unreadable page, a malformed
entry, a published non-prerelease release whose tag is not `vX.Y.Z`, or more than
10,000 releases stop the workflow rather than deciding on partial data. Several
releases sharing the specific tag being looked up (the beta being resolved, or
the stable predecessor) also stop it.

Every push to `master` starts `.github/workflows/release.yml`. Release Please
creates or updates its release PR from Conventional Commits. The workflow checks
that this is the repository's pending release PR, accepts only version/changelog
file changes, and runs `pnpm run ci` against its merge commit before merging. Any
independent PR checks must also pass. If the PR head or `master` changes while
validation runs, the workflow refuses the merge; rerun it against the new state.
The merge uses `GITHUB_TOKEN`, and a second Release Please invocation creates the
draft/tag in the same run. This does not require GitHub's auto-merge setting or a
personal token to trigger another workflow. Branch protection and required reviews
still apply; the workflow does not bypass them. A failed pre-merge check leaves the
PR open. Only release-worthy Conventional Commits produce a new release PR.

Before merging, the workflow also requires the version committed on `master`
(`.release-please-manifest.json` at the PR base) to be the newest published stable
release. If that release is still a draft (for example, because a desktop build or
asset verification failed), is missing, or a newer stable release already exists,
the workflow fails and the release PR stays open. The check runs when the PR is
selected and again, against the pinned base and a fresh release list, immediately
before the merge. Publish the pending release with
the recovery command below, then rerun the workflow. This is what stops a feature
merge from promoting 2.1.0 while 2.0.0 still awaits recovery. The check relies on
the desktop publisher only publishing after asset verification; it does not
re-verify the assets of releases published by hand.

Stable and beta workflows call `.github/workflows/desktop-release.yml` after validation
of the exact commit. That workflow validates the draft and its target, builds all
enabled platforms, collects artifacts, uploads to the draft, verifies every required
installer and updater manifest, and only then publishes the release. A failed platform
leaves the release in draft. Builds do not independently publish from matrix jobs.
Retries can replace draft assets, but the desktop publisher refuses to modify an
already published release (the beta entry point skips matching published betas).
Verification tools follow the workflow revision while application builds stay pinned
to the release commit, allowing recovery of older Windows drafts that predate those tools.

Stable recovery uses manual dispatch on `master` with an existing draft's tag:

```sh
gh workflow run release.yml --ref master -f tag=v2.0.0
```

This validates and publishes the tagged commit; it does not create or merge a new
release PR. No automatic workflow publishes assets when validation fails.

Stable publication sets GitHub's Latest flag explicitly, never using GitHub's
date-based default: `--latest=true` only when the release is newer (by semver)
than every other published stable release, otherwise `--latest=false`. Recovering
`v2.0.0` after `v2.1.0` was published therefore leaves `v2.1.0` as Latest. The
flag is not re-evaluated afterwards; correct an already wrong designation by hand
with `gh release edit <newest tag> --latest`.

After each stable publication, synchronize the branches before the next cycle:

1. Merge `master` into `develop`, so that `develop` carries the published version
   in `package.json`, `APP_VERSION`, `.release-please-manifest.json` and
   `CHANGELOG.md`. Never let an older manifest from `develop` overwrite `master`;
   the pre-merge check above refuses to promote from a regressed manifest.
2. Set `.github/beta-release.json` on `develop` to the next intended stable version
   (strictly newer than the published release). Until then, new betas fail.

Windows x64 remains enabled by default and retains installer identity and filenames.
Linux and macOS are prepared but opt in through repository Actions variables:

| Variable                        | Value to enable | Packages                                              |
| ------------------------------- | --------------- | ----------------------------------------------------- |
| `DESKTOP_LINUX_RELEASE_ENABLED` | `true`          | x64 AppImage and `.deb` on Ubuntu 22.04               |
| `DESKTOP_MACOS_RELEASE_ENABLED` | `true`          | Intel and Apple Silicon `.dmg` and `.zip` on macOS 15 |

Absent or false variables keep those platforms out of the required release matrix.
The website displays their files automatically once present in a published release.
Both macOS architectures are built together so their updater entries share one
combined manifest rather than overwriting each other from separate jobs.

Before enabling macOS, configure `CSC_LINK` (Developer ID Application certificate),
`CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`.
The workflow refuses missing credentials. macOS packaging requires signing and
notarization; local unsigned development should not use the public `dist:mac` target.

Local commands are `pnpm dist:win`, `pnpm pack:linux`, `pnpm dist:linux` and
`pnpm dist:mac`. Use the appropriate OS runner for each distributable. Linux/macOS
startup, sandbox behavior, persistence, GPU rendering, exports and OS protocol/account
integration must be checked on installed packages before enabling public releases.
Automatic updates in the application currently remain Windows-installer-only;
Linux and macOS users download subsequent versions manually.

## Validation

- `pnpm --filter @shadergrove/studio test:server`: API/cache/filtering and HTTP contracts.
- `pnpm --filter @shadergrove/workspace-tools test`: complete-release verification.
- `pnpm build:website && pnpm smoke:website`: browser coverage against the static export.
- `pnpm --filter @shadergrove/workspace-tools verify:release v1.5.0 latest windows`:
  read-only verification of published or draft release assets (requires authenticated `gh`).

The new pipeline still requires an actual GitHub Actions run; unit tests and local
website checks do not establish Linux/macOS installed-package readiness. Follow the
[release-readiness checklist](release-readiness.md) before activating those platforms.
