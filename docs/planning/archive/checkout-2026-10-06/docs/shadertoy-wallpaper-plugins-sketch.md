# Shadertoy and Wallpaper Engine as installable plugins

Status: sketch plan, 2026-10-02. Planning only; no implementation is implied.
Repository inspected: `develop`, HEAD `2fff989e13da062fd5f2a895be9d07e97acfe067`.
Recheck the checkout before implementation. This is a complete task outline,
not committed worker instructions or a frozen protocol specification.

## Intended result

The Plugins tab lists **Shadertoy Import** and **Wallpaper Engine Export** in
Available. Each has its own package, version, installation, activation and
removal. Once enabled, its actions are usable directly from Installed.

Shadertoy imports pasted source or a shader by URL/ID with the user's API key.
Wallpaper Engine exports the current shader draft as a usable web wallpaper
project. Both work in the browser and installed desktop app. Disabling one
does not disable the other; removing either leaves existing shaders intact.

Conversion logic belongs to the plugin packages. The host retains ownership of
forms, credentials, network requests, project validation, storage, executable
export templates and destination selection. These are real package-backed
actions, not catalogue cards wrapping the existing built-in commands.

## Current implementation and gaps

| Area                 | Current code                                                                                                        | Required change                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Installed packages   | `apps/studio/src/app/plugins/plugin-installations.ts`, `plugin-store.ts`, `plugins-page.ts`                         | Add available-package discovery and install/update from the catalogue. Preserve explicit enablement and profile isolation.                                                                                               |
| Plugin contract      | `libs/shared/src/plugin/package.ts`, app `plugin-host.ts`                                                           | Existing importers return custom effects; exporters receive one custom effect. Add explicit project contributions rather than silently changing those meanings.                                                          |
| Shadertoy conversion | `libs/shared/src/glsl/shadertoy.ts`, `shadertoy-api.ts`                                                             | Separate pure conversion from fetching and package the conversion for the Worker.                                                                                                                                        |
| Shadertoy UI         | `apps/studio/src/app/ui/dialogs/shadertoy-import-dialog.ts`, `ui/workspace-actions.ts`, `workspace/shader-store.ts` | Move the user entry point to installed plugin actions, preserving paste and API modes and unsaved-work protection.                                                                                                       |
| Shadertoy transport  | `apps/studio/src/server/api/shaders/shaders.controller.ts`, `desktop/main/ipc/shader.ipc.ts`                        | Provide bounded source retrieval to the host without granting plugin network access. Preserve public API compatibility.                                                                                                  |
| Wallpaper export     | `apps/studio/src/app/rendering/wallpaper-export.ts`                                                                 | Currently embeds passes/textures in HTML and installs a property listener. Add validated plugin conversion output and matching `project.json` property definitions. Post-processing is currently omitted with a warning. |
| Wallpaper delivery   | `ui/workspace-actions.ts`, `desktop/main/ipc/files.ipc.ts`                                                          | Browser currently downloads HTML; desktop writes `index.html` in a selected folder. Deliver a full project as browser ZIP / desktop folder.                                                                              |
| Package production   | `tools/workspace/src/generate/isf-plugin.ts`, `fixtures/plugins/isf/`                                               | Establish production package sources and deterministic release generation for the two new plugins. ISF remains compatible.                                                                                               |

The untracked `docs/plugin-adapters-plan.md` is an older, broader draft. It is
context, not evidence of the current implementation, and remains untouched.
Pre-existing untracked `libs/desktop-api/` is outside this sketch's ownership.

## Proposed scope and contracts

- Start with a curated catalogue and package assets distributed with the app.
  No hosted marketplace is needed to make both plugins available.
- Proposed stable identities: `dev.shadergrove.shadertoy` and
  `dev.shadergrove.wallpaper-engine`. Verify these are unused before freezing.
- Add proposed `projectImporter` and `projectExporter` contribution kinds in
  a new protocol version. Continue accepting existing protocol-v1 ISF/effect
  packages. Unknown versions, kinds and fields still fail explicitly.
- Project import output is validated shader data, bounded warnings and optional
  asset references. The host creates/imports the resulting project through the
  existing bundle pipeline. A plugin cannot mutate the workspace itself.
- Project export input is an immutable snapshot of the current draft, controls,
  values and necessary texture data. It contains no unrelated projects,
  preferences, credentials or account data.
- Wallpaper conversion returns typed data for an allowlisted, versioned host
  runtime/template. It cannot supply arbitrary HTML or JavaScript to be copied
  into the export. The host validates data before assembling files.
- Shadertoy source access is a named provider implemented by the host, not a
  generic URL fetch API. API keys never enter plugin messages or package state.
- Freeze input/output schemas, host provider/runtime identifiers and resource
  quotas before dependent package implementation. Names above are proposals.

## Tasks and sequencing

The ownership areas below describe implementation responsibilities, not agents
already launched. Steps within a wave can overlap only after shared interfaces
are agreed. Shared files should have one owner at a time.

### Wave 1: establish the contracts and distribution path

**T1 — Capture existing behavior and freeze the migration baseline.**

- Inventory all UI, HTTP, IPC and automation consumers of the built-in commands.
- Record representative paste/API Shadertoy fixtures: Image, Common, buffers,
  feedback, texture bindings/samplers and unsupported-input warnings.
- Record Wallpaper outputs for controls, multipass/feedback, textures, current
  draft values and the existing post-processing warning.
- Decide which API/IPC callers need compatibility wrappers after UI cutover.
- Verify how Wallpaper Engine handles supplied `project.json` during HTML
  import and reopening an existing project. Documentation alone is not proof
  that it preserves generated property definitions.
- Exit: a parity checklist and fixtures used by T4/T5/T8. Existing failures
  are recorded separately from migration regressions.

**T2 — Add bounded project contribution contracts and runner support.**

- Define versioned manifest fields, source modes (paste/provider), result
  schemas, project export snapshot and supported provider/runtime IDs.
- Add bounded host-rendered text/multiline/credential inputs as appropriate;
  keep credentials outside plugin parameter serialization.
- Extend package parsing, compatibility checks and `PluginHost` dispatch.
- Validate project structure, source lengths, passes, controls, texture
  references, warning lengths and transfer sizes before adoption/output.
- Specify cancellation, one-call-at-a-time execution and behavior when the
  shader, profile, package version or activation changes during a call.
- Measure texture-heavy cases before setting project-specific quotas. Existing
  limits are 8 MiB/file, 24 MiB input and 16 MiB output, while desktop Wallpaper
  delivery permits a larger HTML file. Do not globally raise effect limits or
  silently lose existing supported cases to the narrower Worker limits.
- Ownership: shared plugin schema/specs, plugin host/sandbox call integration.
- Exit: old ISF packages still run; malformed project results, unsupported
  contracts, oversize calls and cancelled calls are rejected without mutation.
- Depends on T1.

**T3 — Create the curated catalogue and deterministic package release path.**

- Introduce production source directories for manifests and Worker conversion
  code, plus a generator/bundler that emits standalone `.sgplugin.json` files.
  Do not leave the only distributable copies in test fixtures.
- Generate a catalogue with package ID/version, description, publisher,
  licence, contributions, compatibility, asset location, byte length and hash.
- Bundle catalogue/assets in web and desktop builds, including installed
  desktop asset resolution and SSR-safe loading. Catalogue browsing executes
  no plugin code. Offline desktop discovery/install uses bundled assets.
- Implement a catalogue service that checks asset bounds, hash and agreement
  between catalogue identity/version and the parsed package manifest.
- Reuse existing review/install/persistence; do not introduce a second store.
  Mark app-distributed provenance from the trusted release catalogue, not from
  a publisher name supplied by a local file. A checksum is not a signature.
- Support explicit replacement when a later app release bundles a newer
  version. Compare versions/compatibility, preserve the old package on failed
  replacement, and require enablement according to the chosen update policy.
- Ownership: generation/build assets, new catalogue service, installation API.
- Exit: deterministic assets, corruption/mismatch rejection, persistent local
  installation, and reliable loading from packaged desktop and browser builds.
- Depends on T2 for final schemas; scaffolding can begin earlier.

### Wave 2: implement the two independently installable packages

**T4 — Extract and package Shadertoy conversion.**

- Move reusable pure paste/JSON conversion into the Shadertoy package source;
  bundle dependencies into the Worker without dynamic imports or DOM use.
- Preserve currently supported Common/Image/buffer/feedback handling,
  mainImage adaptation, uniforms, channel wiring and sampler behavior.
- Define a staged flow: host retrieves bounded source JSON; plugin returns
  project data and asset descriptors; host validates descriptors, retrieves
  approved texture assets and validates the final bundle before importing.
  Asset bindings must remain deterministic across deduplication/failures.
- Implement web-server and desktop-main retrieval for the named provider:
  approved origins/paths, redirect checks, response/content bounds, timeout,
  cancellation, texture decoding and deduplication. No arbitrary proxy or
  plugin-selected network destination, and no secret-bearing error logging.
- Preserve current unsupported-feature and failed-texture warnings; do not
  claim support for sound/cubemap/video/keyboard inputs through migration.
- Retain available author/source credits and distinguish the plugin's licence
  from rights to imported shader code/assets. Verify live API requirements
  before release; inaccessible shaders receive actionable errors.
- Reuse the user's existing key setting in a host-owned form. Changing key
  storage is a separate migration unless needed to keep it out of the Worker.
- Keep legacy HTTP/IPC conversion compatibility using shared conversion
  sources where practical; do not execute untrusted installed package code in
  the server or Electron main process to preserve those endpoints.
- Ownership: Shadertoy package, source provider transport, shared conversion
  extraction and associated transport/fixture tests.
- Exit: genuine installed Worker conversion for both modes; parity fixtures
  pass; credentials and network authority remain with the host.
- Depends on T1–T3.

**T5 — Extract and package Wallpaper Engine conversion.**

- Put project-to-Wallpaper mapping and property metadata conversion in the
  independently versioned Wallpaper package. Keep the executable runtime,
  serialization/escaping and project writer under host control.
- Preserve multipass order, feedback, resolution, filtering, wrapping, texture
  content and snapshot behavior. Preserve explicit post-processing warnings;
  exporting the entire effects chain is outside this migration.
- Generate matching property keys/defaults/types in the typed export data,
  runtime listener and host-produced `project.json`: number, boolean, color
  and choice. Test color representation, numeric precision and key collisions.
- Assemble `index.html`, `project.json` and any required local assets. Keep
  output self-contained; no network dependency for runtime or texture loading.
- Browser: bounded ZIP download. Desktop: selected destination and dedicated
  project folder through validated IPC; constrain file paths and prevent
  silent overwrite of unrelated files. Handle cancellation and incomplete
  writes without reporting success; choose staging/atomic completion behavior.
- Regenerate typed IPC from source contracts if payloads change; do not edit
  generated `ipc-bridge.ts` directly. Validate the project package again at
  the main-process boundary before writing it.
- Provide import/reopen instructions that match T1's verified Wallpaper
  Engine workflow, especially if initial HTML import overwrites metadata.
- Ownership: Wallpaper package, host runtime/project assembly, desktop writer
  and browser archive delivery, with associated export/IPC tests.
- Exit: extracted browser and desktop exports render and expose working
  controls in an actual Wallpaper Engine installation.
- Depends on T1–T3.

### Wave 3: expose actions and complete the cutover

**T6 — Add Available and Installed workflows to the Plugins tab.**

- Show both official packages independently, including description, version,
  publisher, licence, compatibility and contribution capabilities.
- Add Install, installed status and explicit Update when applicable. Preserve
  local-file installation, review, enable/disable, remove and invalid-package
  recovery. Installing must not silently activate or run a package.
- In Installed, show host-rendered Shadertoy paste/API forms and Import action.
  Show Wallpaper Export action against the current shader draft, without the
  existing custom-effect selector. Disable unavailable actions with a reason.
- Route execution by validated contribution/provider/runtime metadata rather
  than hardcoded package-name comparisons. Plugins do not draw their own UI.
- Surface progress, cancel, errors, conversion warnings and successful output.
  Guard dirty-work transitions before adopting Shadertoy imports; export does
  not force a save. Reject results after a profile/project/package change and
  cancel work on disable/remove/navigation where appropriate.
- Add translations, accessible labels, keyboard/focus behavior and responsive
  layouts. Available/Installed can be sections or tabs; avoid unnecessary UI
  framework changes for two entries.
- Ownership: plugins page/action orchestration, host forms, workspace adoption
  and i18n. Coordinate shared installation-service edits with T3.
- Exit: install → enable → run → restart → disable/remove works for each plugin
  independently, on web and desktop.
- Depends on T2–T5; catalogue UI can start after T3.

**T7 — Replace built-in UI entry points and remove duplicate execution paths.**

- Keep old built-in actions during migration behind an explicit development
  cutover mechanism. Public cutover happens only after T8 acceptance.
- Remove the built-in Shadertoy/Wallpaper UI commands and direct execution
  wiring, or retain convenient menu shortcuts that resolve the installed
  contribution. Missing/disabled packages lead to the Plugins tab, with no
  hidden fallback to built-in conversion or automatic installation/activation.
- Remove obsolete app conversion imports/dialog wiring once the plugin UI
  replaces them. Retain host provider/runtime services and shared compatibility
  code required by documented API/IPC consumers identified in T1.
- Keep existing shaders, preferences and local ISF installations usable.
  Document the one-time installation change for previous users and the
  release-level rollback route. Do not broadly delete unrelated shared code.
- Ownership: menu commands/titlebar wiring, workspace actions, obsolete app
  paths and user/plugin-author documentation.
- Exit: running either integration from the app requires its own enabled
  installed package; no duplicate app-facing conversion path remains.
- Depends on T6 and the relevant T8 gates.

**T8 — Validate end-to-end delivery and release the cutover.**

- Run targeted checks throughout each task; this is the integration gate,
  not a request to postpone all testing until the end.
- Prove both packages are present in production catalogue/build assets and
  are downloaded/copied, validated and run through the real plugin host.
- Exercise browser anonymous/account transitions, offline local use, desktop
  restart, independent enablement, removal and explicit package replacement.
- Test Shadertoy paste and deterministic API fixtures, then a bounded live API
  smoke. Compare buffers/Common/feedback/textures/warnings against T1; verify
  rejected/cancelled import never leaves a partially created shader or loses
  the user's unsaved work.
- Test Wallpaper browser ZIP and desktop folder in installed Wallpaper Engine:
  initial/reopened project, numeric/bool/color/choice controls, multipass,
  textures, aspect ratios, offline playback and post-processing warning.
- Exercise malformed provider responses/results, oversized projects/assets,
  unsupported versions, asset path traversal, HTML serialization attacks,
  stale results, cancelled saves and interrupted folder writes.
- Re-run sandbox network/IPC isolation, timeout and actual Worker termination
  evidence in web and installed desktop (`shader-studio://bundle/`). A dev
  browser smoke is not installed-desktop proof.
- Record package/app versions, fixtures, build type and manual external-app
  observations. A missing Wallpaper Engine or live API test remains a named
  release gap, not a passed check.
- Run repository integration commands: `pnpm ci`, `pnpm build:desktop`, and
  the relevant `pnpm e2e` scenarios after locating their current project paths.
  Extend existing `tools/workspace/src/plugin-sandbox-smoke.ts` / smoke harness
  where appropriate. Check generators with `pnpm gen:ipc` / `pnpm check:ipc`.
- Exit: all required automated checks and installed-app scenarios pass;
  release catalogue references exact validated package versions; T7 cutover
  is safe to ship.
- Depends on all delivered slices; validation begins during Waves 1 and 2.

## Delivery boundaries

Catalogue infrastructure can ship early when it contains only supported,
working packages (ISF is an optional seed, not a dependency for this request).
New project contracts, their UI and the two packages should be integrated
together until they provide a usable validated path. Do not publish catalogue
entries for unsupported contributions or advertise an unfinished migration.

T4 and T5 can proceed independently after contracts/provider/runtime boundaries
are frozen. One integration owner manages T2/T3/T6 shared seams and T7/T8 final
cutover. This sketch does not select worker branches or authorize any launch,
push, PR, merge or deployment.

## Release acceptance checklist

- [ ] Both packages are discoverable and independently installable in Plugins.
- [ ] Package conversion actually runs in the isolated Worker.
- [ ] Existing protocol-v1 effect/ISF packages continue to work.
- [ ] Shadertoy paste and URL/ID imports preserve current supported behavior.
- [ ] API keys stay host-side; source retrieval is bounded and provider-specific.
- [ ] Wallpaper exports the current draft without an implicit save.
- [ ] Browser ZIP and desktop folder expose working Wallpaper Engine controls.
- [ ] Disabled, removed, incompatible or changed packages cannot finish actions
      against a stale profile/project context.
- [ ] Failed imports/exports preserve work and do not report partial success.
- [ ] Existing shaders survive package removal and remain self-contained.
- [ ] Installed desktop package assets, sandbox and export behavior are verified.
- [ ] App UI has no independent built-in fallback after cutover; documented
      external API compatibility has an explicit disposition.

## Deferred scope

Hosted registry, third-party submissions, publisher signing/key rotation,
automatic background updates, ratings, payments, new Shadertoy input types,
full post-processing export, Steam Workshop publishing, Wallpaper Engine
installation/remote control and a wider redesign of API-key storage.

If distribution later becomes remote, separately define registry authenticity,
publisher signatures, immutable downloads, revocation and rollback. A hash
served by the same remote package server is not sufficient authentication.

## External references and open verification

- [Wallpaper Engine web-project import](https://docs.wallpaperengine.io/en/web/first/gettingstarted.html):
  HTML import copies project files and creates `project.json`. Verify preservation
  of supplied properties in the installed product before freezing delivery.
- [Wallpaper Engine user properties](https://docs.wallpaperengine.io/en/web/customization/properties.html):
  property types, keys, value representations and listener behavior.
- [Shadertoy documentation](https://www.shadertoy.com/howto): official page could
  not be retrieved during the preceding analysis. API availability, access
  requirements and content rights need current verification during T4/T8.

These links specify external behavior; they do not establish that this
repository already meets the acceptance checklist.
