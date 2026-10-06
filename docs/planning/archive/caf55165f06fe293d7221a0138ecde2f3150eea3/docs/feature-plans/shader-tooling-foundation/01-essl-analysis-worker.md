# Task 01 — Real ESSL analysis in a bounded Worker

Read the supplied coordinator README before implementing.

## Mission and launch

Deliver a private, additive ESSL analysis package with a pinned real frontend, typed declared symbols, reproducible WASM build and real browser Worker evidence. The application does not import it yet.

Base policy: `latest-default`. The coordinator supplies `<EXACT_LAUNCH_SHA>` resolved from fresh `origin/master`; record it. This task has no prerequisite. Do not start from develop or the planning branch.

Branch: `codex/shader-tooling-foundation-01`.
Worktree: `E:/Adel/Documents/Orgs/shader-studio-shader-tooling-foundation-01`.

```text
git worktree add <absolute-sibling-path> -b codex/shader-tooling-foundation-01 <EXACT_LAUNCH_SHA>
cd <absolute-sibling-path>
git status --short --branch
```

## Ownership

Own only the compiler/Worker boundary: new `libs/glsl-analysis/`, `tools/glsl-analysis/`, pinned glslang source/provenance under `third_party/glslang/`, and directly required package/lockfile, Nx/cache, formatter/vendor exclusions, CI and notice wiring. No editor, renderer or Angular asset integration. Keep source wrappers separate from untouched upstream code and documented patches. Test fixtures belong to this boundary.

## Required work

1. Implement the README's request/reply contract using glslang's ESSL validation frontend, without SPIR-V/Vulkan messages. Exercise ESSL 100 and 300 free uniforms and fragment/vertex profiles. Do not use a Vulkan-only prebuilt wrapper as proof of WebGL validation.
2. Serialize frontend diagnostics, declared globals/uniforms and user-function signatures. Report location, overload and reflection limitations; no full AST, raw pointers, invented lexical scope or stale semantic results.
3. Build JS/WASM from pinned sources and toolchain. Add package targets `build:wasm`, `test`, `typecheck`, `smoke:worker`. Record inputs/options/hashes/notices and cache dependencies; build must work from a clean checkout, with no personal SDK path or hidden artifact. Supply a local asset resolver consumed by task 02, without hardcoding web-root/file URLs.
4. Keep frontend execution off the UI thread. Bound input/queue, WASM memory and wall time; host watchdog termination/recreation must cancel a hung synchronous compile. Free native allocations and demonstrate successful analysis after recovery.
5. Evaluate malformed/incomplete sources, macros and scopes against a small documented corpus. Inspect glsl_analyzer's parser/LSP architecture and GPL-3.0/native packaging constraints; record a backend decision in this package's documentation. Do not copy or redistribute glsl_analyzer, build a complete LSP or substitute it for glslang without a revised coordinator decision.
6. Record compressed payload, cold initialization, warm latency and memory observations. Use a real browser Worker smoke to prove compile/results/load failure, not solely mock transport tests.

## Verification and delivery

Meet AC-BUILD, AC-ESSL, AC-SYMBOLS, AC-LIFECYCLE, AC-PROVENANCE using the four package targets above. Include valid/invalid ESSL, incomplete functions/braces, malformed requests, latest-wins and deterministic watchdog recovery. Check direct/transitive licenses and all shipped notices. Keep changes lintable and formatted with repo tools.

Delivery: `default-branch-pr` targeting master. Safe independently because nothing enables or imports the service in the application; rollback removes the additive package. No public compiler protocol or feature flag. This assignment does not authorize push/PR/merge.

Make 1–3 logical commits. Review the full diff against the exact launch SHA. Report commit SHAs, changed paths, contract/capabilities, exact commands and results, real-browser/build evidence, metrics, licensing decision and remaining limitations. Do not mark a native build as WASM evidence.
