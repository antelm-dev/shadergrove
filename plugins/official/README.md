# Official plugins

Sources of the plugin packages that ship with each Shadergrove release and
appear under **Plugins → Available**. They install and run like any other
package: reviewed, installed switched off, enabled explicitly, and executed in
the isolated plugin Worker. The app has no built-in fallback for what the
Shadertoy, Wallpaper Engine and ISF packages do.

| Folder               | Package id                          | Contributions                                                                                                 |
| -------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `default-themes/`    | `dev.shadergrove.default-themes`    | `theme` `light`, `dark` (pair `default`) — default                                                            |
| `language-en/`       | `dev.shadergrove.language-en`       | `language` `english` (`en`) — default                                                                         |
| `language-fr/`       | `dev.shadergrove.language-fr`       | `language` `french` (`fr`) — default                                                                          |
| `grove-amber/`       | `dev.shadergrove.grove-amber`       | `theme` `amber-light`, `amber-dark` (pair `amber`)                                                            |
| `shadertoy/`         | `dev.shadergrove.shadertoy`         | `projectImporter` (paste, provider `shadertoy-api/v1`)                                                        |
| `wallpaper-engine/`  | `dev.shadergrove.wallpaper-engine`  | `projectExporter` (runtime `wallpaper-web/v1`)                                                                |
| `isf/`               | `dev.shadergrove.isf`               | `importer` / `exporter` `.fs` (one-pass ISF FX, protocol 1)                                                   |
| `project-recipes/`   | `dev.shadergrove.project-recipes`   | `projectTemplate` `raymarching`, `particles`, `feedback-trails`, `interactive-ui` (protocol 4, data; no code) |
| `shader-doctor/`     | `dev.shadergrove.shader-doctor`     | `analyzer` `doctor` (profiles `studio-webgl2/v1`, `wallpaper-web/v1`; protocol 4)                             |
| `texture-utilities/` | `dev.shadergrove.texture-utilities` | `assetTool` `texture-utilities` (workflow `texture-utilities/v1`, image → image; protocol 4)                  |
| `palette-studio/`    | `dev.shadergrove.palette-studio`    | `assetTool` `palette-studio` (workflow `palette-studio/v1`; protocol 4)                                       |

## Default packages

The three packages marked _default_ are data only — no code, GLSL or URL —
and are the app's own list (`DEFAULT_PACKAGE_IDS` in
`libs/shared/src/plugin/defaults.ts`); nothing in a package or the catalogue
can make another package a default. Each profile gets them installed and
**switched on once**, from this release's catalogue (size and hash checked),
the first time it loads; from then on they are ordinary packages: switched
off, removed or reinstalled by the user, and never installed again by the app
(`PluginInstallations` keeps that record beside the packages). The app still
renders without them: the stylesheet's fallback palette and the bundled
English are generated from the same sources.

- `default-themes/manifest.json` is the source of the house Light/Dark
  palette. Its UI colours are also generated into
  `apps/studio/src/default-theme.generated.scss`, the stylesheet's fallback;
  its editor colours must match the built-in Studio Light/Dark editor themes
  (`apps/studio/src/app/themes/default-themes.spec.ts`).
- A language's source `messages` names a root dictionary (`"i18n/fr.json"`),
  which the generator copies in. `i18n/en.json` is also generated into
  `libs/shared/src/i18n/english.generated.ts`, the bundled English. An official
  language must translate every key.

## Layout and build

Each folder holds `manifest.json`, `listing.json` (catalogue-only text: the
description) and, for a package with importers or exporters, `src/index.ts`,
the Worker entry. `release.json` lists the folders this release's catalogue
offers, in order.

```sh
pnpm gen:plugins     # bundle every package and write the catalogue
pnpm check:plugins   # fail if the committed output is not what the sources build
```

The generator (`tools/workspace/src/generate/official-plugins.ts`) bundles
`src/index.ts` with esbuild into one IIFE — no imports, no network, DOM or
dynamic code (it refuses bundles that mention them) — and writes
`<id>-<version>.sgplugin.json` plus `catalogue.json` to
`apps/studio/src/plugins/`, which the app serves as `plugins/…` on the web and
under `shader-studio://bundle/plugins/…` on the desktop (offline). Each
catalogue entry pins its file's size and SHA-256; the app checks both, and the
manifest's id, version, protocol and app range, before the usual review. The
hash is an integrity check, not a publisher signature.

A version is immutable: change the code — or, for a language, its dictionary —
and bump `manifest.version`. Installing a
newer version from the catalogue is an explicit **Update** that leaves the
package switched off until the user enables it again; if the update fails, the
installed version stays.

## Protocol 2 contract

`libs/shared/src/plugin/project.ts` is the source of truth; in short:

- `manifest.protocolVersion: 2`. Protocol 1 packages (effects, file
  importers/exporters, themes) are unchanged and still accepted. Protocol 3
  adds `language` contributions (`libs/shared/src/plugin/languages.ts`) and
  paired themes (theme schema 2, `variantGroup`).
- **`projectImporter`** — `{ kind, id, name, modes: ("paste" | "provider")[],
provider?: "shadertoy-api/v1", maxInputBytes, maxOutputBytes }` (limits up
  to 4 MiB). Method `projectImporter:<id>`, called with
  - `{ mode: "paste", name, text }` — host-rendered form, text ≤ 256 KiB; or
  - `{ mode: "provider", provider, sourceId, source }` — the JSON the host's
    provider fetched (≤ 2 MiB). **No credential is ever sent.**

  It returns a `ProjectCandidate`: `{ name, description, credits: { author?,
sourceUrl? }, project, controls, values, textures, warnings }`. Texture
  bindings in `project` are cleared; textures arrive only as `textures`
  requests `{ asset, uses: [{ passId, channel }], wrap, filter, flipY }`,
  which the host's provider resolves against its own allow-list, slots in
  first-requested order (failed downloads take no slot), and the host
  validates the final bundle before importing it atomically.

- **`projectExporter`** — `{ kind, id, name, runtime: "wallpaper-web/v1",
maxInputBytes, maxOutputBytes }`. Method `projectExporter:<id>`, called with
  a `ProjectExportInput` snapshot of the open draft (unsaved edits included,
  nothing saved): `{ name, author?, project, controls, params, channels,
postProcessingActive }`, where `channels` is texture _metadata_ only. It
  returns `{ data, warnings }`; `data` must satisfy the runtime's schema
  (`libs/shared/src/plugin/wallpaper-web.ts`): every control as a `uniforms`
  entry with its exact value, and the controls Wallpaper Engine can show as
  `properties` that override their uniform. The host runtime alone writes
  executable files and assets.
- Only the adapter ids above resolve (`SOURCE_PROVIDER_IDS`,
  `EXPORT_RUNTIME_IDS`); naming one selects host code and grants the plugin
  nothing. Implementations are registered by the app with
  `provideHostAdapters()` (`apps/studio/src/app/plugins/host-adapters.ts`).
- Every call runs in a fresh Worker, one at a time, with the 10 s timeout and
  real termination of protocol 1. The host captures profile, open shader and
  package id/version/install time when a call starts
  (`PluginInstallations.context`) and refuses the result if any changed;
  disabling, updating or removing a package aborts its pending work.

## Rights

A plugin's licence covers the plugin's code. Content it imports — a Shadertoy
shader, for example — keeps its author's rights and licence; the importer
records the author and source URL with the shader.
