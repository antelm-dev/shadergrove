# Phase 4: Persistent application navigation

## Milestone and gates

Keep Editor / Explore / Plugins navigation visible in the existing top bar while browsing, preserving the mounted editor and stable routes. Desktop exposes Editor / Plugins. One worker, one wave. Read the [full roadmap](../explore-plugins/README.md); its launch, isolated-worktree, review, remote-action and cleanup rules apply.

Planning ref `codex/plan-explore-plugins`; source inspection base `bc9c705bf312359845c02ac0f81996ce00b69a93`; remote/default `origin/master`. Launch only after Phases 1–3 are accepted and merged; re-inspect their concrete APIs and layouts. Task 01 uses `codex/explore-plugins-p4-01-navigation`, sibling worktree `E:/Adel/Documents/Orgs/shader-studio-explore-plugins-p4-01`, delivery `default-branch-pr`, base policy `latest-default`, intended destination `origin/master`. Coordinator records a full fetched launch SHA containing prerequisites and supplies README/prompt through an exact readable planning ref. Optional review branch: `codex/integrate-explore-plugins-phase4`. No new flag, persistence or route schema.

The current router outlet precedes the shell. `PAGE_STYLES` fixes routed pages at window inset 0/z-index 20, while the shell has its own lower stacking layer and pointer-event rules. The shell includes a conditional Electron title bar, toolbar, drawers and editor panels. `RoutingCoordinator` protects standalone URLs, including a lazy navigation in flight. A small CSS offset alone does not establish a safe content/focus boundary.

## Implementation boundary and acceptance

- **AC-P4-NAV:** Render one persistent navigation group in the existing top bar, styled as tabs but using routed links inside a labelled nav with `aria-current`. Editor targets the current canonical selected-shader URL or `/`; Explore reuses the accepted browsing context; Plugins preserves its latest management tab. Clicking the current destination is a no-op. No second rail, duplicate tab group or new route paths. Web Explore appears only when existing capabilities allow it; desktop has no Explore entry.
- **AC-P4-LAYOUT:** Put Explore/publication/Plugins content in a defined viewport below the toolbar and, on desktop, title bar. Keep page-specific search/title/actions in that viewport and remove redundant back-to-editor controls on Explore/Plugins where persistent navigation replaces them. Preserve the publication-to-Explore return control and Phase 2 state restoration. Measure actual bar space through layout rather than fixed desktop-only pixel guesses. Page content receives pointer events and independently scrolls; overlays/dialogs/menus still layer correctly.
- **AC-P4-MOUNTED:** Keep ShaderStore, PreviewShell and editor panel instances mounted; do not gate them with destructive structural conditions on route changes. Hide the non-active editor workspace from view, pointer hit-testing and keyboard focus using an explicit visibility/inert boundary, while shared navigation stays usable. Route-page switches never discard layout state, shader selection or drafts. Do not modify user paused preference, detached output rendering or window ownership to implement navigation.
- **AC-P4-ROUTING:** Preserve standalone-page recognition for `/explore`, detail URLs, `/plugins`, admin and desktop sign-in handoff, including query strings and pending lazy navigation. Retain `untracked` currentNavigation snapshot semantics. Tab switches, browser back/forward, deep links, startup/SSR and returning to canonical editor URLs cannot redirect-loop or invoke unsaved-transition guards just for browsing. Keep guards for actual shader replacement.
- **AC-P4-RESPONSIVE:** Desktop title-bar controls/drag region stay unobstructed and clickable; account/menu controls remain usable. The navigation adapts at narrow widths without horizontal document overflow or stealing editor width. Hidden editor controls cannot receive focus; route transitions place focus predictably, links have visible focus and page headings remain clear. Validate 390px and 1280px browser viewports plus a real desktop window, including fullscreen.
- **AC-P4-MODES:** Output windows receive only their existing stage behavior; nav never appears there. Zen mode continues to hide the editor shell and offers its existing exit behavior. If navigating to a page while zen is active, exit zen explicitly before showing page/nav; never leave a hidden navigation trap. Keep admin/moderation content functional under the shared page viewport. DesktopConnect sign-in handoff remains a standalone full-page surface without added tab chrome; preserve email auth/reset guards and output routes.

Prefer a small route-derived navigation state helper/component if it clarifies state and enables focused tests. This is not a router or surface-layout rewrite. Existing route recognizers, stores and services remain authorities. Changes to shared PAGE_STYLES must account for admin and detail consumers; scope the new viewport placement so DesktopConnect's own layout is unaffected. Phase 1 host-scroll restoration must still target the element that actually scrolls after the new viewport is introduced.

## Ownership and verification

Task 01 owns one app-shell/navigation boundary: `app.html`, `app.ts`, `app.scss`, public `page.ts`, optional `ui/layout/app-navigation.ts` helper/component, redundant header links in Explore/Plugins, and necessary focus/scroll binding adjustments. This small primary-file exception is required because the current outlet, stacking context, shared page styles and platform chrome must move together. Read RoutingCoordinator and only change its implementation if an acceptance test proves a narrowly scoped need; adjacent coordinator/nav tests and a new `apps/studio-e2e/src/app-navigation.spec.ts` belong to this worker. Update earlier E2Es' navigation helpers only where the removed Back to editor control requires it; do not weaken their assertions. Own necessary translation keys.

Targeted checks:

- `pnpm --filter @shadergrove/studio exec ng test --watch=false --include='src/app/workspace/routing-coordinator.spec.ts' --include='src/app/ui/layout/**/*.spec.ts' --include='src/app/publications/**/*.spec.ts' --include='src/app/plugins/plugins-page.spec.ts'`
- `pnpm --filter @shadergrove/studio typecheck:web`
- `pnpm check:i18n`
- `pnpm gen:ipc`, then `pnpm --filter @shadergrove/studio-e2e exec playwright test src/app-navigation.spec.ts src/explore-navigation.spec.ts src/plugins.spec.ts src/plugin-themes.spec.ts src/shader-switch.spec.ts`

Coordinator aggregate gate: `pnpm lint`, `pnpm format:check`, `pnpm check`, `pnpm typecheck`, `pnpm --filter @shadergrove/studio test:web`, `pnpm build`, `pnpm --filter @shadergrove/studio build:renderer`, `pnpm --filter @shadergrove/studio-e2e typecheck`. Inspect the built SSR app's direct Explore and detail links; manually test desktop title bar/fullscreen and sign-in handoff, zen and output windows. Browser mocks cannot establish these platform checks. Report skipped/manual-unverified scope and do not claim complete desktop validation without it.

Critical E2E: edit an unsaved shader, traverse all available destinations then return to the same editor/draft; retain q/sort/pages/scroll and Plugins tab/use behavior; direct URLs/reload/back-forward during delayed lazy loading; keyboard traversal finds only visible controls; real nav remains visible at 390px/1280px; invalid/off Explore capability does not expose entry points; normal, zen and output mode isolation. Unit tests exercise route classification and capability/profile changes. Preserve native titlebar tests and coordinator regression behavior.

Acceptance and complete diff review are the stopping rule; make 1–3 commits and report base/SHAs, actual check results and risks. Revert shell/presentation changes to roll back; no data migration. Deferred: navigation redesign elsewhere, preview scheduling/performance optimization, desktop Explore/networking, a side rail and wholesale router/surface refactoring.

## Review handoff

```yaml
review_contract:
  milestone: explore-plugins-phase4
  planning_ref: codex/plan-explore-plugins
  source_base: bc9c705bf312359845c02ac0f81996ce00b69a93
  remote: origin
  default_branch: master
  integration_branch: codex/integrate-explore-plugins-phase4
  tasks:
    - id: "01"
      branch: codex/explore-plugins-p4-01-navigation
      depends_on: []
      acceptance: [AC-P4-NAV, AC-P4-LAYOUT, AC-P4-MOUNTED, AC-P4-ROUTING, AC-P4-RESPONSIVE, AC-P4-MODES]
      checks:
        - "pnpm --filter @shadergrove/studio exec ng test --watch=false --include='src/app/workspace/routing-coordinator.spec.ts' --include='src/app/ui/layout/**/*.spec.ts' --include='src/app/publications/**/*.spec.ts' --include='src/app/plugins/plugins-page.spec.ts'"
        - "pnpm --filter @shadergrove/studio typecheck:web"
        - "pnpm check:i18n"
        - "pnpm gen:ipc"
        - "pnpm --filter @shadergrove/studio-e2e exec playwright test src/app-navigation.spec.ts src/explore-navigation.spec.ts src/plugins.spec.ts src/plugin-themes.spec.ts src/shader-switch.spec.ts"
      delivery: default-branch-pr
      base_policy: latest-default
  integration_checks:
    - "pnpm lint"
    - "pnpm format:check"
    - "pnpm check"
    - "pnpm typecheck"
    - "pnpm --filter @shadergrove/studio test:web"
    - "pnpm build"
    - "pnpm --filter @shadergrove/studio build:renderer"
    - "pnpm --filter @shadergrove/studio-e2e typecheck"
  e2e_scenarios:
    - "Unsaved editor survives all routed destinations and both browsing contexts restore"
    - "Direct URLs, reload/back-forward and lazy loading preserve standalone route semantics"
    - "390px/1280px navigation and keyboard focus expose only visible controls"
    - "Desktop title bar/fullscreen, sign-in handoff, zen and output isolation remain functional"
  deferred: [desktop-explore, side-rail, preview-performance, wholesale-router-refactor]
```
