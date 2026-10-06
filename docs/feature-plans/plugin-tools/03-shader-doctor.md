# 03 — Structural Shader Doctor vertical slice

Read the supplied coordinator README. Mission: a read-only target-aware report with honest structural coverage.

Launch: integration-only, integration-tip at **<coordinator-recorded-sha>** after 01 acceptance. Branch `codex/plugin-tools-03`; proposed clean worktree `E:/Adel/Documents/Orgs/shader-studio-plugin-tools-03`.

Own `plugins/official/shader-doctor/`, `apps/studio/src/app/plugins/tools/doctor.ts`, `doctor-panel.ts`, `doctor.spec.ts` and `apps/studio-e2e/src/plugin-doctor.spec.ts`. Host profile helpers can be doctor-prefixed adjacent files. Supply central wiring/translation/catalogue fragments to the coordinator.

Consume analyzer inputs/findings/profile contracts from 01. Host snapshots current unsaved project, controls, effects and texture metadata and stamps source fingerprint plus profile ID/version. Worker emits findings without project mutation.

Check known graph/resource problems: unavailable texture assets, unresolved pass bindings and known unsupported passes/feedback/post-processing in the selected actual host profile. Do not duplicate validation messages as fatal errors or describe every unused empty channel as an error. The renderer intentionally binds a transparent placeholder for an empty channel; report uncertain intent as a warning/unchecked state. Never claim a resource is sampled using a declaration regex.

Provide profiles for the current renderer and current Wallpaper export behavior, derived from or shared with their actual support policy. Profile limitations must match executable adapters. Future Unity/Three.js/Godot profiles remain unavailable until their exporters register real versioned capabilities.

Render report counts, coverage, target/version and actionable descriptions. Navigate to a document/source location only when known and valid; structural issues can navigate to bindings. Keep analyzer diagnostics separate from compiler diagnostics. Re-run explicitly or debounce/coalesce inexpensive structural reports; stale edits/target changes/package/profile switches discard old output. Exporters retain their own mandatory validation.

Resource availability must come from explicit host load outcomes. Loading, unobserved or indeterminate assets remain unchecked; do not download textures just to manufacture a report or treat a settled failed load as success.

Out of scope: AST/parser implementation, semantic/driver/HLSL compilation, regex portability heuristics, automatic fixes, fake target profiles and shader debugger changes. Existing #52/#54 tooling can support a later milestone; no dependency on other task's unmerged worktree.

Verify AC-DOCTOR and AC-LIFECYCLE with supported/unsupported/unchecked fixtures, actual profile-policy comparisons, source location checks, a delayed report arriving after edit/target switch and no compiler-marker loss. Run focused doctor Angular tests, plugin-doctor E2E and relevant typechecks/IPC generation per README.

Deliver 1–3 logical commits, immutable launch/head SHAs, changed paths, rules/coverage, passed/failed/skipped checks and screenshots. Integrate only via coordinator for develop; no push/PR/merge.
