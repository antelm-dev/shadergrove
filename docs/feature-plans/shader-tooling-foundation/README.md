# Shader tooling foundation

Shadergrove should let a user understand why a pixel has its colour. Deliver reliable editor analysis first, GPU inspection second, and a bounded VM debugger third. This plan makes only the first milestone executable.

## Planning and launch context

- Planning ref: `codex/plan-shader-tooling-foundation`.
- Source checkout: `develop` at `de631ea075cc628688c6e79c5659cbd4394eb0d4`.
- Remote: `origin`, https://github.com/antelm-dev/shadergrove.
- Verified GitHub default branch: `master`; observed tip `076b3dcb086da4200f3b261018c7c93dab4c67f5` on 2026-10-06.
- Integration branch: `codex/integrate-shader-tooling-foundation`, initially created from the source SHA above.
- Original checkout: `E:/Adel/Documents/Orgs/shader-studio`. Preserve its existing modified and untracked files.
- Planning worktree: `E:/Adel/Documents/Orgs/shader-studio-plan-shader-tooling-foundation`; temporary, removed after this plan's docs-only commit.

The source checkout is ahead of master by unrelated work. Do not launch workers from the planning branch or include those changes in task 01's independent PR. Resolve and record an immutable source commit at each launch, never just a moving branch name. Fetch and verify the remote default branch before resolving `latest-default`.

Provide this README and the relevant prompt directly to each worker, or supply the readable planning ref and exact path `docs/feature-plans/shader-tooling-foundation/<file>`. Those files will not necessarily exist in the worker's source branch. Planning does not launch workers or authorize remote PR actions.

## Executable milestone

A real, pinned glslang ESSL front end runs in a lazily loaded browser Worker. Monaco shows separate compiler analysis diagnostics, plus typed completion and hover for declared globals and user-function signatures from successfully analysed current source. Existing snippets, builtins, formatting, WebGL diagnostics, rendering and undo history continue to work.

Cover the existing GLSL ES shader conventions, Common, nested includes, vertex and fragment documents, and control-driven uniforms. ESSL validation must work without requesting SPIR-V generation or imposing Vulkan uniform-block requirements. Do not change source versions, precision qualifiers or the rendering backend to make analysis pass.

This is deliberately not a complete language server: scope-sensitive locals, references, rename, definitions and semantic completion inside broken buffers are deferred. An incomplete buffer gets current diagnostics and the existing builtin/snippet fallback; stale user symbols must not masquerade as current.

## Current integration points

- `apps/studio/src/app/editor/monaco-loader.ts`: lazy Monaco, static completions and formatting.
- `apps/studio/src/app/editor/code-editor.ts`: model lifetime, per-document undo/view state, driver markers under owner `shader-studio`.
- `apps/studio/src/app/ui/editor/editor-panel.ts`: active document and project context.
- `apps/studio/src/app/workspace/shader-store.ts`: project, draft, active document and `draftRevision`; consume, do not redesign.
- `libs/shared/src/project/pass-source.ts`: `composePass`, `SourceSpan`, `locate`; reuse Common/include composition and original document IDs.
- `libs/shared/src/glsl/export.ts`: `expandMacros`, uniform types and generated-source conventions. Its export helper is not automatically identical to Three.js's driver prefix.
- `apps/studio/src/app/rendering/engine/pass-compiler.ts` and `shader-probe.ts`: macro expansion, Three.js-generated prefixes, driver diagnostics and preservation of the previous accepted material.
- `apps/studio/angular.json`, `apps/studio/package.json`, `nx.json`, `pnpm-workspace.yaml`: build, desktop assets and cached task inputs.
- `apps/studio-e2e/src/fixtures.ts` and `playwright.config.ts`: signed-in Chromium fixtures, port 4322, isolated SQLite.
- `THIRD_PARTY_NOTICES.md`: existing redistributed-dependency notice inventory.

## Shared internal contract

Task 01 defines a small typed API inside a new private package `@shadergrove/glsl-analysis`, under `libs/glsl-analysis/`, with reproducible tools under `tools/glsl-analysis/`. No general compiler plugin system.

- Requests carry a request ID, session/project identity, project revision, pass/stage identity, source text and explicit ESSL version/profile. The frontend consumes prepared sources; the editor adapter owns composition and mappings.
- Replies repeat the identity and revision, carry status, diagnostics, declared uniform/global symbols and function signatures, and report capabilities. User symbol data is valid only for the exact successfully analysed revision.
- Locations are 1-based compiler source locations. Distinguish generated code from mapped user code. Monaco columns use UTF-16: do not assume native byte offsets or macro-expanded columns map directly.
- No raw AST/native pointers cross the Worker boundary. Serialize only owned values and dispose per-request native allocations.
- Separate `ok`, `invalid-source`, `unsupported-profile`, `unavailable`, and `cancelled`. A runtime failure is not a shader error.
- Requests are latest-wins within a session. Ignore mismatched replies; bound input, queue, wall time and WASM memory. A synchronous compiler cannot process a cancellation message mid-call: use a host watchdog and Worker termination/recreation.
- Only the frontend validates ESSL. Actual WebGL acceptance remains authoritative for rendering; analysis success never commits a shader or replaces accepted materials.
- Analysis markers use a distinct owner such as `shadergrove-glsl-analysis`. Clear only that owner's stale markers. Deduplicate repeated diagnostics from shared includes across pass analyses without losing pass provenance.
- Load JS/WASM assets only after a GLSL editor needs them, never during SSR. Resolve assets locally in production web and packaged Electron. No CDN, source upload, native subprocess, cross-origin isolation or SharedArrayBuffer requirement.
- Task 01 records the selected Emscripten/toolchain revision, source/dependency SHA and artifact hash, build options and license texts; task 02 wires the same artifacts into application builds. No runtime binary downloaded from a floating URL.

Task 01's contract and real Worker smoke gate unlock task 02. Coordinate any contract change before making it; task 02 consumes rather than rewrites the compiler package.

## Acceptance criteria

| ID            | Observable result                                                                                                                                                                                                     | Owner  |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| AC-BUILD      | A clean build produces JS/WASM from pinned inputs; changing wrapper, compiler, toolchain or dependencies invalidates the cache. No pre-existing local binary required.                                                | 01     |
| AC-ESSL       | Real frontend validates representative ESSL 100/300 sources with free uniforms, vectors, functions, arrays, preprocessor directives and both shader stages, without SPIR-V/Vulkan rules. Profile limits are explicit. | 01     |
| AC-SYMBOLS    | Typed declared-global/uniform and user-function data comes from the frontend, with explicit limits for incomplete buffers, overloads and locations. No fabricated scope-sensitive completion.                         | 01, 02 |
| AC-LIFECYCLE  | Rapid requests, a hanging compiler fixture, memory/input limits, cancellation and WASM load failure cannot publish stale results or freeze the editor; a valid request works after Worker recovery.                   | 01, 02 |
| AC-MAPPING    | Errors in Common/nested includes and generated prefixes map to the correct document/line; generated-only or uncertain columns remain honestly unattributed. Project switches cannot cross-contaminate documents.      | 02     |
| AC-EDITOR     | Current diagnostics, user globals and function completion/hover appear in Monaco; invalid input falls back to builtins/snippets without breaking undo, formatting, tab navigation or driver markers.                  | 02     |
| AC-PACKAGING  | No compiler fetch on SSR or non-editor routes; production web and packaged Electron load their local assets on demand and handle missing/corrupt WASM.                                                                | 02     |
| AC-PROVENANCE | Pin and notice all shipped code/dependencies; record the glsl_analyzer evaluation and why it is not implicitly bundled.                                                                                               | 01     |

## Tasks and delivery

| Task | Primary outcome                                                              | Wave | Dependency                               | Branch                               | Delivery          | Base            |
| ---- | ---------------------------------------------------------------------------- | ---- | ---------------------------------------- | ------------------------------------ | ----------------- | --------------- |
| 01   | Pinned ESSL compiler, Worker API, real browser smoke and backend evaluation  | 1    | None                                     | `codex/shader-tooling-foundation-01` | default-branch-pr | latest-default  |
| 02   | Current-project analysis, Monaco integration and local web/desktop packaging | 2    | 01 accepted and available in integration | `codex/shader-tooling-foundation-02` | integration-only  | integration-tip |

Sibling worktree paths: `E:/Adel/Documents/Orgs/shader-studio-shader-tooling-foundation-01` and `E:/Adel/Documents/Orgs/shader-studio-shader-tooling-foundation-02`. Verify paths and branches do not already exist; use a recorded suffix on collision. No worker worktree is created by this planning run.

Task 01 is additive and unused by the application, with its own reproducible checks and private API. It can safely land on master independently. Task 02 initially depends on accepted work in the develop-based integration branch and is not an independent master PR. It needs no feature flag if the bounded behaviour passes the complete integration gate; incomplete behaviour must not be enabled or presented as delivered.

Wave 1 gate: review task 01's full diff, real compiler/browser evidence, license manifest and recovery tests. Resolve the integration tip from the source SHA plus accepted task 01 commits, recording every imported commit. If task 01 has merged to master, fetch and import the relevant merged result; do not equate an open PR with a merged prerequisite. Launch task 02 from the exact resulting integration SHA.

Wave 2 gate: review task 02, integrate accepted commits and run the combined checks below. The coordinator owns conflicts and shared contract decisions; no separate cleanup/test agent. Keep worker worktrees until reviewed evidence is captured. Request remote review actions explicitly, for example: “Review completed tasks and open or merge eligible PRs”; this plan grants no push/open/merge authority.

## Checks and E2E gate

Task 01 introduces executable package targets `build:wasm`, `test`, `typecheck` and `smoke:worker`. Tests must use the actual ESSL frontend, not only a fake response adapter. Its real browser smoke may use a bounded tooling harness before app integration.

Task 02 uses existing commands:

- `pnpm --filter @shadergrove/studio typecheck:web`
- `pnpm --filter @shadergrove/shared test -- src/project/pass-source.spec.ts src/glsl/export.spec.ts`
- `pnpm --filter @shadergrove/studio test:web -- --include "src/app/editor/*analysis*.spec.ts"`
- `pnpm --filter @shadergrove/studio-e2e exec playwright test src/glsl-analysis.spec.ts --project=chromium`

Coordinator aggregate checks, once after integration:

- `pnpm lint`, `pnpm format:check`, `pnpm check`.
- `pnpm nx run @shadergrove/studio:typecheck` and `pnpm nx run @shadergrove/studio:test`.
- The analysis package's build/tests/typecheck/real Worker smoke.
- `pnpm nx run @shadergrove/studio:build`, `pnpm smoke:ssr`, `pnpm nx run @shadergrove/studio:build:renderer`.
- Packaged Electron launch proof using the existing desktop packaging path; a build alone does not prove WASM loading.
- Existing editor highlighting/chrome and shader-switch E2E regressions alongside the new analysis scenarios.

Critical scenarios:

1. Open a valid shader with Common, two nested includes, free uniforms and a user function. Check current symbol completion/hover and analysis diagnostics in the correct documents.
2. Introduce an error in an include; reveal the correct original line. Break the driver compile and confirm the previous valid preview keeps rendering while both diagnostic owners coexist.
3. Type quickly, switch pass/project and delete a document while analysis is pending. Only current-session/current-revision results survive.
4. Remove a brace or end at `foo(`; no Worker crash or stale symbols, builtin/snippet completion remains. Fix the source and recover semantic results.
5. Block or corrupt the WASM response, trigger the watchdog in a controlled fixture, then recover. The UI stays usable and failure is reported as analysis unavailable.
6. Inspect network/asset behaviour before opening the GLSL editor, during SSR, in production web and installed/packaged Electron. Load once on demand, from local assets.

Use actual browser measurements for payload size, cold initialization, warm analysis latency and peak WASM memory on a documented corpus. Record hardware and observations; they do not become universal performance guarantees. Verify targeted command options against the launched checkout and record any command substitution. Environmental failures are not passes.

## Product roadmap and fidelity contracts (deferred, non-executable)

1. **Language tooling** (this milestone; issues [#52](https://github.com/antelm-dev/shadergrove/issues/52), part of [#54](https://github.com/antelm-dev/shadergrove/issues/54)). Evaluate incomplete-buffer quality before choosing a future tolerant semantic parser or LSP layer.
2. **GPU inspector** (extends [#55](https://github.com/antelm-dev/shadergrove/issues/55) and [#56](https://github.com/antelm-dev/shadergrove/issues/56)). Capture immutable accepted program/source, pass inputs, uniforms, sampler state, feedback generation, viewport and coordinates. Instrument original source with verified token/range mapping. Start with a bounded variable/type/observation point, then whole-image variable views and NaN/Inf/domain diagnostics. Define which assignment or loop occurrence is sampled; unreachable/discarded samples are unavailable, never fake zero. Counters estimate control flow, not GPU milliseconds or total GPU instructions.
3. **Single-pixel VM debugger** ([#53](https://github.com/antelm-dev/shadergrove/issues/53), [#57](https://github.com/antelm-dev/shadergrove/issues/57)). Vendor the complete pinned SPIRV-VM core and a narrow C/WASM wrapper. Validate modules independently, then check all instructions, extended instruction sets, capabilities, types and image operations against an audited executable allowlist before running. Resource budgets and Worker recovery are mandatory.
4. **Expressions** ([#58](https://github.com/antelm-dev/shadergrove/issues/58)). Evaluate ShaderExpressionParser and SHADERed's expression compiler/SpvGenTwo adaptation; validate generated SPIR-V with SPIRV-Tools and VM support preflight before watches or conditional breakpoints.
5. **Optional integrations** ([#61](https://github.com/antelm-dev/shadergrove/issues/61)). TypeScript DAP/VS Code, broader image types, audio and Slang/HLSL/WebGPU only after demand and separate compatibility evidence.

GPU instrumentation observes a modified program on the real device; it is not proof of bit-identical internal values in the original executable. Preserve precision, evaluation count, side effects and quad execution. Keep a full compatible viewport/quad for implicit LOD/derivatives even when observing one pixel. Check `EXT_color_buffer_float`, framebuffer completeness and FLOAT readback; capability failure must be explicit. Do not silently quantize arbitrary values into RGBA8 or imply NaN payload preservation.

A glslang `TSourceLoc` is not a universal exact editable span. Macros, preprocessing and lowered nodes need token/source correspondence and refusal when an instrumentation location is ambiguous. No SPIR-V → SPIRV-Cross → ESSL round trip in the initial inspector.

Before trusting a VM pixel, compare its final output with the uninstrumented WebGL reference from the same immutable capture. Compare the same pass/render stage before identical colour-space, tone-mapping, blending and display transformations; document per-channel absolute/relative tolerances and precision classes. Test mediump/lowp, finite/nonfinite cases, texture filtering, implicit LOD and quad derivatives. A mismatch blocks a “verified” replay, shows both colours and delta, and labels the replay untrusted; missing reference, stale capture or unsupported operations give a distinct unverified/unavailable state. A final-colour match is necessary but does not certify every intermediate variable. No silent fallback to stale source or larger tolerances.

OpenGL SPIR-V semantics may avoid Vulkan's free-uniform restriction, but do not assume ESSL 100/300 can directly generate SPIR-V. Compiler target/version, locations and any normalization must be separately tested and mapped; this milestone generates no SPIR-V.

Issue [#59](https://github.com/antelm-dev/shadergrove/issues/59) remains static instruction statistics; [#60](https://github.com/antelm-dev/shadergrove/issues/60) currently tracks VM frame analysis. GPU variable/NaN/control-flow maps are a separate future slice and need tracking updates before execution. Existing issues were not rewritten by this docs-only planning run.

## Upstream decisions and sources

Verified 2026-10-06; these are research observations, not successful port/build evidence.

- [glslang](https://github.com/KhronosGroup/glslang/tree/8ba5ca7cae66a5306a50b6d1db50875c50a5c77a): preferred ESSL validation/AST frontend. Pin this audited SHA or document a reviewed replacement. Audit its multiple license texts and shipped dependencies. HLSL is deprecated; no HLSL frontend in this build. [Source locations](https://github.com/KhronosGroup/glslang/blob/8ba5ca7cae66a5306a50b6d1db50875c50a5c77a/glslang/Include/Common.h) and [AST API](https://github.com/KhronosGroup/glslang/blob/8ba5ca7cae66a5306a50b6d1db50875c50a5c77a/glslang/Include/intermediate.h) motivate the mapping limits.
- [glsl_analyzer](https://github.com/nolanderc/glsl_analyzer/tree/d595fb18c165f9e6c0c99a39dd457b993cfdd9aa): Zig LSP advertises completion, definition, builtin hover and includes. GPL-3.0; upstream documents native executables/stdio/TCP, not a ready browser Worker API. Evaluate architecture and incomplete-buffer behaviour without copying/bundling it. Integration needs a separate reviewed licensing/distribution choice.
- [SPIRV-VM](https://github.com/dfranx/SPIRV-VM/tree/3758fd3a1bf2ea960b9ef3888d20f0d60f2dc98b): future complete MIT snapshot with local tests, patches and update policy. Its silent unsupported-opcode path makes preflight essential.
- [SHADERed](https://github.com/dfranx/SHADERed/tree/780e96791fd8ac48f1f656309211660d78ff9095): debugger and expression behaviour as reference; adapt into TypeScript, do not bring in its native application/UI.
- [Slang v2026.19](https://github.com/shader-slang/slang/releases/tag/v2026.19): official `slang-2026.19-wasm.zip` and `wasm-libs.zip` exist; WASM and WGSL support are labelled experimental in [upstream](https://github.com/shader-slang/slang). Candidate for HLSL/Slang and future WebGPU, not a proven drop-in ESSL frontend. Apache-2.0 with LLVM exception plus dependency notices.
- [WebGL float render targets/readback](https://registry.khronos.org/webgl/extensions/EXT_color_buffer_float/) and [ESSL precision/invariance](https://registry.khronos.org/OpenGL/specs/es/3.0/GLSL_ES_Specification_3.00.pdf) define inspector capability and fidelity limits.

Maintain upstream license files plus the existing THIRD_PARTY_NOTICES inventory; add a NOTICE where required by incorporated upstream notices. Documentation from shadered-docs is CC-BY-4.0 and needs attribution if reused; no upstream prose is copied into this milestone.

Explicit exclusions: C++ export, .sprj adoption, assimp/stb/miniaudio/pugixml/inih/nlohmann-json as new direct dependencies, native geometry/camera systems, SHADERed GPU profiler, PluginRust and PluginGodotShaders. GIF needs an encoder atop existing capture. SPIRV-Cross is optional for later cross-language export and any separately demonstrated need. Cubemap/3D texture debugger support, VM whole-frame heatmaps and all additional languages are deferred. Transitive build dependencies must still be audited even when a library is excluded as a direct feature dependency.

```yaml
review_contract:
  milestone: shader-tooling-foundation
  planning_ref: codex/plan-shader-tooling-foundation
  source_base: 'de631ea075cc628688c6e79c5659cbd4394eb0d4'
  default_branch: master
  integration_branch: codex/integrate-shader-tooling-foundation
  tasks:
    - id: '01'
      branch: codex/shader-tooling-foundation-01
      depends_on: []
      acceptance: [AC-BUILD, AC-ESSL, AC-SYMBOLS, AC-LIFECYCLE, AC-PROVENANCE]
      checks:
        - 'pnpm --filter @shadergrove/glsl-analysis build:wasm'
        - 'pnpm --filter @shadergrove/glsl-analysis test'
        - 'pnpm --filter @shadergrove/glsl-analysis typecheck'
        - 'pnpm --filter @shadergrove/glsl-analysis smoke:worker'
      delivery: default-branch-pr
      base_policy: latest-default
    - id: '02'
      branch: codex/shader-tooling-foundation-02
      depends_on: ['01']
      acceptance: [AC-SYMBOLS, AC-LIFECYCLE, AC-MAPPING, AC-EDITOR, AC-PACKAGING]
      checks:
        - 'pnpm --filter @shadergrove/studio typecheck:web'
        - 'pnpm --filter @shadergrove/studio test:web -- --include "src/app/editor/*analysis*.spec.ts"'
        - 'pnpm --filter @shadergrove/studio-e2e exec playwright test src/glsl-analysis.spec.ts --project=chromium'
      delivery: integration-only
      base_policy: integration-tip
  integration_checks:
    - 'pnpm lint'
    - 'pnpm format:check'
    - 'pnpm check'
    - 'pnpm nx run @shadergrove/studio:typecheck'
    - 'pnpm nx run @shadergrove/studio:test'
    - 'pnpm nx run @shadergrove/studio:build'
    - 'pnpm smoke:ssr'
    - 'pnpm nx run @shadergrove/studio:build:renderer'
    - 'analysis-package-real-worker-smoke'
    - 'packaged-electron-local-wasm-loading'
    - 'editor-and-shader-switch-regression-e2e'
  e2e_scenarios:
    - 'valid composed source exposes current diagnostics and declared symbols'
    - 'include error maps correctly while accepted preview remains visible'
    - 'rapid edits and project switches reject stale results'
    - 'incomplete source preserves builtin completion and recovers'
    - 'missing WASM and watchdog timeout preserve editor usability'
    - 'SSR and production web/Electron load local compiler assets only on demand'
  deferred:
    - 'tolerant parser and full semantic LSP'
    - 'immutable render capture and GPU variable inspector'
    - 'GPU nonfinite maps and approximate control-flow counters'
    - 'SPIR-V normalization, VM support preflight and fidelity-gated pixel debugger'
    - 'expression compiler, watches and conditional breakpoints'
    - 'static statistics and VM whole-frame heatmaps'
    - 'DAP/VSCode, cubemap/3D inspection, audio, GIF encoding'
    - 'Slang/HLSL and WebGPU'
```
