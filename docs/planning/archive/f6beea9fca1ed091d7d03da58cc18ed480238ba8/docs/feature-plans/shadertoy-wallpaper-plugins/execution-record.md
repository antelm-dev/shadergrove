# Execution record — Shadertoy and Wallpaper Engine plugin migration

Plan: `plans/shadertoy-wallpaper-plugins` at `2d3365a3587752a6a9cfa6b605ca85afe094cb10`
(README, `01-foundation.md` … `04-app-cutover.md`). Executed 2026-10-02.

## Bases and branch

- The plan recorded source base `2fff989`. When execution started, `origin/develop` had
  moved to `4fe02d47e068aed7e7f43da5498101e68e66af50` ("release 1.5.0"). Every task was
  built on that commit.
- All four tasks were integrated on one branch, `codex/integrate-external-plugins`,
  created from that `develop` commit. The PR targets `develop`.
- Deviation from the plan's launch policy: a single agent ran the tasks one after another
  in one checkout, with no separate worktrees or worker branches. Each task still has its
  own commits, in the plan's order, and each one's gate was met before the next started.

| Task | Commit(s)            | Acceptance                       |
| ---- | -------------------- | -------------------------------- |
| 01   | `1b11a82`            | AC-CONTRACT, AC-DISTRIBUTION     |
| 02   | `691907d`            | AC-SHADERTOY, AC-ISOLATION       |
| 03   | `cf4c0a4`            | AC-WALLPAPER, AC-OUTPUT          |
| 04   | `cbb52c0` (workflow) | AC-UI, AC-LIFECYCLE              |
| 04   | `ba508c2` (cutover)  | AC-CUTOVER (see gaps)            |
| 04   | `31e9d90` (fix)      | deep-link scroll found in review |

## Interfaces as built

Defined in `plugins/official/README.md` and `libs/shared/src/plugin/project.ts`:

- Protocol 2 manifests (protocol 1 is unchanged and still accepted).
- `projectImporter` contributions: paste mode or provider mode, with provider `shadertoy-api/v1`.
- `projectExporter` contributions: runtime `wallpaper-web/v1`.
- Method names: `projectImporter:<id>` and `projectExporter:<id>`.
- `ProjectCandidate`: textures arrive only as provider-resolved requests.
- `ProjectExportInput`: carries texture metadata only, never the bytes.
- `WallpaperWebData` (`wallpaper-web.ts`).
- The catalogue schema (`catalogue.ts`).
- Quotas (`PROJECT_LIMITS`):
  - declared input and output: up to 4 MiB each
  - pasted text: 256 KiB
  - provider document: 2 MiB
  - 16 texture requests
  - textures: 4 MiB each, fetched and kept by the host

Host adapters are registered with `provideHostAdapters()` in both app configs:

- `ShadertoyApiProvider` handles `shadertoy-api/v1`.
- `WallpaperWebRuntime` handles `wallpaper-web/v1`.

Delivery uses the `ProjectWriter` interface: a stored ZIP in the browser, and on
the desktop a cancellable main-process session (`files.begin-project-folder`,
`write-project-folder`, `cancel-project-folder`).

## Review follow-up (PR #45)

The first review raised four P2 findings, all fixed in one follow-up commit:

- Imports now also refuse their result when the open shader changes (or one opens) mid-call.
- Opening another shader at any point aborts the operation's signal, not only at the next
  check, so a desktop folder write already under way is cancelled in the main process before
  it commits (re-review follow-up).
- Desktop export cancellation reaches the main process. It is checked before every file and
  before the folder is committed, and the context is checked again after the folder dialog.
- `wallpaper-web/v1` data carries a `uniforms` list with every control's exact draft value.
  Wallpaper Engine properties only override those values, so controls past the 64-property
  limit, and values a property could not hold, still render as in the draft. Combo values
  accept any canonical finite number (e.g. `1e-7`), and controls left out of the property
  list are named in a warning.

## Gate evidence (run on `31e9d90` unless noted)

| Check                                                                                            | Result                                                          |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `pnpm run ci` (lint, format, check incl. `check:plugins`, typecheck, test, build:all, smoke:ssr) | pass                                                            |
| `pnpm --dir libs/shared test`                                                                    | 28 files / 500 tests pass                                       |
| `pnpm --dir apps/studio test:web`                                                                | 77 files / 873 tests pass                                       |
| `pnpm --dir apps/studio test:server`                                                             | 9 files / 87 tests pass                                         |
| `pnpm --dir apps/studio test:desktop`                                                            | 9 files / 119 tests pass                                        |
| `pnpm gen:ipc`, `pnpm check:ipc`, `pnpm check:i18n`                                              | pass (730 keys × 2 locales)                                     |
| `pnpm e2e` (all specs, incl. new `plugins.spec.ts`)                                              | 7 / 7 pass, Chromium                                            |
| `pnpm smoke`                                                                                     | pass (incl. plugin sandbox: escapes blocked, Worker terminated) |
| `pnpm build:desktop`, `pnpm pack:desktop`                                                        | pass (Linux `release/linux-unpacked`)                           |

Parity and security fixtures committed with the code:

- **Shadertoy.** `plugins/official/shadertoy/fixtures/multipass.json` covers Common, two
  buffers with feedback, a shared texture with sampler settings, a failed download, a
  keyboard input and a sound pass. Running the installed package plus host resolution
  gives the same passes, channels and warnings as the built-in importer did.
- **Wallpaper Engine.** `plugins/official/wallpaper-engine/fixtures/legacy-passes.json`
  freezes the built-in export's composed fragments. The plugin and runtime reproduce
  them, in the same order.
- **Provider.** Specs cover off-origin and off-path redirects, redirect loops, declared
  and streamed oversize bodies, hostile media paths, and the key absent from every
  error and every Worker request.
- **Desktop writer.** Specs cover numbered siblings instead of overwrites, hostile stems
  and paths, and staged writes that leave nothing behind on failure.
- **Lifecycle.** Specs cover disable, update, removal and sign-in during a call, cancel,
  a declined unsaved-changes prompt, and a shader switch during an export. Each ends
  with nothing adopted or written.

Packaged desktop run (Linux, Xvfb, Playwright `_electron`, fresh user data):

- The app runs at `shader-studio://bundle/`.
- The catalogue lists both packages from the bundled assets.
- Both packages install and switch on.
- A paste import runs in the plugin Worker and creates the shader.
- The Wallpaper Engine export writes `Desktop-Paste/{index.html,project.json}`. A second
  export writes `Desktop-Paste-2`, so nothing is overwritten.
- Both plugins are still installed and switched on after a restart.
- The native folder dialog was stubbed in the main process.
- WebGL is not available under Xvfb, so the preview render is not part of this evidence.

## Named gaps — not passed, not claimed

1. **Real Wallpaper Engine.** No installed Wallpaper Engine was available. Untested:
   importing and reopening the project, the controls, colour and choice defaults,
   feedback and texture rendering, resolution, offline use, and whether Wallpaper Engine
   keeps the supplied `project.json` when it imports the folder. The README states this
   and gives a manual fallback.
2. **Installed Windows desktop.** The desktop evidence above is from a Linux package
   under Xvfb, not the Windows installer the project ships.
3. **Live Shadertoy API.** No API key was available. Coverage comes from deterministic
   fixtures and the app's own provider routes, answered by the e2e test.
4. **The cutover gate.** README wave 3 makes the cutover commit conditional on gaps 1–2.
   The user asked for the plan to be executed through to a PR, so `ba508c2` is included
   as its own commit. To keep the built-in paths until the external evidence exists,
   revert `ba508c2`. The workflow commit `cbb52c0` does not depend on it.

## Environment notes (not part of the change)

The container needed local workarounds:

- Node 24.15 for the Angular CLI.
- esbuild and rollup Linux binaries that pnpm had skipped.
- A mapping of Playwright's expected Chromium revision onto the preinstalled one.
- Verifying the e2e account in the throwaway SQLite store, which the new e2e spec now
  does itself.
