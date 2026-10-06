# Worker 01: Persistent top-bar navigation

## Mission, launch and isolation

Read Phase 4 README and the full roadmap supplied by the coordinator. Keep Editor / Explore / Plugins navigation visible while browsing, preserving mounted editor state and web/desktop platform behavior.

Prerequisites: Phases 1–3 accepted and merged. `default-branch-pr` to `origin/master`, policy `latest-default`; coordinator supplies `EXACT_LAUNCH_BASE=<fetched full master SHA>` containing prerequisites and a readable plan commit. Record the SHA and clean initial status. Re-inspect current prior-phase implementations before choosing layout details.

```text
git worktree add E:/Adel/Documents/Orgs/shader-studio-explore-plugins-p4-01 -b codex/explore-plugins-p4-01-navigation <EXACT_LAUNCH_BASE>
cd E:/Adel/Documents/Orgs/shader-studio-explore-plugins-p4-01
git status --short --branch
```

## Ownership and context

Own the app-shell/navigation boundary: `app.html`, `app.ts`, `app.scss`, shared publication `page.ts`, optional local `ui/layout/app-navigation.ts`, redundant back-to-editor headers in Explore/Plugins, and necessary route-page focus/scroll bindings. This exceeds five primary files because the router outlet, shell stacking/pointer layers, shared page placement and platform chrome must change together. Own adjacent tests, new `apps/studio-e2e/src/app-navigation.spec.ts`, necessary existing E2E helper adaptations and translations. RoutingCoordinator implementation is read-only unless a specific failing acceptance test requires a minimal correction.

## Required work

- Add one labelled nav group in the existing top bar, with links styled as tabs and `aria-current`; avoid an ARIA tablist for routed pages. Web Explore follows capabilities; desktop has Editor/Plugins. Editor targets canonical selection; Explore and Plugins retain their accepted browsing/management context. Current destination click is a no-op.
- Define a page viewport below actual toolbar/desktop-titlebar space. Routed Explore/detail/Plugins/admin content must not cover nav. Preserve desktop sign-in handoff as its standalone surface. Remove redundant Explore/Plugins Back to editor controls, keeping detail-to-Explore return.
- Keep PreviewShell, ShaderStore and editor panel instances mounted. Hide/inert the inactive editor workspace so it cannot receive pointers or keyboard focus; preserve draft/selection/layout. Fix page pointer/scroll/stacking behavior without layering nav above dialogs or breaking native title-bar controls.
- Preserve standalone route and lazy-navigation protection, canonical editor URLs, guard behavior, SSR/startup and Back/Forward. Never track currentNavigation in the coordinator effect or create redirect loops.
- Confirm actual scroll ownership after viewport changes and adjust restoration bindings without changing Phase 2 cache semantics. Provide predictable route focus, visible indicators and a usable 390px layout without horizontal document overflow.
- Preserve output-window isolation, detached preview ownership, zen exit/navigation and desktop fullscreen/titlebar/sign-in behavior as specified in README. Do not change paused preferences or preview scheduling to solve navigation.

Acceptance: **AC-P4-NAV**, **AC-P4-LAYOUT**, **AC-P4-MOUNTED**, **AC-P4-ROUTING**, **AC-P4-RESPONSIVE**, **AC-P4-MODES**. No new routes, side rail, desktop Explore, backend work, renderer performance project or wholesale router/surface refactor.

## Checks and delivery

Run the targeted commands in README. Add meaningful route-state/focus tests and E2E for persistent nav, retained unsaved draft, q/sort/pages/scroll, plugin tabs/use, deep links/reload/back-forward and delayed lazy loading. Preserve earlier tests' intent when changing navigation helpers. Manually inspect desktop titlebar/fullscreen, sign-in handoff, zen/output and built SSR views; mark unavailable evidence explicitly.

Make 1–3 logical commits, review complete diff and report exact base/SHAs, acceptance IDs, commands/exit results and risks. No new flag/migration; rollback reverts presentation. Do not push, open or merge without later authorization.
