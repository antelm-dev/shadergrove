# 05 — Palette Studio vertical slice

Read the supplied coordinator README. Mission: extract/edit/save palettes and apply a self-contained luminance-mapping effect.

Launch: integration-only, integration-tip at **<coordinator-recorded-sha>** after accepted 01 and 04 commits are reachable from integration. Branch `codex/plugin-tools-05`; proposed clean worktree `E:/Adel/Documents/Orgs/shader-studio-plugin-tools-05`.

Own `plugins/official/palette-studio/`, `apps/studio/src/app/plugins/tools/palette.ts`, `palette-panel.ts`, `palette.spec.ts` and `apps/studio-e2e/src/plugin-palette.spec.ts`. Use 04's frozen image bridge unchanged; request coordinator handling for shared wiring/i18n/catalogue. Do not create a second decoder or protocol.

Host selects an image or manual palette, provides bounded sampled pixels/settings, renders swatches, an ordered editable gradient and an isolated effect preview. Worker provides deterministic 4–8 color extraction with explicit initialization/iteration bounds and alpha filtering/weighting. An extracted palette is unordered; lightness order is only a suggested gradient starting point.

Use documented sRGB decode/linear RGB/Oklab conversions and a deterministic gamut-clipping policy; include known-vector fixtures and original algorithm provenance/license notices. Expose stop ordering/positions and interpolation policy. Export/import versioned bounded JSON that includes original authoring data, so editing does not require reverse-engineering generated GLSL.

Generate an EffectCandidate with bounded stops embedded in GLSL, supported controls (strength plus chosen adjustments) and values. Respect existing effect source/control limits. No LUT texture or extra input sampler. Preview must not modify the draft; Apply revalidates/probes through EffectAdoption and copies the effect only for current session/context. The applied project stays independent of plugin installation, with JSON retained as the authoring source.

Offer extraction/editor/JSON download without a shader; disable preview/Apply until a valid draft/renderer is present. Coalesce previews and discard old responses after image/gradient/source/target/plugin/profile changes. Define duplicate-stop ordering and empty/fully-transparent-image feedback.

Out of scope: private palette library, external LUT assets, online images, arbitrary plugin UI, PBR transforms and new shared schemas.

Verify AC-PALETTE and AC-LIFECYCLE with known extraction/alpha fixtures, reproducibility, interpolation/conversion endpoints, stop-order/JSON round-trip, source/control limits, two effect instances and removal/save/reopen. Run focused palette Angular/E2E, IPC generation and typechecks. Destination captures compare CPU gradient examples and GPU applied effects under explicit color assumptions.

Deliver 1–3 logical commits, exact launch/head SHA, paths/checks, license/provenance notes, captures and manual desktop gaps. Intended develop delivery is coordinator integration only; no push/PR/merge.
