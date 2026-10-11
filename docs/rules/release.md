---
type: rule
applies_to: [all]
enforced_by: [release-please, check:plugins, angular budgets, review]
---

# Branches, versions and releases

- Name branches with a Conventional Branch prefix (`feat/`, `fix/`, `chore/`, `docs/`, `test/`, `ci/`, `refactor/`, `perf/`).
- `master` is stable. Feature pull requests into `master` are squash-merged with a Conventional Commit title that describes the delivered behavior; Release Please builds the changelog and the next version from those titles. See [Releasing](../../RELEASING.md).
- `develop` is the beta and staging branch. Synchronizations between `master` and `develop`, in either direction, are merge commits, never squashes or rebases.
- After a stable release, `.github/beta-release.json` on `develop` must name a version strictly newer than the published stable, or new betas fail. See [the publication pipeline](../website-releases.md).
- An official plugin version is immutable. Any byte change to a package under `plugins/official/` (for a language pack, any change to `i18n/en.json` or `i18n/fr.json` it ships) bumps `manifest.version` to a version never used on any branch, then `pnpm gen:plugins` regenerates the package and `catalogue.json`. When `master` and `develop` each moved a pack, their merge takes the union and a new version again. See [official plugins](../../plugins/official/README.md).
- Never raise the bundle budgets in `apps/studio/angular.json`. Keep new code out of the initial bundle with `@defer` or a dynamic `import()` instead.

Why it exists: Release Please, the beta pipeline and installed plugin updates all derive versions from history. A squashed sync, a reused pack version or a beta base at or below the stable silently ships the wrong build or hides an update.

How it is enforced: Release Please and the prerelease workflow refuse bad versions; `check:plugins` fails when a package is stale against its sources; the Angular build fails over the error budget. Reusing a pack version and raising a budget are caught in review.
