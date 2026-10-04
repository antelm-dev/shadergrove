# Releasing Shadergrove

Shadergrove has three Windows delivery paths. CI previews are temporary test
builds, beta releases are opt-in Electron updates, and stable releases are
versioned from `master`.

Before promoting a commit, complete [the release-readiness checklist](docs/release-readiness.md).
Record which checks passed and which still require manual validation in the release PR.

## Desktop account configuration

CI previews and the stable/beta workflows currently do not set
`SHADER_STUDIO_ACCOUNT_URL`. Their desktop builds therefore have accounts
disabled. To ship an account-enabled build, configure that origin in the build
environment before packaging and validate the installed browser sign-in round
trip. This is a build-time setting, not an installer preference; see
[desktop accounts and uploads](README.md#desktop-accounts-and-uploads).

## Repository setup

In **Settings → Actions → General**, enable **Allow GitHub Actions to create and
approve pull requests** so Release Please can maintain its release pull request.

Add a `RELEASE_PLEASE_TOKEN` repository secret backed by a fine-grained token
with Contents, Issues, and Pull requests read/write permissions. Without it the
workflow falls back to `GITHUB_TOKEN`, and pull requests created with
`GITHUB_TOKEN` do not start CI, so the release pull request would show no checks.

Merge feature pull requests with **Squash and merge** and give each one a
Conventional Commit title describing the delivered behavior, for example
`feat(plugins): add Shadertoy import and Wallpaper Engine export`. Release Please
lists every commit that reaches `master`, so merge commits and individual
development commits would otherwise appear as duplicate changelog entries. Keep
any `BREAKING CHANGE:` footer in the pull request description so it survives the
squash.

## Preview builds

Push to or merge into the `preview` branch. CI runs the normal Windows packaging
check and uploads the unpacked application as
`shadergrove-preview-<commit>`. The artifact is available from the workflow
run for 14 days and is never published to the Electron update feed.

## Stable releases

Release Please runs after pushes to `master` and maintains a release pull
request from Conventional Commits:

- `fix:` produces a patch release.
- `feat:` produces a minor release.
- `feat!:` or a `BREAKING CHANGE:` footer produces a major release.

Merge the generated release pull request
when the accumulated changes are ready and its CI has passed. Release Please
updates `CHANGELOG.md`, `package.json` and `APP_VERSION`, creates the
`v<version>` tag and a draft GitHub Release. The workflow then:

1. checks that the tag, `package.json` and `APP_VERSION` agree, and runs
   `pnpm run ci` on the tagged commit;
2. builds and attaches the NSIS installer, portable executable, blockmap, and
   `latest.yml` to the draft;
3. checks that every asset is present and that `latest.yml` names this version's
   installer at its uploaded size;
4. publishes the release.

Installed copies therefore never see a release before its update manifest is
available. A failure at any step leaves the release as a draft.

To retry a failed publication, open **Actions → Release → Run workflow** and
enter the tag, for example `v2.0.0`. The run skips Release Please, checks that
the tag's commit is on `master` and that the release is still a draft, then
repeats steps 1–4. A published release is never rebuilt.

Stable installers consume the `latest` update channel.

## Beta releases

Open **Actions → Beta release → Run workflow**, choose the commit or branch to
promote, and enter a unique version such as `1.1.0-beta.1`.

The workflow writes the version into both `package.json` and `APP_VERSION`, runs
`pnpm run ci`, creates a draft GitHub prerelease, builds and uploads the Windows
updater assets on the `beta` channel, verifies them, then publishes the
prerelease. Plugin compatibility treats a beta as the release it leads to:
`2.0.0-beta.1` accepts the plugins whose `appVersionRange` includes `2.0.0`. A failed build leaves a draft that a
rerun with the same version can reuse.

Users opt into beta updates by installing a beta build. Beta builds consume the
`beta` feed; ordinary versions consume `latest`.
