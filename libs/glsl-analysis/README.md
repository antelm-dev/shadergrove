# @shadergrove/glsl-analysis

Private, additive ESSL 1.00 / 3.00 analysis for Shadergrove. A pinned
[glslang](https://github.com/KhronosGroup/glslang) frontend, compiled to WebAssembly,
runs in a bounded browser Worker and returns diagnostics plus declared globals/uniforms
and user-function signatures.

Nothing in `apps/` imports this package. It validates against the ESSL language rules
only: no SPIR-V is generated and no Vulkan/GL-semantics rules are applied (glslang is
built without `ENABLE_SPIRV`, `ENABLE_HLSL` and SPIRV-Tools, and parses with
`EShClientNone` / `EShTargetNone`).

## Use

```ts
import { GlslAnalysisClient, resolveGlslAnalysisAssets } from '@shadergrove/glsl-analysis';

const client = new GlslAnalysisClient({
  assets: resolveGlslAnalysisAssets(new URL('glsl-analysis/', document.baseURI)),
});
const reply = await client.analyze({
  requestId: 'r1',
  sessionId: 'editor-1', // latest request per session wins
  projectId: 'p',
  passId: 'image',
  revision: 3,
  stage: 'fragment',
  profile: { language: 'essl', version: 300 },
  source,
});
```

`resolveGlslAnalysisAssets(baseUrl)` needs an absolute URL; there is no CDN and no
hard-coded web root. Copy `dist/glsl-analysis-worker.js` and `dist/glsl-analysis.wasm`
to wherever the host serves assets (a packaged Electron app can pass its own asset URL).
The Worker fetches the WASM from `wasmUrl` and verifies its SHA-256 before instantiating.

### Reply statuses

| Status                | Meaning                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `ok`                  | Parsed and linked; `symbols` and non-fatal `diagnostics` (warnings) are present.                               |
| `invalid-source`      | glslang rejected the source (compile or link); `diagnostics` hold the errors.                                  |
| `unsupported-profile` | Not `essl` 100/300, or the `#version` in the source disagrees with the request.                                |
| `unavailable`         | `reason`: `load-failed`, `timeout`, `memory-limit`, `input-limit`, `queue-full`, `invalid-request`, `crashed`. |
| `cancelled`           | `reason`: `superseded` (latest-wins), `cancelled`, `disposed`.                                                 |

Types live in `src/contract.ts`.

## Lifecycle and bounds (`DEFAULT_LIMITS`)

| Limit                    | Default | Behaviour on breach                                                 |
| ------------------------ | ------: | ------------------------------------------------------------------- |
| `maxSourceBytes`         | 256 KiB | `unavailable/input-limit` before any compile                        |
| `timeoutMs`              |    3000 | Worker is `terminate()`d and recreated; reply `unavailable/timeout` |
| `initTimeoutMs`          |   20000 | start-up failure -> `unavailable/load-failed`                       |
| `maxMemoryBytes`         | 256 MiB | WASM memory has a hard `maximum`; refused growth -> `memory-limit`  |
| `recycleMemoryBytes`     | 128 MiB | Worker is recycled after the request that grew past it              |
| `maxQueuedSessions`      |      16 | `unavailable/queue-full`                                            |
| `maxConsecutiveFailures` |       3 | client stops respawning and reports `load-failed`                   |

`maxMemoryBytes` must be a positive multiple of 64 KiB and at least the module's compiled
32 MiB floor. A smaller or invalid value is never raised: the Worker refuses to start and
the client replies `unavailable/load-failed`.

One request is in flight at a time. A newer request for the same `sessionId` replaces a
queued one (`cancelled/superseded`). A compile is synchronous inside the Worker, so only
the host watchdog can end a hung one; late messages from a terminated Worker are ignored
(generation counter) and the next request starts a fresh Worker. The client creates the
Worker lazily, so importing it during SSR is safe (it reports `load-failed` when `Worker`
is undefined).

## What it reports, and what it does not

- **Diagnostics**: severity, phase (`compile`/`link`), message, token and
  `location { sourceString, line, column, byteColumn }`. glslang columns are UTF-8 bytes;
  `column` is the UTF-16 column when derivable and `null` when a `#line` remap is present,
  the column is 0, or the source string is not `0`. At most 200 diagnostics are kept.
- **Globals/uniforms**: name, qualifier text per ESSL version/stage, type, array size,
  precision, layout location when declared. Capped at 1024. Built-ins (`gl_*`) are
  omitted; anonymous interface-block members have a `null` block name.
  **Globals carry no declaration location** (glslang does not record one for linkage
  nodes), so `declaration` is always `null`. Struct-only declarations and function
  prototypes without a body are not listed.
- **Functions**: user definitions with parameters, qualifiers, return type and
  `overloadCount`. The location is the _closing paren_ of the prototype, as glslang
  reports it. Capped at 1024.
- **Symbols are only returned for sources that fully compile and link.** There are no
  symbols for an incomplete or erroneous buffer; `invalid-source` carries diagnostics only.
- A source without `#version` is ESSL 1.00 (glslang default). Very deep nesting (~10k)
  yields glslang's "memory exhausted" diagnostic rather than a trap.

## Build

```
pnpm --filter @shadergrove/glsl-analysis build:wasm     # WASM + Worker -> dist/
pnpm --filter @shadergrove/glsl-analysis test           # unit + real-frontend tests
pnpm --filter @shadergrove/glsl-analysis typecheck
pnpm --filter @shadergrove/glsl-analysis smoke:worker   # real Chromium, local assets
```

`build:wasm` (`tools/glsl-analysis/`) needs `git`, Python >= 3.10 (`GLSL_ANALYSIS_PYTHON`
overrides discovery) and network access on a cold cache. It:

1. fetches glslang at the commit in `third_party/glslang/UPSTREAM.json`, materialises only
   the listed paths and records a tree digest;
2. downloads the Emscripten 6.0.11 release archive for `win32-x64` or `linux-x64` pinned by
   URL, size and SHA-256 in `tools/glsl-analysis/toolchain.lock.json`;
3. compiles the 32 listed glslang sources (`-Os -fno-exceptions -fno-rtti`), links the
   Shadergrove wrapper `native/glsl_analysis.cpp` (`FILESYSTEM=0`, `DYNAMIC_EXECUTION=0`,
   32 MiB initial / 1 GiB compiled-maximum memory, 1 MiB stack), and bundles the Worker
   with esbuild;
4. writes `dist/glsl-analysis-assets.json` (hashes, sizes, flags, toolchain, license list).

All caches live in `.tmp/glsl-analysis` (override with `GLSL_ANALYSIS_CACHE_DIR`; ignored
by git, oxfmt and oxlint). The object cache is keyed by the content hash of each source,
its path, flag set, toolchain and the pinned tree digest (which covers every header). The
link key adds the ordered object list, so changing, reordering or emptying
`compiledSources` relinks (a wrapper-only link fails on unresolved symbols) instead of
reusing an older binary. The materialised glslang tree is reused only while its commit and
`paths`/`compiledSources` selection match `UPSTREAM.json`. `pnpm --filter
@shadergrove/glsl-analysis probe:cache` exercises this against the real WASM build. Delete
the directory for a clean build. The Nx `build:wasm` target declares `tools/glsl-analysis`, `third_party/glslang`, the
package sources, `GLSL_ANALYSIS_PYTHON` and the Node version as inputs. Upstream sources are
never patched (`patches: []`).

## Observations (not guarantees)

Machine: Intel i9-10850K, 20 logical cores, 31.9 GiB, Windows 11 (10.0.26200), Node 24.18.0,
Python 3.14.3, headless Chromium 149 via Playwright 1.61.1. Corpus: `test/corpus/`
(`essl100-shadergrove.frag`, `essl100-three-prefix.vert`, `essl300-webgl2.frag`,
`essl300-webgl2.vert`) plus the inline invalid, incomplete, memory and hang cases in
`test/smoke/harness.ts`. Numbers from `.tmp/glsl-analysis/evidence/smoke-worker.json`.

| Metric                                 | Value                                                 |
| -------------------------------------- | ----------------------------------------------------- |
| WASM (raw / gzip / brotli)             | 1,141,291 B / 348,548 B / 274,204 B                   |
| Worker bundle (raw / gzip / brotli)    | 14,092 B / 6,371 B / 5,746 B                          |
| Cold first analysis (local server, br) | 80-107 ms over two runs (start-up 31-52 ms)           |
| Warm analysis                          | median 0.8-0.9 ms, p95 1.5 ms                         |
| WASM linear memory                     | 32 MiB normal; 58,064,896 B for the large-source case |
| Hung compile -> watchdog               | 1008-1009 ms with a 1000 ms limit, then recovers      |
| Main-thread max gap while analysing    | 17.4-17.8 ms                                          |

## Backend decision: glslang, not glsl_analyzer

Evaluated [nolanderc/glsl_analyzer](https://github.com/nolanderc/glsl_analyzer) at
`d595fb18c165f9e6c0c99a39dd457b993cfdd9aa` by reading its sources only (`build.zig`,
`src/main.zig`, `src/parse.zig`, `src/analysis.zig`, `LICENSE.md`, README). Nothing was
copied, built into, or redistributed with this package.

- **Architecture.** A Zig language server (`zig 0.14.0`) speaking LSP over stdin/stdout or
  TCP (`--port`); `build.zig` produces native executables per OS/arch and embeds a
  compressed `spec.json` of built-ins. It offers completion, go-to-definition, hover and
  `#include`. There is no Worker/WASM entry point or browser API; using it in Shadergrove
  would mean shipping and supervising a native process (Electron only, not the web build)
  or porting it.
- **Parser.** A tolerant hand-written parser that keeps going after errors and reports
  syntax diagnostics with positions; useful for editing incomplete buffers. Preprocessor
  directives are kept as ignored tokens: `#define` names become symbols, but macros are
  **not expanded**, `#if` branches are not evaluated, and there is no ESSL 100/300 profile
  or semantic validation (types, qualifiers, precision, built-in availability per version).
  Scope collection exists; only global-scope symbols can be overloaded (a comment in
  `analysis.zig`), and the source has no type checker that could resolve a call to one
  overload.
- **Licensing.** GPL-3.0. Bundling or linking it into the distributed Apache-2.0 app would
  impose GPL terms on the combination; shipping it as a separate executable still needs
  corresponding-source and notice obligations. That is a distribution decision outside this
  task.
- **Decision.** glslang provides the authoritative ESSL 100/300 validation (macro
  expansion, `#version`/extension rules, link checks) that the contract needs and is
  BSD-3-Clause-style licensed. Its costs are listed above: no symbols for broken buffers,
  no global declaration locations, closing-paren function locations (symbols are read
  before linking so uncalled functions are not pruned). glsl_analyzer's strengths
  (tolerant parsing, completion, definition) are not required here; if they are wanted
  later (incomplete-buffer symbols, locations), that needs a separate, reviewed
  licensing/distribution choice. Substituting it for glslang is out of scope.

## Licenses of shipped artifacts

`dist/licenses/` carries the license texts that apply to the WASM and Worker: glslang
(`LICENSE.txt`, byte-identical to upstream), and the Emscripten runtime, libc++, libc++abi,
compiler-rt and musl. `THIRD_PARTY_NOTICES.md` at the repository root lists them with
their licenses; any host that ships `dist/` must keep that directory with the assets.
