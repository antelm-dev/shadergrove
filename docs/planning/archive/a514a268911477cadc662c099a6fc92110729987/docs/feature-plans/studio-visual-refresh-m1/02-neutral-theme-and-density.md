# Task 02 — Neutral theme, density and overlays

Read the coordinator `README.md` supplied with this prompt first. It holds the decisions, the contracts C1 and C2, and the acceptance criteria.

## Mission

Make the app look like a compact creative tool by changing only Material's public theme inputs: neutral surfaces and text, a cyan accent, small consistent corners, density `-2` on desktop, more opaque overlays, and lil-gui colours to match.

## Launch base

- Base policy: `latest-default` (PR target `develop`).
- Exact base: `<exact-launch-base>` (the same `develop` SHA as Task 01).
- Prerequisites: none to start. **Before your PR is merged**, Task 01 must have merged. Then merge the refreshed `develop` into your branch, resolve `styles.scss` (you own that conflict), re-run your checks and retake your screenshots.

## Isolation

```text
git worktree add E:\Adel\Documents\Orgs\shader-studio-wt-studio-look-02 -b codex/studio-look-02 <exact-launch-base>
cd E:\Adel\Documents\Orgs\shader-studio-wt-studio-look-02
git status --short --branch
pnpm install
```

Status must be clean before you start.

## Context

- `apps/web/src/styles.scss`: `mat.theme` on `html` (cyan primary, magenta tertiary, `density: 0`, custom corners), lil-gui variables mapped to `--mat-sys-*`, and some menu/dialog rules.
- 36 component files read `--mat-sys-*` directly, mostly `on-surface-variant`, `primary`, `outline-variant`, `on-surface` and `surface-container-*`. Changing the system values restyles them; **don't edit those files**.
- `apps/web/src/app/app.scss` holds the workspace layout, with translucent panels (`backdrop-filter: blur(18px)`) and breakpoints at 900/600 px and container queries. Panel shells (`inspector-shell.ts`, `editor-shell.ts`, `preview-shell.ts`, `bottom-panel.ts`, `app-titlebar.ts`) also blur in their inline styles.
- The theme preference sets `color-scheme` inline on `html`. Tokens must use `light-dark()` (as `mat.theme` does), not a class.
- Material 22.0.4 provides `mat.theme-overrides` and component `mat.<component>-overrides` mixins. **Menus have no density tokens**, and density `-2` removes button touch targets. `*-window-controls.ts` set icon-button sizes explicitly; leave them.
- Touch detection exists: CDK `Breakpoints.Handset`/`TabletPortrait` in `app.ts`, and CSS `pointer`/width media queries are available.

## Owned scope

`apps/web/src/styles.scss` (everything except the C1 font sections) and `apps/web/src/app/app.scss`. Panel shell `styles:` blocks only when a token cannot reach them (C2), each one listed in your report.

## Required work

1. **Surfaces and text.** Using `mat.theme-overrides`, set neutral graphite values for the dark-mode surfaces and `surface-container*` tokens, pale neutral values for light mode, and matching `on-surface`, `on-surface-variant`, `outline` and `outline-variant` values. Avoid the blue/cyan tint that the cyan palette gives neutrals today. Keep the `body` background matching the "void" colour.
2. **Accent.** Cyan stays primary. Review whether magenta tertiary still makes sense next to neutral chrome (it is used for lil-gui strings) and report a recommendation; don't change it unless it clashes badly. Selection (`secondary-container`) should read as a subtle accent tint.
3. **Shape.** Small and consistent: controls 4 px, overlays up to 8 px. Adjust the existing corner map rather than adding new tokens.
4. **Density.** `density: -2` for desktop. Keep today's target sizes on touch: for example re-emit density 0 under `(pointer: coarse)`, or whatever supported mechanism you confirm works. Inspect the buttons, icon buttons, form fields, tabs, checkboxes and selects that change size. Fix clipping or misalignment with supported `*-overrides`, never with new `.mat-mdc-*` selectors.
5. **Overlays.** Menus, dialogs, tooltips and selects get an opaque (or near-opaque) surface and a shadow. Docked panels keep their translucency, and floating panels keep a shadow while docked panels keep only a border. Use component overrides. Add a `--studio-*` token only if Material has no equivalent (for example `--studio-surface-workspace` for the translucent panel fill), and document it where it is defined.
6. **Focus.** Keyboard focus is clearly visible on the neutral surfaces in both themes.
7. **lil-gui.** Update its colour variables to the new tokens (widget, hover, focus, number, string, text, borders), in both themes. Leave `--font-family` alone (Task 01).

## Out of scope

Fonts, icons and `index.html` (Task 01). Replacing the inspector tabs or search field, editing component templates, and changing `preserveContent` (deferred).

## Contracts

You consume C1 (don't touch the font lines) and produce C2.

## Verification

```text
pnpm exec nx run @shader-studio/web:test
pnpm lint
pnpm format:check
pnpm build
```

Acceptance: AC-THEME-01 to AC-THEME-04 and AC-BEH-01. Using the `verify` skill (Playwright, not the in-app pane), provide the README's **E2E-3** screenshot set, taken both before (source base) and after, plus E2E-4, E2E-5 and, if you can build the desktop app, E2E-6. Confirm with a grep that no `.mat-mdc-*` or `::ng-deep` selectors were added.

## Delivery

`default-branch-pr` → `develop`, merged after Task 01. No flag; a revert rolls it back.

## Commit discipline

1–3 logical commits, for example: (1) neutral surfaces, text, corners and lil-gui colours; (2) density and touch retention with the sizing fixes; (3) overlay opacity and focus. Review the full diff before reporting. Report: commits, launch base, checks, before/after screenshots, the list of files touched outside `styles.scss`/`app.scss`, the tertiary recommendation and risks.
