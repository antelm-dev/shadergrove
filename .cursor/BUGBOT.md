# Shader Studio Bugbot rules

Shader Studio is a pnpm 10/Nx monorepo for an Angular web application, an Electron desktop shell, an SSR server, and an MCP server.

## Review priorities

Report only actionable defects introduced by the pull request. Prioritize issues that can cause data loss or corruption, security or IPC boundary violations, broken shader rendering or export, failed builds/tests, runtime crashes, or regressions in the web, desktop, server, and MCP surfaces.

Do not report stylistic preferences, refactors, or hypothetical concerns without a concrete failing path. Do not duplicate CI, formatter, or linter output unless the pull request changes their configuration or bypasses a required check.

## Repository invariants

- Use pnpm from the repository root; do not introduce npm or yarn commands.
- Keep the TypeScript strictness guarantees intact: do not accept `any`, unused values, ignored errors, or weakened compiler settings as fixes.
- UI-visible text must be represented in both `i18n/en.json` and `i18n/fr.json` when it is user-facing.
- Treat validation, sanitization, and size limits at application boundaries as safety-critical, especially for shader sources, project files, API payloads, and MCP input.
- Maintain typed IPC boundaries between the Angular renderer and Electron main process. Changes to the IPC contract require regenerating `libs/desktop-api/src/ipc-bridge.ts` with `pnpm gen:ipc`; never edit that generated file directly.
- Preserve compatibility when changing persisted projects, sessions, editor groups, or surface layouts: update schema/version/migration/validation paths together and avoid silently discarding user state.

## Generated and release artifacts

Do not request edits to generated output: `dist/`, `dist-main/`, `dist-web/`, `release/`, or `libs/desktop-api/src/ipc-bridge.ts`. Review the source or generator change instead.

## Relevant checks

The normal quality gates are `pnpm lint`, `pnpm format:check`, `pnpm check`, `pnpm typecheck`, and `pnpm test`. Changes that affect packaging, browser startup, or Electron integration may also require the CI smoke, Docker, or Windows packaging workflows.
