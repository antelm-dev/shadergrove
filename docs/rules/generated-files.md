---
type: rule
applies_to: [all]
enforced_by: [check:ipc, review]
---

# Generated files

Never edit generated output directly. Change the source or the generator and regenerate.

| Output                                            | Regenerate with                                                 |
| ------------------------------------------------- | --------------------------------------------------------------- |
| `dist/`, `dist-main/`, `dist-web/`, `release/`    | the matching `pnpm build*` / `pnpm pack*` / `pnpm dist*` script |
| `apps/studio/src/desktop/contracts/ipc-bridge.ts` | `pnpm gen:ipc`                                                  |

The IPC bridge is not committed (it is in `.gitignore`). `pnpm check:ipc` regenerates it and fails when a module under `apps/studio/src/desktop/main/ipc` is missing from the result or when generation is not stable.
