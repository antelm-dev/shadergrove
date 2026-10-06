# 04 — Texture Utilities and shared image bridge

Read the supplied coordinator README. Mission: CPU image utilities with a reusable host image bridge for Palette.

Launch: integration-only, integration-tip at **<coordinator-recorded-sha>** after 01 acceptance. Branch `codex/plugin-tools-04`; proposed clean worktree `E:/Adel/Documents/Orgs/shader-studio-plugin-tools-04`.

Own `plugins/official/texture-utilities/`, `apps/studio/src/app/plugins/tools/textures.ts`, `textures-panel.ts`, `textures-image-bridge.ts` plus focused textures-prefixed specs and `apps/studio-e2e/src/plugin-textures.spec.ts`. This narrow image-workflow boundary includes decode/resample/encode/download and guarded assignment; do not edit other panels or shared protocol. Hand over stable bridge exports to 05.

Use 01's typed assetTool call: host selects/decodes images, Worker receives bounded RGBA8 copies and settings, host validates output and encodes/downloads PNG plus metadata. Coalesce ≤256-pixel previews; full jobs stay ≤1024 per dimension/four inputs and obey existing byte/time limits. No GPU bake dependency.

Implement explicit RGBA channel mapping from selected source channels/constants with chosen output dimensions and nearest/linear resampling. Height-to-normal uses documented derivative/strength/orientation conventions, normalization and optional green flip; define repeat/clamp edges and flat-height behavior. Add a host 3×3 tiled preview and boundary-difference indicators, not a promise of seamlessness.

Preserve numeric data values and alpha. Image descriptors/sidecars identify color/data usage and normal/channel conventions. Do not add persisted texture semantics or change current renderer gamma behavior. Return new independent output; never overwrite input files. Explicit Assign selects a destination channel and uses existing texture APIs with guard checks before write; download works without an open shader. Previews/apply/download cannot complete after stale selection or plugin/profile changes.

Implement the image bridge for palette reuse with explicit color decode/resampling and alpha semantics; do not duplicate extraction logic. Publish the accepted API and fixtures before 05 launch. Supply central provider/translation/catalogue fragments to coordinator.

Out of scope: shader baking, EXR/16-bit images, GPU acceleration, asset library, automatic material inference and backend migrations.

Verify AC-TEXTURES and AC-LIFECYCLE with exact channel/constants fixtures, mismatched dimensions, ramp/flat normals, orientation/green flip, edge wrap, alpha and PNG/sidecar round-trips. E2E covers download, explicit assignment and cancellation/stale destination. Run focused textures Angular/E2E, IPC generation and typechecks. Document CPU throughput and quota failures on representative images.

Deliver 1–3 logical commits, exact launch/head SHA, bridge API, paths/checks/captures and desktop gaps. Coordinator integration into develop only; no push/PR/merge.
