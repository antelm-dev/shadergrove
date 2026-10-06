# Studio Visual Refresh — Milestone 1

## Goal and milestone

Give Shader Studio its own look: a compact creative tool with quiet chrome, precise controls, and the shader as the visual focus. Material stays underneath as the implementation layer. The goal is to change the **appearance**, not to leave Material.

Milestone 1 is the **global styling experiment**. It changes only global theme inputs and the font assets, so the whole app changes at once without editing individual components. It is complete when:

1. the UI and icon fonts are self-hosted (Inter, Material Symbols) and render with no network access;
2. Material's public system tokens give neutral surfaces, text, corners and a cyan accent in both themes;
3. desktop controls use density `-2`, while touch layouts keep today's target sizes;
4. the product owner has reviewed the representative slice in both themes, over a bright and a dark shader, and decided which component changes come next.

### Decisions (agreed with the product owner)

- **No parallel `--studio-*` token vocabulary.** The 36 files that use `--mat-sys-*` keep those references. Values change through `mat.theme` and `mat.theme-overrides`, and component `*-overrides` mixins where needed. An app-specific `--studio-*` token is added only when a concrete requirement has no Material equivalent (for example a focus-ring width, or the translucent workspace surface).
- Global styling stays in `apps/web/src/styles.scss`. Don't split it into partials.
- UI font: self-hosted **Inter**. Icons: self-hosted **Material Symbols** (Outlined), as a first experiment to be judged in review. **Cyan stays** as the accent for now, so the review isolates typography, surfaces, density and icons.
- Menus and dialogs are more opaque than docked panels, so they stay readable over bright or animated shaders. The translucent workspace (`backdrop-filter: blur(18px)` panels) is kept.
- The Monaco editor theme stays independent (the user chooses it).

### Non-goals for this milestone

Replacing any Material component (inspector tabs, search field), editing component templates beyond icon-name fixes, a new accent colour, an SVG icon set, monospace value styling, removing existing `.mat-mdc-*` / `::ng-deep` rules, and the area-by-area rollout. See the deferred backlog.

## Planning and launch context

- Planning ref: `codex/plan-studio-visual-refresh`
- Plan path: `docs/feature-plans/studio-visual-refresh-m1/`
- Source base used for planning: `6bd6aaab0c04bd38a649958dd8e8ffbb226c08a0` (`develop`)
- Default branch: `master`. **PR target: `develop`**, which is 36 commits ahead of `master` and is where feature PRs land (for example PR #22).
- Remote: `origin` (`https://github.com/antelm-dev/shader-studio.git`)
- Integration branch: none. Both tasks are safe to merge alone.

Give each worker this README and its numbered prompt directly, or the planning ref plus both paths. A source branch does not contain these plan files. At launch, replace `<exact-launch-base>` with the SHA of `develop` recorded at that moment.

## Facts established during planning

- `apps/web/src/styles.scss` calls `mat.theme` on `html` with `typography: Roboto`, `density: 0`, cyan primary and magenta tertiary palettes, and custom corner tokens. Overlays (menus, dialogs) are inside `html`, so they get the same tokens.
- `apps/web/src/index.html` loads **Roboto** and the legacy **Material Icons** font (not Symbols) from Google Fonts. Its CSP allows `fonts.googleapis.com` / `fonts.gstatic.com`.
- **The CSP entries for Google Fonts must stay.** `apps/web/src/app/editor/google-fonts.ts` loads editor fonts from Google at runtime for the font picker. "Offline" in this plan covers the **UI and icon fonts only**.
- Menus have **no density tokens** in Material 22.0.4 (`menu/_m3-menu.scss` returns `density: ()`). Density `-2` also removes the expanded touch targets on buttons.
- `*-window-controls.ts` set `--mat-icon-button-state-layer-size: 28px` and `--mat-icon-button-icon-size: 16px` explicitly. Density does not change these; leave them.
- `inspector-panel.ts` relies on `[preserveContent]="true"` so that lil-gui and textures are not torn down on tab switch. Don't touch it in this milestone.
- 41 `mat-icon` elements bind their icon name dynamically (`{{ … }}`); names also come from TypeScript strings. An icon audit must cover both.
- Touch/narrow layouts: `app.ts` observes CDK `Breakpoints.Handset`/`TabletPortrait`, and `app.scss` has `max-width` media and container queries.
- The initial bundle budget is 2.0 MB (warning) / 2.2 MB (error). Font files must be emitted as separate assets, never inlined as `data:` URIs.
- `pnpm smoke` (Playwright, `tools/workspace/src/smoke.ts`) serves the web app and drives it in Chromium. It is the natural place for offline font checks.

## Shared contracts

**C1 — Font ownership (Task 01).** Task 01 owns, in `styles.scss`: the `typography:` value inside `mat.theme`, any `@font-face`/font `@use`, the lil-gui `--font-family` line, and the icon-related menu rules and their comment (`.mat-mdc-menu-item mat-icon.*`, `.theme-check`). It also owns `index.html`, `angular.json`, `app.config*.ts`, `package.json`/`pnpm-lock.yaml` and `THIRD_PARTY_NOTICES.md`.

**C2 — Theme ownership (Task 02).** Task 02 owns everything else in `styles.scss` (palette, `theme-overrides`, density, component overrides, lil-gui colour variables, `body`) and `apps/web/src/app/app.scss`. If a panel shell's inline styles cannot be reached with a token, Task 02 may edit that shell's `styles:` block, and must record each such file in its report.

**C3 — Icon font class.** Material Symbols is registered as `MatIcon`'s default font set class, so `<mat-icon>name</mat-icon>` keeps working without template changes. Icon names that do not exist in Symbols are renamed at their call sites (templates or TS strings). That is the only exception to "no component edits".

## Acceptance criteria

- **AC-FONT-01** `index.html` no longer links Google stylesheets for Roboto or Material Icons. UI text renders in Inter and icons in Material Symbols, both served from the app's own origin.
- **AC-FONT-02** Every icon name in use, static or dynamic, renders a glyph. No ligature text (for example "check") is visible anywhere, including menus, dialogs and the desktop titlebar.
- **AC-FONT-03** In a fresh browser context (no cache) where every non-local request is blocked, the UI and icon fonts still load. The desktop build behaves the same way with a fresh `userData` and no network.
- **AC-FONT-04** lil-gui controls use Inter. `THIRD_PARTY_NOTICES.md` lists Inter (OFL-1.1) and Material Symbols (Apache-2.0).
- **AC-THEME-01** Dark mode uses neutral graphite surfaces and light mode uses pale neutral surfaces, set only through `mat.theme` / `mat.theme-overrides` / component `*-overrides`. No new `.mat-mdc-*` or `::ng-deep` selectors are added.
- **AC-THEME-02** Cyan remains the accent for selection, focus and primary actions. Keyboard focus is visible on buttons, menu items, tabs and inputs in both themes.
- **AC-THEME-03** Density `-2` applies to desktop controls. On touch/narrow layouts, interactive targets are not smaller than they are today.
- **AC-THEME-04** Menus and dialogs are opaque enough to read over a bright animated shader. Docked panels keep their translucency. lil-gui colours follow the theme in both schemes.
- **AC-BEH-01** No regressions: inspector tab content survives tab switches, titlebar buttons stay clickable inside the drag region, and docking, resizing and maximising behave as before.

## Tasks and delivery

| ID | Primary outcome | Depends on | Branch / sibling worktree | Delivery | Base policy |
| --- | --- | --- | --- | --- | --- |
| 01 | Self-hosted Inter + Material Symbols, typography, icon audit | — | `codex/studio-look-01` / `shader-studio-wt-studio-look-01` | `default-branch-pr` → `develop` | `latest-default` |
| 02 | Neutral theme overrides, density, overlay opacity, lil-gui colours | — (merges after 01) | `codex/studio-look-02` / `shader-studio-wt-studio-look-02` | `default-branch-pr` → `develop` | `latest-default` |

Both are global visual changes with no data, API or behaviour contract, so each can be deployed alone and rolled back with a revert. No feature flag is used. The product owner's slice review is the design gate, and it happens on the PRs.

## Execution wave

**Wave 1 — Tasks 01 and 02 in parallel**, both launched from the same recorded `develop` SHA.

- Merge **01 first**. Task 02 then merges the refreshed `develop` into its branch, resolves the `styles.scss` conflict (**owned by 02**, following C1/C2), re-runs its checks, and retakes its slice screenshots with the new fonts before its PR is merged.
- **Gate (end of milestone):** both PRs merged into `develop`, the integration checks pass on the `develop` tip, and the product owner has reviewed the E2E-3 screenshots and chosen the next component changes from the deferred backlog.

## Verification

Worker checks are listed in each prompt. Integration checks, run by the coordinator on `develop` after both merges:

```text
pnpm ci
pnpm smoke
pnpm build:desktop
git diff --check
```

Critical E2E scenarios (the repo's `verify` skill or Playwright; the in-app browser pane cannot be trusted for network blocking):

1. **E2E-1 Offline web fonts:** fresh Chromium context, block every request not to `127.0.0.1`/`localhost`, then load the app. The toolbar, menus and inspector render in Inter with icon glyphs. No font request fails.
2. **E2E-2 Offline desktop:** `pnpm pack:desktop`, launch with the network disconnected and an empty `userData`. Icons and Inter render in the titlebar, a menu and a dialog.
3. **E2E-3 Slice review:** screenshots in dark and light × a bright and a dark shader, with playback paused or a static shader for stable frames. Cover the main toolbar, browser search with a selected row, the inspector settings with lil-gui, one menu (the theme menu), and one dialog (export).
4. **E2E-4 Inspector state:** change a lil-gui value, switch inspector tabs and back. The value and textures are preserved, with no reinitialisation.
5. **E2E-5 Touch targets:** mobile preset (375×812). Toolbar and panel buttons are no smaller than on the source base.
6. **E2E-6 Desktop chrome:** titlebar buttons respond to clicks, and the window drags from empty titlebar space.

## Worktrees and completion evidence

Worktrees are siblings of the repo root, for example `E:\Adel\Documents\Orgs\shader-studio-wt-studio-look-01`. Each worker reports: its branch, commit SHAs, launch base SHA, checks run with results, files changed (and whether any are outside its owned scope, and why), screenshots or Playwright output for its acceptance IDs, the web build size before and after, and open risks.

## PR, integration and cleanup policy

- Planning does not authorise remote actions. To push, open or merge PRs, the coordinator uses: `Review completed tasks and open or merge eligible PRs`.
- A PR is not integrated until it is merged and its commits are reachable from the refreshed `develop`.
- Conflict ownership: `styles.scss` → Task 02; `index.html`, `angular.json`, lockfile → Task 01.
- Remove worker worktrees only after their PRs merge. Keep a rejected branch until its fix prompt has been written.

## Deferred backlog (not executable)

Choose from these after the E2E-3 review:

- Replace the inspector tabs with a custom tab strip that keeps panels mounted via `[hidden]`, following the full W3C APG tabs pattern (roving `tabindex`, linked tab/panel IDs, `aria-selected`, focus handling, an activation policy). This removes the four `::ng-deep .mat-mdc-tab-*` rules in `inspector-panel.ts`.
- Plain styled native input for the browser search.
- Monospace for numeric values and technical text (inspector, lil-gui).
- Migrate the remaining `.mat-mdc-menu-item` rules in `styles.scss` to supported overrides.
- Accent colour change; SVG icon set if Symbols is rejected; an app-owned token vocabulary if leaving Material becomes a goal.
- Area-by-area rollout: titlebar and panel headers → browser, explorer and editor tabs → inspector forms, presets and textures → dialogs, account and settings.

```yaml
review_contract:
  milestone: studio-visual-refresh-m1
  planning_ref: codex/plan-studio-visual-refresh
  plan_path: docs/feature-plans/studio-visual-refresh-m1/
  source_base: "6bd6aaab0c04bd38a649958dd8e8ffbb226c08a0"
  default_branch: master
  pr_target: develop
  remote: origin
  tasks:
    - id: "01"
      branch: codex/studio-look-01
      worktree: shader-studio-wt-studio-look-01
      depends_on: []
      acceptance: [AC-FONT-01, AC-FONT-02, AC-FONT-03, AC-FONT-04]
      checks:
        - "pnpm exec nx run @shader-studio/web:test"
        - "pnpm lint"
        - "pnpm format:check"
        - "pnpm build"
        - "pnpm smoke"
      delivery: default-branch-pr
      base_policy: latest-default
      merge_order: 1
    - id: "02"
      branch: codex/studio-look-02
      worktree: shader-studio-wt-studio-look-02
      depends_on: []
      acceptance: [AC-THEME-01, AC-THEME-02, AC-THEME-03, AC-THEME-04, AC-BEH-01]
      checks:
        - "pnpm exec nx run @shader-studio/web:test"
        - "pnpm lint"
        - "pnpm format:check"
        - "pnpm build"
      delivery: default-branch-pr
      base_policy: latest-default
      merge_order: 2
      conflict_owner_for: [apps/web/src/styles.scss]
  integration_checks:
    - "pnpm ci"
    - "pnpm smoke"
    - "pnpm build:desktop"
    - "git diff --check"
  e2e_scenarios:
    - "E2E-1 offline web: UI and icon fonts load with non-local requests blocked"
    - "E2E-2 offline desktop: packed app renders Inter and icons with no network"
    - "E2E-3 slice screenshots: dark/light x bright/dark shader"
    - "E2E-4 inspector tab switch preserves lil-gui values and textures"
    - "E2E-5 touch preset keeps target sizes"
    - "E2E-6 desktop titlebar clickable and draggable"
  deferred:
    - inspector-tabs-replacement
    - native-search-input
    - monospace-values
    - menu-item-override-migration
    - accent-change
    - svg-icons
    - studio-token-vocabulary
    - area-rollout
```
