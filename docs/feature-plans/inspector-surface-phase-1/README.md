# Inspector surface — phase 1

## Goal and milestone

Make the Controls/Textures/Presets inspector behave like the contained editor window: it can stay docked on the right, float above the workspace, be moved, resized, minimized, maximized, restored, and closed/reopened. Geometry and the active tab must persist through reload. This is the smallest end-to-end milestone; it deliberately does **not** create a separate Electron `BrowserWindow`.

Planning ref: `codex/plan-inspector-surface`. Give every worker this README and its numbered prompt directly, or make this ref/path readable. Starting source commit: `8825716e62598d5655e7540542986e132f687fb6` (`develop`). The configured default branch is `master`, current `origin/master` at planning time: `2ff95981411655dc7c4c83e32d6cd28623b3ec91`; refresh it before launch. Integration branch (only if required): `codex/integrate-inspector-surface-phase-1`.

### Acceptance criteria

- **AC-FLOAT:** From inspector chrome, users can float the panel; its title bar drags it and all edges resize it within the workspace.
- **AC-DOCK:** The same command menu returns it to the right dock; the dock separator supports pointer and keyboard resize.
- **AC-WINDOW:** Floating inspector can minimize, maximize, restore, reset geometry, close, and reopen without losing its selected tab or controls state.
- **AC-PERSIST:** Placement, dimensions, open state, z-order, and inspector tab survive reload/migration; the legacy preference mirrors stay compatible where the app still reads them.
- **AC-COMPACT:** On narrow screens the inspector remains usable as the existing stacked sheet; no floating chrome or inaccessible panel is introduced.
- **AC-A11Y:** Drag/resize controls retain accessible names and keyboard resizing; focus/pressing the floating panel raises it above other contained surfaces.

### Shared contract and boundaries

The shared surface model already includes `SurfaceKind: 'inspector'`, durable placements, geometry clamping, `SurfaceGeometryGesture`, `projectSurfaceFrame`, and `SurfaceLayoutService`. Phase 1 changes `INSPECTOR_CAPABILITIES.float` from `false` to `true`; it must not widen inspector docking beyond `right`. The worker must add the missing inspector registration/accessors in `SurfaceLayoutService`, use `surface.chrome.tab` as the durable tab source, and replace App’s legacy fixed rail rendering with an inspector host.

The host should follow `EditorShell`/`PreviewShell` conventions: keep `InspectorPanel` instantiated while placement changes, commit geometry only at gesture end, activate through `SurfaceLayoutService`, and project against `.workspace-main` rather than the page. The UI owns contained behavior only. Do not call `externalize()` or add Electron IPC; native detachment needs a satellite route plus shared-state lifecycle and is deferred.

### Work plan

| Wave | Task | Branch / worktree | Delivery | Launch base | Depends on |
| --- | --- | --- | --- | --- | --- |
| 1 | [01-contained-inspector-surface.md](01-contained-inspector-surface.md) | `codex/inspector-surface-01` / sibling `shader-studio-inspector-surface-01` | `default-branch-pr` | `latest-default` | none |

The coordinator resolves `latest-default` to an exact, clean, refreshed `origin/master` commit immediately before creating the worker worktree. This slice is independently deployable: inspector remains docked by default and existing stored layouts migrate safely.

### Verification and review gate

Worker-targeted checks: focused shared-surface tests (capabilities/transitions/migration), `nx run @shader-studio/web:test -- --runInBand` or the project’s supported focused equivalent for new layout/component tests, plus `pnpm check:i18n` if strings change.

Coordinator gate after the worker commits: inspect the complete diff; verify all AC IDs; run `pnpm format:check`, `pnpm typecheck`, `pnpm check`, and targeted web/shared tests. Critical manual/E2E scenarios: docked-to-floating drag and edge resize; float-to-dock; minimize/maximize/restore; reload after each durable state; switching tabs before reload; narrow viewport; inspector and editor z-order interaction. The intended review authorization is: `Review completed tasks and open or merge eligible PRs.` Do not push, open, or merge during execution without that authorization.

Workers must use a clean sibling worktree, preserve unrelated changes, keep scope bounded, make 1–3 logical commits, review the complete diff, and report commit hashes, checks, acceptance evidence, and risks. The coordinator owns conflict resolution and integration verification.

### Deferred, non-executable backlog

- Native Electron inspector detachment into an independently movable OS window, including satellite routing, synchronization, close/return behavior, and native geometry persistence.
- Floating/detachable shader browser and bottom panel.
- Drag-to-dock drop zones or docking to edges other than the inspector’s right-side default.

```yaml
review_contract:
  milestone: inspector-surface-phase-1
  planning_ref: codex/plan-inspector-surface
  source_base: 8825716e62598d5655e7540542986e132f687fb6
  default_branch: master
  integration_branch: codex/integrate-inspector-surface-phase-1
  tasks:
    - id: "01"
      branch: codex/inspector-surface-01
      depends_on: []
      acceptance: [AC-FLOAT, AC-DOCK, AC-WINDOW, AC-PERSIST, AC-COMPACT, AC-A11Y]
      checks: ["focused surface tests", "targeted web tests", "pnpm check:i18n when strings change"]
      delivery: default-branch-pr
      base_policy: latest-default
  integration_checks: ["pnpm format:check", "pnpm typecheck", "pnpm check", "targeted web/shared tests"]
  e2e_scenarios:
    - "Float, drag, resize, and dock the inspector without losing controls state."
    - "Reload after floating, minimized, maximized, and tab-selection changes."
    - "Use the inspector alongside a floating editor and verify foreground activation."
    - "Use a narrow viewport and retain the stacked inspector sheet."
  deferred: ["native Electron inspector window", "other detachable panels", "drag-to-dock drop zones"]
```
