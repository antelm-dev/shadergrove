---
type: rule
applies_to: [all]
enforced_by: [convention]
---

# Workspace layout and commands

A self-hosted WebGL shader viewer/editor. pnpm monorepo (`pnpm@10`, Node `^22.22.3 || ^24.15.0 || >=26.0.0`).

## Layout

- `apps/studio` — the application (`@shadergrove/studio`): Angular 22 UI in `src/app/`, Express composition in `src/server/`, and Electron main/preload in `src/desktop/`. Desktop scripts live in `scripts/desktop/`. Angular, server, main and preload retain separate tsconfigs and test runners.
- `apps/studio/src/server/api` — the HTTP API: one Nest module per feature (`system`, `shaders`, `auth`, `publications`, `admin`, `releases`) over `core/`. Mounted by `src/server/index.ts`; API tests run in Node via `vitest.server.config.ts`.
- `libs/backend` — shared backend logic (file storage, project model) used by web/server/desktop.
- `apps/studio/src/desktop/contracts` — plain IPC contracts and generated bridge. See [IPC boundary](ipc-boundary.md).
- `tools/mcp` — MCP server exposing Shadergrove to AI tools (bridges to the running app via `SHADER_STUDIO_MCP_PORT`/`SHADER_STUDIO_MCP_TOKEN`, default port 4310).
- `libs/shared` — types/utilities shared across all packages.
- `tools/maintenance` — one-shot CLI for the PostgreSQL deployment (`migrate-files`, `claim-shaders`), bundled to `dist/shadergrove/cli.mjs` (`@shadergrove/maintenance`).
- `tools/workspace` — repository checks, generators, smoke tests, and automation.
- `examples/shaders/*` — example GLSL shaders (`fragment.glsl` / `vertex.glsl` pairs), not app code.

## Commands

Always run from the repository root with pnpm — never npm or yarn.

- `pnpm dev` — web app dev server (`ng serve`, port 4200).
- `pnpm dev:desktop` — Electron app against the web app (port 4201).
- `pnpm dev:server` / `pnpm dev:mcp` — run the web server (`apps/studio/src/server`) / MCP server via `tsx`.
- `pnpm build`, `pnpm build:desktop`, `pnpm build:mcp` — production builds.
- `pnpm test` — vitest across all packages; `pnpm test:mcp` builds mcp first.
- `pnpm typecheck` — regenerates IPC types then typechecks every package.
- `pnpm lint` / `pnpm lint:fix` — oxlint.
- `pnpm format` / `pnpm format:check` — oxfmt.
- `pnpm check` — i18n, fonts, IPC, plugin and docs consistency checks.
- `pnpm run ci` — the full local gate (`pnpm ci` is pnpm's own install command, not this script).

In `@shadergrove/studio`, `build:renderer` / `dev:renderer` target only the Angular desktop renderer; `build:desktop` / `dev:desktop` include Electron. `test:web`, `test:server`, `test:desktop` and their `typecheck:*` counterparts check each runtime independently. `test` runs Node server and desktop tests before Angular tests.

Use `pnpm --filter <package-name> <script>` to target a single workspace package (e.g. `pnpm --filter @shader-studio/mcp test`).
