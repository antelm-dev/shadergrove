---
type: rule
applies_to: [all]
enforced_by: [review]
---

# Code review priorities

Report only actionable defects introduced by the change. In order of priority:

1. Data loss or corruption — see [persisted state](persisted-state.md).
2. Security or IPC boundary violations — see [boundary validation](boundary-validation.md) and [IPC boundary](ipc-boundary.md).
3. Broken shader rendering or export.
4. Failed builds or tests, runtime crashes.
5. Regressions in the web, desktop, server and MCP surfaces.

Do not report stylistic preferences, refactors, or hypothetical concerns without a concrete failing path. Do not repeat CI, formatter or linter output unless the change alters their configuration or bypasses a required check. Do not request edits to [generated files](generated-files.md); review the source or generator instead.
