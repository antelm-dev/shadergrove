---
type: rule
applies_to: [all]
enforced_by: [oxfmt, oxlint, tsc, ci]
---

# Code quality

## Formatting and linting

- The formatter is **oxfmt** (`.oxfmtrc.json`: single quotes, 100 print width) — not Prettier. The linter is **oxlint** (`.oxlintrc.json`) — not ESLint.
- 2-space indentation, single quotes in `.ts`, final newline, trimmed trailing whitespace (see `.editorconfig`).

## Strictness

- `noExplicitAny` and `no-unused-vars` are lint errors. The root `tsconfig.json` enables `strict`, `noUnusedLocals`, `noUnusedParameters` and `noImplicitReturns`.
- Fix the underlying issue. Do not accept `any`, unused values, ignored errors, suppression comments or weakened compiler settings as fixes.

## Testing

Vitest is the test runner everywhere. Angular's `test` target uses `@angular/build:unit-test` with the vitest runner, not Karma. `apps/studio` has separate Node configs for API and Electron tests; `tools/mcp` and `libs/shared` have standalone `vitest.config.ts` files.

The quality gates are `pnpm lint`, `pnpm format:check`, `pnpm check`, `pnpm typecheck` and `pnpm test`. Changes that affect packaging, browser startup or Electron integration may also need the CI smoke, Docker or Windows packaging workflows.
