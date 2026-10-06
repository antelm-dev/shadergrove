# Wiki sources

The published user guide lives at https://github.com/antelm-dev/shadergrove/wiki.
The source of truth for its pages is `pages/`; assets and the tutorial bundle are
kept beside the pages. Review these files with product changes, then publish the
same files to the wiki repository.

## Scope

The core guide covers v1.5.0 and development commit f4ad6d8. The official catalogue
workflow is marked Development. Availability was checked from the tag's source,
rather than inferred from the README's known limitations, which had stale statements
about Explore, plugins, and custom effects.

The tutorial example deliberately uses a v3 bundle, accepted by both inspected
versions. It has no custom effects and does not require the v4 export format.

## Preview and publish

GitHub requires an initial page to create the wiki Git repository. If the wiki is
empty, create Home in GitHub's Wiki editor first. Then clone it into a separate
directory:

```powershell
git clone https://github.com/antelm-dev/shadergrove.wiki.git C:\\Work\\shadergrove-wiki
```

Copy the contents of `pages/` into the wiki checkout, including `assets/` and
`examples/`. Copy only those files; leave unrelated wiki content intact. Review
the diff, commit the changes, and push the wiki's existing default branch. Wiki
links use page names without a `.md` extension. Do not publish this maintenance
README as a wiki page.

## Checks before publication

- Match UI labels and feature availability to the documented tag or commit.
- Mark development-only workflows and server-dependent features.
- Parse the downloadable bundle with the app's `parseBundle` validator and
  confirm its GLSL compiles.
- Check page links, asset paths, and downloadable files.
- Preview Home, tables, code blocks, and navigation on GitHub.
- After pushing, verify the wiki remote commit and published pages.

## Extend the guide

Add short recipes for a concrete outcome: texture input, Bloom, buffer feedback,
or a custom effect. Each recipe should have steps, a visible expected result, a
small importable project, and any compatibility limits. Link it from Features and
the sidebar. Update the version note when checking a new release.

The tutorial frame was rendered from the downloadable bundle's GLSL in WebGL at
960 × 540, Speed 1, time 0.5 seconds. Compilation/linking, an opaque frame, a
frozen zero-speed result, and different Calm/Fast animation outputs were checked
in Chrome. This validates the example's source, not the complete app workflow.

The existing workspace screenshot is reused from `docs/shadergrove-preview.jpg`.
It illustrates a project and layout, not the tutorial result. Replace it when the
interface changes. Capture only demo content for public documentation.
