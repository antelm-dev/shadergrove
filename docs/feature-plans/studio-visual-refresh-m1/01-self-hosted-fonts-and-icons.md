# Task 01 — Self-hosted UI and icon fonts

Read the coordinator `README.md` supplied with this prompt first. It holds the decisions, the contracts C1 and C3, and the acceptance criteria.

## Mission

Serve Inter (UI) and Material Symbols (icons) from the app's own origin, make them the Material typography and `MatIcon` default, and make sure every icon in use still renders.

## Launch base

- Base policy: `latest-default` (PR target `develop`).
- Exact base: `<exact-launch-base>` (the `develop` SHA the coordinator records).
- Prerequisites: none. Task 02 runs in parallel; you merge first.

## Isolation

```text
git worktree add E:\Adel\Documents\Orgs\shader-studio-wt-studio-look-01 -b codex/studio-look-01 <exact-launch-base>
cd E:\Adel\Documents\Orgs\shader-studio-wt-studio-look-01
git status --short --branch
pnpm install
```

Status must be clean before you start.

## Context

- `apps/web/src/index.html` links Roboto and the legacy **Material Icons** from Google Fonts. **Keep the CSP's Google Fonts entries**: `apps/web/src/app/editor/google-fonts.ts` still loads editor fonts at runtime.
- `apps/web/src/styles.scss` sets `typography: Roboto` in `mat.theme`, and `--font-family: Roboto, sans-serif` for lil-gui. Its menu rules for `mat-icon.hint`, `mat-icon.menu-hint` and `.theme-check` size icons by hand, and the comment there wrongly says "Material Symbols".
- `apps/web/angular.json` configures assets and styles for the browser and desktop builds (two blocks, around lines 29 and 106). The initial budget is 2.0 MB. Fonts must be separate files, not `data:` URIs.
- The app is bootstrapped with `app.config.ts`. Check how `app.config.desktop.ts` and `app.config.server.ts` relate (file replacement or merge), so the icon default applies in web, desktop and SSR.
- 41 `mat-icon` elements take their name from a binding; others are static text. Names also live in TS strings (menus, commands, status maps).

## Owned scope

`apps/web/src/index.html`, `apps/web/angular.json`, `apps/web/src/app/app.config*.ts`, the C1 font sections of `apps/web/src/styles.scss`, `package.json`/`apps/web/package.json` + `pnpm-lock.yaml`, `THIRD_PARTY_NOTICES.md`, plus icon-name fixes at their call sites (C3).

## Required work

1. Add the fonts from maintained npm packages (for example `@fontsource-variable/inter` and `material-symbols`), or vendored `.woff2` files with their licences. Pick one approach and explain the choice. Load only what is used: Inter's variable upright face, and the Outlined Symbols style.
2. Remove the Google `<link>`s and preconnects for Roboto and Material Icons from `index.html`. Leave the CSP as it is.
3. Set `typography` in `mat.theme` to Inter with a sensible fallback stack. Set lil-gui's `--font-family` to the same stack.
4. Register Material Symbols Outlined as `MatIcon`'s default font set class, in a provider that runs in every build. Tune `font-variation-settings` (weight, optical size, grade, fill) once, globally, to suit 16–20 px icons. Fix the menu icon rules and their comment so the sizes still line up.
5. **Icon audit.** List every icon name in use: static template text, `{{ }}` bindings, and TS string sources. Check each against the Symbols set, rename any that are missing, and include the list in your report.
6. Add a check to `tools/workspace/src/smoke.ts` (or a helper next to it): in a fresh context, block non-local requests, load the app, and assert that `document.fonts` reports Inter and Material Symbols as loaded, and that no font request failed.
7. Add Inter (OFL-1.1) and Material Symbols (Apache-2.0) to `THIRD_PARTY_NOTICES.md`.

## Out of scope

Colours, surfaces, density, overlay opacity and lil-gui colour variables (Task 02). Component replacements, SVG icons and monospace styling (deferred).

## Contracts

You produce C1 and C3. Don't edit the palette, `theme-overrides` or density in `styles.scss`: Task 02 owns those lines and resolves the merge conflict.

## Verification

```text
pnpm exec nx run @shader-studio/web:test
pnpm lint
pnpm format:check
pnpm build
pnpm smoke
```

Acceptance: AC-FONT-01 to AC-FONT-04. Also provide:

- a screenshot of the theme menu and the titlebar with icons;
- the web build output size before and after (`dist-web`), and the Symbols file size;
- for the desktop build, `pnpm build:desktop`, then a launch showing the fonts served from the app protocol (DevTools Network or `performance.getEntriesByType('resource')`).

## Delivery

`default-branch-pr` → `develop`. No flag; a revert rolls it back.

## Commit discipline

1–3 logical commits, for example: (1) bundle fonts, switch typography and icon default; (2) icon renames from the audit; (3) offline smoke check and notices. Review the full diff before reporting. Report: commits, launch base, checks, audit list, sizes, screenshots and risks.
