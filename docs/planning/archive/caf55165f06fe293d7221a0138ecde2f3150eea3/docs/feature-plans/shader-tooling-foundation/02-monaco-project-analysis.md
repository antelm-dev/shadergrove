# Task 02 — Current-project analysis in Monaco

Read the supplied coordinator README and task 01's accepted API/build report before implementing.

## Mission and launch

Connect the real analysis Worker to current GLSL documents with mapped diagnostics, declared-symbol completion/hover and local web/Electron assets, preserving existing editor and rendering behaviour.

Base policy: `integration-tip`. Start only after task 01 passes review and its accepted commits are reachable from `codex/integrate-shader-tooling-foundation`, seeded from the README source SHA. The coordinator supplies `<EXACT_LAUNCH_SHA>`; record it. Do not assume plan files are on this branch.

Branch: `codex/shader-tooling-foundation-02`.
Worktree: `E:/Adel/Documents/Orgs/shader-studio-shader-tooling-foundation-02`.

```text
git worktree add <absolute-sibling-path> -b codex/shader-tooling-foundation-02 <EXACT_LAUNCH_SHA>
cd <absolute-sibling-path>
git status --short --branch
```

## Ownership and context

Primary ownership: the editor analysis boundary, normally five files:

- new `apps/studio/src/app/editor/glsl-analysis.ts` (project/revision facade);
- new `apps/studio/src/app/editor/monaco-glsl-analysis.ts` (provider/model bridge);
- existing `monaco-loader.ts`, `code-editor.ts`;
- `apps/studio/src/app/ui/editor/editor-panel.ts`.

Own adjacent analysis tests and `apps/studio-e2e/src/glsl-analysis.spec.ts`, plus necessary Angular/studio package/Nx build wiring for task 01's artifacts. Consume `ShaderStore` project/draftRevision, `composePass`/source spans and `expandMacros`; no store/renderer redesign or changes inside the compiler package without agreement.

## Required work

1. Prepare ESSL sources matching the supported studio conventions, including Common/nested includes, stage inputs and generated declarations. Test the wrapper against representative driver-accepted shaders. Do not assume export-helper prefixes equal Three.js prefixes or normalize user precision/version to suppress an analysis error.
2. Map compiler locations through generated sections and composed source to stable original document IDs. Track UTF-16 columns and macro substitution uncertainty. Mark generated-only diagnostics honestly; deduplicate shared-include errors across pass analyses.
3. Associate model identities with project/session, document and source revision. Debounce/reject stale results, clear departed-document analysis, dispose subscriptions on model/editor destruction and avoid duplicated providers across editor instances. Keep undo/view state and the generic editor's existing responsibilities intact.
4. Keep existing driver markers and compile decisions untouched. Use separate analysis marker ownership. Add current declared-global/user-function completion and hover while preserving builtins, snippets and formatting. In incomplete source, show current diagnostics and fallback completion; do not offer stale symbols as current or claim local-scope resolution.
5. Resolve task 01's JS/WASM assets lazily and locally in production web and packaged Electron; wire build prerequisites and artifact cache inputs. SSR and unrelated routes must not instantiate Worker/WASM. Missing/corrupt assets and watchdog failures remain recoverable, separately labelled analysis failures.

Out of scope: full LSP/rename/definition/reference tooling, GPU instrumentation, SPIR-V generation, VM debugging, capture, expressions and new languages.

## Verification and delivery

Meet AC-SYMBOLS, AC-LIFECYCLE, AC-MAPPING, AC-EDITOR, AC-PACKAGING. Run README targeted typecheck/shared-source/editor tests and new Chromium E2E. Include incomplete buffers, project switches during pending replies, nested-include error navigation, failure recovery, markers coexistence, undo and continued accepted-preview rendering. Supply production-web and packaged-Electron local-loading evidence; ask the coordinator to run a missing host-specific check rather than calling it passed.

Delivery: `integration-only` into the named integration branch; not an independent master PR. No runtime dependency may be omitted and no unfinished public feature enabled. No push/PR/merge authority.

Make 1–3 logical commits and review the complete diff against launch SHA. Report commits, paths, exact checks/results, E2E and packaging evidence, source-mapping limits and remaining risks.
