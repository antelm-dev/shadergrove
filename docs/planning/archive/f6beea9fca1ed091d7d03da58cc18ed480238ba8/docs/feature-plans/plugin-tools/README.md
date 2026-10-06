# Plugin tools: executable first versions

## Goal and scope

Deliver four independently versioned official packages: Project Recipes (#86), Shader Doctor (#83), Texture Utilities (#85), and Palette Studio (#84). Each has a complete install → enable → use → save/export → remove path on web and packaged desktop.

This is a comprehensive first-version plan requested for all four tools. The workload exception is **five workers across three waves**, rather than the skill's normal 1–3 workers / two waves. A shared protocol/host boundary precedes three parallel vertical slices; Palette follows the image-tool slice. No separate implementation/testing/documentation agents.

Usable first versions:

- Recipes: four texture-free declarative projects: raymarching, procedural particles, feedback trails, procedural UI.
- Doctor: project/resource checks against registered host capability profiles, with structural coverage explicitly reported.
- Texture Utilities: channel packing, height-to-normal, 3×3 tiling preview; PNG + metadata download and explicit channel assignment.
- Palette: 4–8 color extraction, manual gradient stops, JSON round-trip, live preview, and a copied luminance-mapping effect.

## Repository and launch state

- Source branch: `develop`; source base: `98d6d9aa7c82b9f8226214782dc3a703b84d39d7`.
- Remote: `origin`, `https://github.com/antelm-dev/shadergrove.git`.
- Remote default: `master`; live remote `master` and `develop` both pointed at the source base on 2026-10-06.
- Planning ref: `codex/plan-plugin-tools`; durable directory: `docs/feature-plans/plugin-tools/`.
- Integration branch: `codex/integrate-plugin-tools`; intended review destination: `develop`. Delivery to master is a separate release decision.
- Original checkout: `E:/Adel/Documents/Orgs/shader-studio`. Preserve its modified `docs/staging.md` and all untracked paths.
- Planning-only worktree: `C:/Users/a.terki/.codex/visualizations/2026/10/06/01a1123a-6167-7b10-8365-8318b67a23b5/plugin-tools-plan`; remove it after the verified docs-only commit, retain the branch.
- Existing shader-tooling execution/worker worktrees belong to another task. Do not modify, remove, or depend on their unmerged contents.

At execution, fetch/revalidate the intended target and reconcile drift before creating integration from the recorded source. Resolve every worker's exact SHA from the **accepted integration tip**, not from a moving branch name. Record SHA, branch, worktree, prerequisites and planning commit in the launch ledger. Source checks and command inventory below are planning evidence, not passed implementation checks.

Supply README and the selected prompt directly. Alternatively resolve the planning ref to an immutable commit and provide `git show <plan-commit>:docs/feature-plans/plugin-tools/<file>` contents. Plan documents need not exist in source-based worker checkouts.

## Current integration points

Protocol 3 supports effects, effect/project import/export, themes and languages; none of the proposed kinds exists. Reuse `libs/shared/src/plugin/package.ts` validators and backwards compatibility. Project exporters only accept `wallpaper-web/v1`.

`PluginHost` owns one fresh bounded Worker at a time. `PluginInstallations.context`, `ProjectPluginActions`, and `PluginCommands` already implement active contribution identity and lifecycle guards. Commands must remain contribution-derived, never special-cased by package ID.

`project-import.ts`, bundle validation, `WorkspaceActions` and `ShaderStore.importBundle` are project adoption seams. `ChannelBinding` already supports feedback. Recipe copies must preserve graph references while getting fresh identities.

`EffectAdoption` validates/probes a candidate before copying it into the draft. Effect ABI has input image, UV, time, resolution and declared controls; no extra palette texture is needed for bounded generated gradients.

`TextureService` / `ShaderStore.setTextureImage` already accept PNG/JPEG/WebP through host APIs. There is no standalone asset library. `TextureChannel` has size/sampling/orientation, but no persisted semantic usage field. Keep usage in tool descriptors and downloaded metadata in this milestone; do not silently reinterpret existing stored textures or introduce a database migration.

## Shared contracts (owned by 01)

Add protocol 4 while retaining protocols 1–3 and rejecting unknown fields/versions. Pin the following discriminated contracts; avoid arbitrary plugin UI or a general RPC capability.

**projectTemplate**: declarative contribution with name, description, difficulty, learning notes, provenance and a bounded template payload. Data-only package content is validated as a texture-free project/bundle with controls, defaults and optional presets. No network, assets, lifecycle scripts or parameterized generator. Remap project/pass/file/effect identities consistently when instantiating.

**analyzer**: Worker contribution taking a copied project snapshot, resource metadata, source revision and a host-selected versioned capability profile. Return bounded findings: rule ID, severity, explanation, optional document/source location, confidence/coverage and target version. Invalid source locations are rejected; structural findings can identify a binding rather than fabricate a line.

**assetTool**: Worker contribution declaring a host-owned workflow ID and allowed input/output schema. Initial host workflow IDs are `texture-utilities/v1` and `palette-studio/v1`; packages cannot register components. A registered Angular adapter renders each panel. Inputs are host-decoded RGBA8 planes plus validated operation settings; outputs are discriminated image data, palette data or an existing EffectCandidate. Encode files and assign textures only in host code.

Provide a host adapter registry/session service plus one generic outlet in Installed contribution cards. `PluginCommands` exposes registered active tools through the existing menu/palette pattern, opening `/plugins?use=<packageId>`. Recipes can be offered through the New flow; Doctor requires an open draft, image tools may operate without one. SSR/satellite/output windows must not create Workers or file/GPU sessions.

Bounds for v1: at most four input planes, dimensions ≤1024×1024 each, RGBA byte length exactly width×height×4, ≤16 MiB combined pixel inputs and ≤24 MiB total input. One returned image ≤4 MiB raw pixels; ≤16 MiB aggregate output; metadata ≤64 KiB; ≤100 analyzer findings; palettes ≤8 colors/stops. Preview inputs ≤256×256; explicit full-resolution jobs use the same selected inputs. Retain existing package/effect/control limits and 10-second Worker termination. Count transferred bytes as bytes, including typed-array views, rather than relying only on JSON length. Quotas are not native memory/GPU guarantees.

Lifecycle: capture profile + package/version/install generation, selected project when relevant, source fingerprint, target profile, inputs and monotone request generation. Coalesce preview jobs, cancel superseded jobs, validate before displaying results and again before apply/assign/write. Never transfer the preview's only input buffer; copy/retain it. Plugin changes invalidate pending results immediately. Project edits invalidate project-derived results; independent file operations remain independent until an explicitly targeted assignment.

Output image descriptor includes dimensions, orientation, alpha mode and `usage: color | data`. Packing/normal maps preserve numeric values. Host decoding/resampling/PNG encoding must have explicit color handling. Download a sidecar documenting usage and channel/normal conventions; assigning to current texture slots preserves the current raw sampling path and carries no new implicit gamma conversion. Persisted usage/backend migrations are deferred.

## Ownership and sequencing

| ID  | Wave | Outcome / prompt                                                | Dependencies | Branch                | Delivery / base                    |
| --- | ---- | --------------------------------------------------------------- | ------------ | --------------------- | ---------------------------------- |
| 01  | 1    | Shared contracts and host execution seam / 01-host-contracts.md | —            | codex/plugin-tools-01 | integration-only / integration-tip |
| 02  | 2    | Recipes vertical slice / 02-project-recipes.md                  | 01           | codex/plugin-tools-02 | integration-only / integration-tip |
| 03  | 2    | Structural Doctor vertical slice / 03-shader-doctor.md          | 01           | codex/plugin-tools-03 | integration-only / integration-tip |
| 04  | 2    | Texture Utilities and image bridge / 04-texture-utilities.md    | 01           | codex/plugin-tools-04 | integration-only / integration-tip |
| 05  | 3    | Palette vertical slice / 05-palette-studio.md                   | 01, 04       | codex/plugin-tools-05 | integration-only / integration-tip |

Proposed sibling worker paths: `E:/Adel/Documents/Orgs/shader-studio-plugin-tools-01` through `-05`. Create only during execution and only from recorded immutable bases.

01 owns central protocol/host dispatch/generator edits. 02–05 own their named feature modules, official package folder and separate specs/E2E file. 04 owns the reusable host image bridge consumed unchanged by 05. Workers may add collocated tests. They must request coordinator integration edits instead of changing another worker's ownership.

Coordinator exclusively owns final `app.config.ts` provider registration, all shared menu/New-dialog/Installed-outlet wiring after 01, `plugins/official/release.json`, shared i18n dictionaries/keys and generated aggregate outputs. Workers hand over registration snippets, translation fragments and catalogue entries. Coordinator resolves those mechanical edits on integration, runs generation, and makes a bounded integration commit. No separate integration worker is needed.

Wave 1 gate: protocol compatibility and malformed/binary/stale-call tests pass; frozen adapters/types and working test fixtures exist. Do not list incomplete official tools yet. All tasks remain integration-only because the public protocol and host registries must be accepted together.

Wave 2 gate: Recipes, Doctor and Texture Utilities satisfy their acceptance IDs; integrate 04 before launching 05. Coordinate the exact shared image API (decode/resample/preview/encode/assign) and the palette output validator in 01; 05 must not require a new shared schema midway.

Wave 3 gate: Palette completes; all four providers and packages are registered; final catalogue generation plus full acceptance and desktop checks pass. Only then consider a PR to develop. The milestone ships all four tools together; earlier workers do not open independent default-branch PRs.

## Acceptance and review gates

- **AC-CONTRACT**: malformed/version-incompatible packages and outputs rejected; old packages unchanged; byte accounting, timeout and real termination tested.
- **AC-LIFECYCLE**: menu/palette/cards reflect active registered contributions; disabling/updating/removing/profile switch or stale source prevents display/adoption/delivery; no input detachment surprises.
- **AC-RECIPES**: four recipes create independent compiling projects; fresh IDs preserve feedback graph; rename/cancel/unsaved-draft behavior is atomic; save/bundle round-trip and package removal preserve content.
- **AC-DOCTOR**: checks distinguish known unsupported, warning and unchecked; dangling/unavailable resources and actual profile limitations reported; target version/coverage visible; findings navigate correctly and do not overwrite compiler diagnostics.
- **AC-TEXTURES**: packing exact RGBA values, constants, output-size/resampling policy, normal orientation/flat-height fixture, alpha and data handling verified; 3×3 tiling/seam indicators work; PNG/sidecar round-trip and explicit assignment do not overwrite inputs.
- **AC-PALETTE**: deterministic alpha-aware extraction, gradient order/interpolation/color conversions and gamut policy verified; JSON round-trip; effect preview/apply obeys existing limits and preserves copied effect after removal.
- **AC-E2E**: authenticated web workflows below, current plugin regressions and SSR fallback pass.
- **AC-DESKTOP**: installed/offline desktop exercises all four tools, picker/download/assignment and hostile Worker termination; satellite/output windows stay inert. Report manual evidence separately from build/source tests.

Critical E2E:

1. Install each package off → enable → menu action → correct Installed panel; disable/remove hides commands.
2. Instantiate feedback recipe twice; cancel a New/import flow with an unsaved draft; save/reopen/export bundle after removal.
3. Doctor changes target; missing assigned texture warning and unsupported profile fixture; edit/change draft while a delayed report runs.
4. Pack four selected small images, inspect raw channels and download; generate normals from flat/ramp heights, flip green, assign only to explicitly selected channel.
5. Extract palette from alpha-containing image, reorder stops, import/export JSON, apply effect twice, remove pack and reopen shader.
6. Disable/update/change profile during analysis, preview and destination delivery; no stale UI/result/disk write.
7. Reload offline packaged desktop; run each panel and verify independent saved outputs; SSR and output/satellite windows render without browser-only initialization.

## Checks and commands

Run from worker root unless a package filter is given; shell invocation may quote glob arguments. Generate IPC before Angular checks.

Targeted commands:

- `pnpm gen:ipc`
- `pnpm --filter @shadergrove/shared exec vitest run src/plugin/package.spec.ts src/plugin/tools.spec.ts` (new tools spec owned by 01).
- `pnpm --filter @shadergrove/studio exec ng test --watch=false --include 'src/app/plugins/plugin-host*.spec.ts' --include 'src/app/plugins/plugin-tools*.spec.ts'` (01).
- `pnpm --filter @shadergrove/studio exec ng test --watch=false --include 'src/app/plugins/tools/<feature>*.spec.ts'` (02–05: recipes, doctor, textures, palette).
- `pnpm --filter @shadergrove/studio-e2e exec playwright test src/plugin-<feature>.spec.ts` after IPC generation (new files per feature).
- `pnpm --filter @shadergrove/shared typecheck`; `pnpm --filter @shadergrove/studio typecheck:web`.
- `pnpm gen:plugins`; `pnpm check:plugins` after coordinator catalogue assembly.

Coordinator checks: `pnpm lint`, `pnpm format:check`, `pnpm check`, `pnpm typecheck`, `pnpm test`, `pnpm build:all`, `pnpm e2e`, `pnpm smoke:ssr`, `pnpm build:desktop` and `pnpm pack:desktop`, followed by installed-desktop manual evidence. E2E config uses port 4322, one worker and a throwaway SQLite store with DATABASE_URL cleared. Do not point fixtures at staging/production. Existing web test runner is Angular's ng test; there is no Studio vitest.config.ts.

For Windows/Nx environment failures, distinguish infrastructure from code; record the exact error and use `NX_NO_CLOUD=true`, `NX_DAEMON=false` where appropriate. Do not repeat broad tests after a green gate without new changes.

Each worker: 1–3 logical commits; report exact launch SHA, head SHA, changed paths, acceptance IDs, passed/failed/skipped checks, screenshots/pixel fixtures and limitations. Review the complete diff before handoff. Coordinator retains worktrees until evidence is accepted; planning cleanup does not authorize worker cleanup.

No push, PR creation or merge is authorized by this plan. A later instruction such as “Review completed tasks and open or merge eligible PRs to develop” is needed for those remote actions.

## Deferred backlog

Semantic/AST Doctor rules and source transpilation; fake future exporter profiles; automatic fixes; external image/recipe assets; standalone asset/palette libraries; persisted texture usage migration; GPU bake/acceleration; EXR/16-bit processing; arbitrary plugin DOM; remote template stores/community submissions; parameterized generators; unrestricted pack dependencies. Texture Utilities does **not** depend on Texture Baking issue #78.

## Machine-readable handoff

```yaml
review_contract:
  milestone: plugin-tools-v1
  planning_ref: codex/plan-plugin-tools
  source_base: '98d6d9aa7c82b9f8226214782dc3a703b84d39d7'
  default_branch: master
  integration_branch: codex/integrate-plugin-tools
  tasks:
    - id: '01'
      branch: codex/plugin-tools-01
      depends_on: []
      acceptance: [AC-CONTRACT, AC-LIFECYCLE]
      checks:
        [
          'pnpm --filter @shadergrove/shared exec vitest run src/plugin/package.spec.ts src/plugin/tools.spec.ts',
          "pnpm --filter @shadergrove/studio exec ng test --watch=false --include 'src/app/plugins/plugin-host*.spec.ts' --include 'src/app/plugins/plugin-tools*.spec.ts'",
        ]
      delivery: integration-only
      base_policy: integration-tip
    - id: '02'
      branch: codex/plugin-tools-02
      depends_on: ['01']
      acceptance: [AC-RECIPES, AC-LIFECYCLE]
      checks:
        [
          "pnpm --filter @shadergrove/studio exec ng test --watch=false --include 'src/app/plugins/tools/recipes*.spec.ts'",
          'pnpm --filter @shadergrove/studio-e2e exec playwright test src/plugin-recipes.spec.ts',
        ]
      delivery: integration-only
      base_policy: integration-tip
    - id: '03'
      branch: codex/plugin-tools-03
      depends_on: ['01']
      acceptance: [AC-DOCTOR, AC-LIFECYCLE]
      checks:
        [
          "pnpm --filter @shadergrove/studio exec ng test --watch=false --include 'src/app/plugins/tools/doctor*.spec.ts'",
          'pnpm --filter @shadergrove/studio-e2e exec playwright test src/plugin-doctor.spec.ts',
        ]
      delivery: integration-only
      base_policy: integration-tip
    - id: '04'
      branch: codex/plugin-tools-04
      depends_on: ['01']
      acceptance: [AC-TEXTURES, AC-LIFECYCLE]
      checks:
        [
          "pnpm --filter @shadergrove/studio exec ng test --watch=false --include 'src/app/plugins/tools/textures*.spec.ts'",
          'pnpm --filter @shadergrove/studio-e2e exec playwright test src/plugin-textures.spec.ts',
        ]
      delivery: integration-only
      base_policy: integration-tip
    - id: '05'
      branch: codex/plugin-tools-05
      depends_on: ['01', '04']
      acceptance: [AC-PALETTE, AC-LIFECYCLE]
      checks:
        [
          "pnpm --filter @shadergrove/studio exec ng test --watch=false --include 'src/app/plugins/tools/palette*.spec.ts'",
          'pnpm --filter @shadergrove/studio-e2e exec playwright test src/plugin-palette.spec.ts',
        ]
      delivery: integration-only
      base_policy: integration-tip
  integration_checks:
    [
      'pnpm lint',
      'pnpm format:check',
      'pnpm check',
      'pnpm typecheck',
      'pnpm test',
      'pnpm build:all',
      'pnpm e2e',
      'pnpm smoke:ssr',
      'pnpm build:desktop',
      'pnpm pack:desktop',
    ]
  e2e_scenarios:
    - 'active contribution menus and Installed cards'
    - 'independent feedback recipes and unsaved-draft cancellation'
    - 'versioned Doctor reports and stale-source rejection'
    - 'exact channel packing, normal generation, PNG delivery and explicit assignment'
    - 'palette extraction, JSON round-trip, copied effect after uninstall'
    - 'profile/package changes during preview and delivery'
    - 'installed offline desktop and inert SSR/satellite/output windows'
  deferred:
    [
      'semantic Doctor',
      'GPU baking',
      'external recipe assets',
      'asset libraries',
      'persisted texture usage migration',
    ]
```
