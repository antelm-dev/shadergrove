# Worker 03 — Language packs and live resolution

## Mission and launch

Use active declarative language packs for translation and language selection,
including en/fr defaults, a third-party LTR pack and independent English recovery.
Read the supplied README and consume C1/C2/C4 and 01's frozen interface handoff.

Delivery: `integration-only`, targeting
`codex/integrate-default-theme-language-plugins`, eventually `origin/master`.
Base policy: `integration-tip`; 01 must be accepted and reachable on integration.
Coordinator records `LAUNCH_BASE_03=<exact SHA>` before dispatch; 02 is not a
prerequisite.

Create `codex/default-languages-03` in new sibling worktree
`E:\Adel\Documents\Orgs\shader-studio-default-languages-03` from that SHA and
verify clean status/applicable instructions.

## Owned scope

Primary files: `apps/studio/src/app/i18n/{i18n,localize,provide-i18n}.ts` and
language-only sections of `apps/studio/src/app/{app.ts,app.html}`.
Supporting scope is the language catalogue/menu boundary, language-only additions
to `plugin-commands.ts`/`plugins-page.ts`, existing date/number display consumers,
new translation keys/texts and tests including `plugin-languages.spec.ts`.
Shared schemas, persisted preference contracts, default sources/generator and
generated packs remain owned by 01; request asset regeneration from 01 after
text additions. Do not edit 02's theme methods/sections.

## Required work

1. Resolve languages by exact `languagePackId` among current-profile active,
   validated contributions. Keep requested refs separate from the effective
   locale. Duplicate locales remain separately selectable with native names/
   package attribution. Recovery English is available even with no plugins.
2. Feed `I18n.t` and `$localize` the same English-plus-selected merged catalogue.
   Use plain text and approved named placeholders. Missing dictionary keys
   recover consistently; no obsolete language/profile results can win a race.
   Update document language/direction to the effective selection.
3. Boot with bundled English without waiting for account-dependent plugins.
   Apply packs reactively once resolved. SSR installs nothing and cannot expose
   a visitor's plugin dictionary through shared global state. Do not send custom
   locales to existing en/fr HTTP/IPC endpoints or trust packs for locale scripts.
4. Migrate legacy en/fr once after default bootstrap settles; retain preferences
   on temporary unavailability, disable/remove and profile switches. Installation/
   activation alone never selects a third-party pack. A captured language command
   must revalidate its profile/package/contribution before changing preferences.
5. Replace hard-coded language options with the active registry in menus and
   palette; show language metadata and selection in Plugins without pretending
   it is an importer or Worker action. Reuse current plugin/menu architecture.
6. Make current account-session dates and displayed numeric values follow the
   effective locale live via host formatting or explicit supported locale inputs.
   Do not assume injected `LOCALE_ID` is reactive. Demonstrate a partial Spanish
   test pack without expanding a fixed locale list. Reject RTL explicitly;
   full bidi layout, font downloads and ICU/plurals are deferred.

## Verification and delivery

Run `pnpm gen:ipc`, README task-03 commands and affected Studio typechecks.
Create i18n tests for partial dictionaries/$localize parity, duplicate locales,
legacy migration, disabled/corrupt/profile-changed selections and startup with
slow/failed bootstrap. E2E adds a real validated Spanish fixture, switches en/fr/
Spanish, checks interpolation/date/number updates, removes/reinstalls defaults
and exercises stale commands. Keep fixture translations clearly labelled as tests.

Deliver AC-LANGUAGES and language portions of AC-MIGRATION/AC-LIFECYCLE/AC-BOOT.
Inspect the entire diff; commit 1–3 logical changes. Report SHAs, commands/exits,
acceptance evidence, ownership sections and remaining manual desktop/SSR gaps.
Do not push, open/merge PRs or remove the worker worktree.
