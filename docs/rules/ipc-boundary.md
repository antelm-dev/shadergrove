---
type: rule
applies_to: [studio, desktop, server]
enforced_by: [oxlint, check:ipc, review]
---

# Runtime and IPC boundaries

- `apps/studio/src/app/` never imports server or Electron entry points. oxlint's `no-restricted-imports` rejects imports from `src/server` and `src/desktop`.
- The renderer and the Electron main process talk only through typed IPC contracts in `apps/studio/src/desktop/contracts`.
- Only the Electron preload imports the generated bridge (`ipc-bridge.ts`) at runtime. The renderer may import its types only.
- After changing an IPC contract, regenerate the bridge with `pnpm gen:ipc` (`pnpm typecheck` also does it) — never edit it by hand. See [generated files](generated-files.md).
