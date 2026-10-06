# Default theme and language plugins — Phase 1

Status: executable implementation plan, 2026-10-04. This branch changes documentation only.

## Goal and bounded milestone

Ship the current Light/Dark appearance and English/French translations as ordinary,
declarative plugin packages preinstalled and enabled once per local plugin profile.
Users can disable, remove, reinstall and select them through the same plugin
mechanisms as third-party packages. Menu entries follow active validated
contributions. Keep an always-available English catalogue and CSS/Monaco fallback
for startup and unavailable selections; do not present duplicate built-in theme
choices alongside the official packages.

Phase 1 includes paired theme variants and host-owned System mode, the existing
English/French translations, and installation of a third-party LTR language fixture
without changing the application's supported-language list. It does not promise
all-language typography, RTL layout or translation production.

## Repository evidence and launch context

- Source checkout: `E:\Adel\Documents\Orgs\shader-studio`, branch `master`.
- Source base: `076b3dcb086da4200f3b261018c7c93dab4c67f5` (PR #46 merged).
- Primary remote: `origin`, `https://github.com/antelm-dev/shadergrove.git`;
  local `origin/HEAD` resolves to `origin/master`. No remote refresh was needed
  for this current-checkout plan; refresh it when resolving worker launch bases.
- Planning ref: `codex/plan-default-theme-language-plugins`.
- Integration branch: `codex/integrate-default-theme-language-plugins`.
- No applicable `AGENTS.md` found in the checkout or its ancestor chain.
- Pre-existing staged user files, preserved in the original checkout:
  `docs/future-plans.md`, `docs/plugin-adapters-plan.md`,
  `docs/shadertoy-wallpaper-plugins-sketch.md`, `libs/desktop-api/src/ipc-bridge.ts`.
- Temporary planning worktree:
  `E:\Adel\Documents\Orgs\shader-studio\tmp\plan-default-theme-language-plugins-20261004`;
  remove only this worktree after committing and verifying the plan.

Current integration points:

- `PluginInstallations` loads per-account/anonymous IndexedDB stores; Electron
  uses one local store. Installs/updates are off by default. `active` means
  enabled, valid and compatible. There is no durable default-seeding marker.
- `PluginStore` exposes list/put/remove only; main-process plugin IPC validates
  packages and confines management to the main window. Its generated bridge
  must be regenerated, never hand-edited.
- `tools/workspace/src/generate/official-plugins.ts` currently always bundles
  `src/index.ts` as Worker code. The release list and generated hash catalogue
  already ship packages to web and Electron.
- `themes/{app-themes,theme-catalog,theme-menu}.ts` apply active theme data;
  `styles.scss` supplies fallback Material roles, including omitted optional
  roles. Theme schema 1 has a fixed scheme and no variant association.
- `plugins/plugin-commands.ts` already supplies theme palette commands. Reuse
  this registry and its stale-context protections, rather than rebuilding it.
- `i18n/{i18n,catalog,localize,provide-i18n,keys}.ts` hard-code en/fr, and
  `Preferences.sanitizeLanguage` maps everything except fr to en. Dictionaries
  originate in root `i18n/en.json` and `i18n/fr.json`.
- The HTTP and desktop catalogue endpoints accept only built-in locales.
  `provideI18n` awaits catalogue loading before bootstrap, while account
  resolution starts in `App`; waiting for profile plugins there would deadlock.
- `LOCALE_ID` is supplied once. Account dialog uses `DatePipe`; post-processing
  uses `DecimalPipe`. Text switching alone cannot establish live formatting.

## Shared implementation contract

### C1 — Packages, compatibility and trust

Keep protocols 1 and 2 and theme schema 1 working. Add protocol 3 for `language`
and paired theme schema 2; require these new shapes to use protocol 3. Older
hosts must refuse them rather than half-read them. Update catalogue validation,
kind dispatch, compatibility checks and exhaustive consumers together.

Default package identities, fixed for this milestone:

| Package ID                       | Contributions                           |
| -------------------------------- | --------------------------------------- |
| `dev.shadergrove.default-themes` | `light`, `dark` (theme group `default`) |
| `dev.shadergrove.language-en`    | `english` (locale `en`)                 |
| `dev.shadergrove.language-fr`    | `french` (locale `fr`)                  |

They have no code, GLSL, script, CSS, HTML, URL or font payload. Third-party
themes/languages are equally declarative. Existing mixed code packages retain
their normal validation/execution policy. Only this app-owned allow-list of
data-only default packages may be installed/enabled automatically; a package or
catalogue entry cannot grant itself that status.

Extend the generator for data-only source packages, preserving deterministic
Worker output for Shadertoy/Wallpaper. Keep root en/fr dictionaries as the one
translation source, generating both the default packs and bundled English
fallback from them. Extract the existing Light/Dark UI and Monaco palettes
without redesigning them; generated fallback/packs must agree on house colours.
Defaults are release assets checked through the catalogue's bounded reads,
size/hash/identity validation, including offline Electron asset resolution.

### C2 — One-time defaults, durable state and startup

Extend the existing plugin persistence boundary with host-owned bootstrap
metadata, separate from package manifests. Use a versioned per-store marker
and per-default suppression/completion state. Keep the existing IndexedDB plugin
database at its current schema/open version and put metadata in a companion
database, so an older app can still open installed records after rollback.
Serialize bootstrap/removal operations across tabs and use durable suppression
plus idempotent recovery across the two databases. Electron needs bounded,
validated, atomically replaced metadata and generated IPC coverage. Never
disguise metadata as an invalid plugin record.

Seed missing defaults enabled only for a profile not yet initialized for this
defaults version. Preserve existing records, disabled states and versions; never
silently replace a user-installed package. Record explicit removal suppression
before deletion so an interrupted seed cannot resurrect a removed pack. The
equivalent state is per profile on web and per local store on desktop. Concurrent
tabs/windows and restart after partial writes must converge without overwrites.
Failed seeding remains retryable without duplicating completed work; disabling
or deleting any default survives restart and app upgrades. Reinstallation from
the catalogue is explicit and follows the ordinary install-off policy.

Publish contributions only for the current load/profile generation. Profile
switches cancel/ignore obsolete async work; clear previous entries immediately.
Persist only to the captured store; never carry an old profile's write into a
new one. Seeding failure/storage unavailability leaves the app usable.

SSR and the initial browser render use the fallback; they perform no plugin
installs. Boot English independently of `PluginInstallations`. Start seeding
after a profile resolves without blocking the i18n initializer. Satellite/output
windows must not gain plugin-management IPC or initiate seeding; retain safe
appearance there, and verify existing windows' behavior explicitly.

### C3 — Theme variants, references and migration

Schema 2 extends a fixed-scheme theme with optional `variantGroup`, using the
contribution-ID grammar. A group is scoped to one package and contains exactly
one light and one dark contribution. Validate the complete manifest to reject
duplicates, incomplete groups and cross-package references. Schema 1 remains
fixed-scheme and ungrouped. All existing role/colour/Monaco validation remains.

Keep version-independent `plugin:<packageId>/<contributionId>` selections.
Add persisted `appThemeMode: fixed | system`; System resolves the selected
contribution's validated group against the OS scheme. Explicit Light/Dark
select a concrete reference in fixed mode. Offer System only for paired themes;
do not silently pair unrelated packages. Keep `colorScheme` as the fallback
preference and expose its OS observation independently of theme-mode selection.

Worker 01 owns preference types/sanitizers and a theme migration marker; Worker
02 performs the one-time runtime migration after defaults settle: legacy
`builtin` + light/dark maps to the official variant; legacy System maps to the
default group in system mode. Preserve third-party references and pinned Monaco
IDs. Never rewrite a stored choice merely because its pack is temporarily
unavailable. Explicit selection revalidates active package/contribution state,
including commands captured before disabling or switching profile.

After disable/remove/invalid/incompatible selection, paint fallback immediately
and retain the reference for explicit restoration. Clear obsolete tokens before
applying another palette; editor auto follows the resolved variant. Maintain
fallback optional-role values in CSS. Migrate once, not on every login/restart.

### C4 — Language contract, resolution and fallback

Language schema 1 fields: the common kind/id/name, `schemaVersion: 1`,
canonical bounded `locale`, `nativeName`, `direction: ltr`, and `messages`.
Locales use host-validated BCP 47/Intl identifiers, never paths. RTL is rejected
with an explicit unsupported reason in this milestone. Reject unknown fields,
dangerous object keys, unknown translation keys, non-string/empty values,
over-limit dictionaries and malformed or incompatible named placeholders.
Define concrete byte/count/string limits within the existing package limit.

Move/re-export the canonical translation-key and placeholder contract into a
shared, browser-safe module so package validation, the generator and tooling use
one source. Official en/fr packs must be complete; third-party dictionaries may
be partial and fall back per key to bundled English. Render plain text; never
execute markup or interpolation expressions. Feed the same merged dictionary
to `I18n.t` and `$localize` so their fallback behavior agrees.

Persist `languagePackId` as `fallback-en | plugin:<packageId>/<contributionId> |
null` (null means unmigrated legacy preference) and a language migration marker;
retain a validated locale in legacy `language` for compatibility. Resolve by
reference, not first matching locale: two packages may provide the same locale.
Show native names plus package attribution when needed. Keep a recovery English
choice always accessible, clearly distinct from an active English pack.

Worker 01 owns preference contracts/sanitizers and removes the closed locale
type barrier without importing app services into shared code. Worker 03 maps
legacy en/fr to their official references once defaults settle, retains choices
when unavailable, and derives effective locale/direction/dictionary from active
contributions. Enabling/installing a non-default pack does not select it.
Selection revalidates active identity and ignores stale loads/profile results.

Do not route a plugin locale to `/api/i18n/<locale>` or desktop i18n IPC; those
remain compatibility endpoints for known bundled catalogues. SSR stays on the
built-in fallback and must not share visitor dictionaries through global state.
No profile plugin is required to render the language selector or install page.

Dates/numbers follow the effective locale live, using host-owned `Intl` formatting
or explicit locale inputs with registered host data; never import JS from packs.
Update the existing DatePipe/DecimalPipe call sites as needed rather than assuming
changing `LOCALE_ID` after bootstrap updates them. A third-party Spanish fixture
must demonstrate text, date and numeric switching with no new hard-coded locale
list. Full RTL, font coverage and locale-data vendoring are deferred.

## Tasks, isolation and ownership

All tasks are `integration-only`: shared protocol/bootstrap changes introduce
incomplete behavior until both runtime consumers exist. Do not deploy a new
public contribution kind without its consumer. No artificial feature flag is
needed when the complete milestone is gated on the integration branch.

| Task | Wave / dependencies              | Primary outcome                                             | Branch                       | Base policy       |
| ---- | -------------------------------- | ----------------------------------------------------------- | ---------------------------- | ----------------- |
| 01   | 1 / none                         | Validated default packs and durable profile bootstrap       | `codex/default-packs-01`     | `latest-default`  |
| 02   | 2 / 01 accepted into integration | Themes as selectable packs with System migration            | `codex/default-themes-02`    | `integration-tip` |
| 03   | 2 / 01 accepted into integration | Languages as selectable packs with live fallback/formatting | `codex/default-languages-03` | `integration-tip` |

Worktrees, created only at execution, are unique siblings:
`E:\Adel\Documents\Orgs\shader-studio-default-packs-01`,
`E:\Adel\Documents\Orgs\shader-studio-default-themes-02`,
`E:\Adel\Documents\Orgs\shader-studio-default-languages-03`.
Record exact absolute paths and clean starting statuses; never reuse an unrelated
worktree. Initialize integration from the exact refreshed default commit used by 01. Resolve and record immutable launch SHAs for all workers; no moving ref is a
launch record. If default evolves after planning, recheck the affected paths and
contracts before dispatch.

Supply this README and the worker prompt directly, or supply the readable
planning ref and `git show <planning-ref>:docs/feature-plans/default-theme-language-plugins/<file>`.
Plan files need not exist in source-based worker branches. Runtime workers start
only after 01's contracts, generated packages and bootstrap tests are accepted
and reachable from the integration branch. 02/03 may then work concurrently.

Ownership: 01 owns shared schemas/key-contract extraction, preference contracts, default
pack sources/assets/release list/generator, persistence and generated IPC. 02
owns `themes/`, theme-only registry methods and removal of builtin palette
entries in `app.ts`. 03 owns `i18n/`, language UI and language-only registry/page
additions. After 01's key extraction freezes, 03 owns new UI key entries and
matching en/fr text; 01 retains key validation semantics and generated outputs.
Shared `app.ts` edits are disjoint theme versus language sections;
`plugin-commands.ts` theme versus language sections. 03 owns new UI text keys and
en/fr text additions and asks 01 to regenerate derived assets from those commits.
Changes outside assigned sections require a coordinator handoff; do not silently
change the contract in wave 2. Coordinator resolves merge conflicts using these
owners; broad validation is coordination, not a fourth implementation worker.

Each task is one narrow vertical boundary, although 01 necessarily touches more
than five files across validation, generation, web/desktop persistence and
preferences. This is the bounded exception needed to avoid separate schema,
storage and packaging workers; retain three tasks, two waves, 1–3 logical commits
per worker. Split commits by reviewable behavior, not layers alone.

## Acceptance and validation

| ID           | Required evidence                                                                                                              | Owner       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| AC-CONTRACT  | New data-only shapes validated; protocols 1/2 and schema 1 still run; hashes/output deterministic                              | 01          |
| AC-DEFAULTS  | Three default packs seed enabled once; disable/remove/update states preserved; partial failure/concurrent stores converge      | 01          |
| AC-BOOT      | English/CSS fallback renders without plugins/network/storage; no auth/bootstrap deadlock or old-profile writes                 | 01, 03      |
| AC-THEMES    | Dynamic theme menus/palette; Light/Dark visual parity; System changes both UI/Monaco; fixed mode unchanged                     | 02          |
| AC-MIGRATION | Legacy en/fr and builtin light/dark/system retain appearance/language; existing plugin and pinned editor choices preserved     | 02, 03      |
| AC-LANGUAGES | Active reference-specific language choices; third-party LTR fixture; identical text/$localize fallback; live dates/numbers     | 03          |
| AC-LIFECYCLE | Disable/remove/invalid/replacement/profile-switch removes entries and applies fallback; stale commands cannot select old packs | 02, 03      |
| AC-DELIVERY  | Web/SSR builds and installed offline Electron include packs/fallback; satellite management restrictions retained               | Coordinator |

Targeted commands are listed in each worker prompt. Run `pnpm gen:ipc` before
Studio checks. On Windows Nx trouble, use `NX_NO_CLOUD=true`, `NX_DAEMON=false`
and a dedicated temporary directory; a hanging green test is not a successful
completed run. Reports distinguish passed, failed, skipped and manual-unverified.

Coordinator integration gate (one complete run after accepted changes and final
generation): `pnpm ci`, `pnpm build:desktop`, and
`pnpm --filter @shadergrove/studio-e2e exec playwright test src/plugin-themes.spec.ts src/plugin-languages.spec.ts src/plugins.spec.ts`.
`plugin-languages.spec.ts` is created by 03. The checked-in Playwright config uses
port 4322 and clears `DATABASE_URL` for isolated SQLite; preserve that isolation.
Rerun checks only for new changes, failures or an unresolved concern.

Critical E2E/manual scenarios:

1. Fresh anonymous/account profiles and a fresh desktop data directory: default
   packs visible as installed/enabled; ordinary plugin installs remain off.
2. Legacy snapshots for en/fr, builtin light/dark/system, third-party theme and
   pinned Monaco: migrate, reload twice, retain settings.
3. Select variants/System, change OS scheme with browser emulation, inspect
   Material overlay/menu and Monaco colors. Capture representative before/after
   Light/Dark views; no stale tokens or duplicate builtin rows.
4. Select French and a third-party partial Spanish pack; verify interpolated
   strings, per-key English recovery, date/number formatting and language/palette
   attribution for duplicate locales; disabling the selected pack restores en.
5. Disable/remove/reinstall defaults, restart, simulate a failed/interrupted seed
   and two tabs, replace incompatible/corrupt packages, switch accounts during
   delayed reads and while the palette is open. Removed packs stay removed.
6. SSR without browser storage; slow/failing catalogue; English recovery without
   network. Browser offline means already loaded app/assets, not a promised PWA.
7. Build/package via `pnpm pack:desktop`; launch the installed application offline
   with isolated user data, repeat selection/restart/remove/System and output/
   satellite windows. Package success alone is not installed-app evidence.

Stop when acceptance IDs and integration checks pass, or report exact remaining
failures/manual gaps. Do not launch an open-ended cleanup/review loop.

## Delivery, rollback and deferred work

Workers commit locally and report SHAs, changed paths, tests, acceptance evidence
and risks. No push, PR creation or merge is authorized by this planning request.
The intended final destination is one fully reviewed milestone PR from integration
to `origin/master`, after all gates. Authorization can be supplied explicitly as
“Review completed tasks and open or merge eligible PRs”. Execution must retain
worker branches/worktrees until acceptance and the user-authorized handoff.

Retain legacy preference fields and en/fr HTTP/IPC endpoints. Rollback to the old
app refuses new protocol packages and recovers built-in visuals/English instead
of corrupting shader data. A profile downgraded after migration must remain
readable; do not delete dictionaries, old theme palettes or preference fields
needed for fallback during this milestone.

Deferred, non-executable backlog: RTL and bidirectional layout; translation
authoring/marketplace/moderation; font/download support; full ICU/plural grammar;
cloud synchronization of plugin selections; automatic pack updates; removal of
legacy catalogue endpoints; migration of all independently pinned Monaco themes;
plugin localization of arbitrary plugin-authored strings. The existing import/
export menu registry is already merged and is outside this plan's scope.

```yaml
review_contract:
  milestone: default-theme-language-plugins-phase-1
  planning_ref: codex/plan-default-theme-language-plugins
  source_base: '076b3dcb086da4200f3b261018c7c93dab4c67f5'
  default_branch: master
  integration_branch: codex/integrate-default-theme-language-plugins
  tasks:
    - id: '01'
      branch: codex/default-packs-01
      depends_on: []
      acceptance: [AC-CONTRACT, AC-DEFAULTS, AC-BOOT]
      checks:
        - 'pnpm --filter @shadergrove/shared exec vitest run src/plugin/package.spec.ts src/plugin/themes.spec.ts src/plugin/languages.spec.ts'
        - 'pnpm --filter @shadergrove/studio exec ng test --watch=false --include=src/app/plugins/plugin-installations.spec.ts'
        - 'pnpm --filter @shadergrove/studio test:desktop -- src/desktop/main/ipc/plugins.ipc.spec.ts'
        - 'pnpm check:plugins'
        - 'pnpm check:i18n'
      delivery: integration-only
      base_policy: latest-default
    - id: '02'
      branch: codex/default-themes-02
      depends_on: ['01']
      acceptance: [AC-THEMES, AC-MIGRATION, AC-LIFECYCLE]
      checks:
        - 'pnpm --filter @shadergrove/studio exec ng test --watch=false --include=src/app/themes/*.spec.ts --include=src/app/plugins/plugin-commands.spec.ts'
        - 'pnpm --filter @shadergrove/studio-e2e exec playwright test src/plugin-themes.spec.ts'
      delivery: integration-only
      base_policy: integration-tip
    - id: '03'
      branch: codex/default-languages-03
      depends_on: ['01']
      acceptance: [AC-LANGUAGES, AC-MIGRATION, AC-LIFECYCLE, AC-BOOT]
      checks:
        - 'pnpm --filter @shadergrove/studio exec ng test --watch=false --include=src/app/i18n/*.spec.ts --include=src/app/plugins/plugin-commands.spec.ts --include=src/app/plugins/plugins-page.spec.ts'
        - 'pnpm --filter @shadergrove/studio-e2e exec playwright test src/plugin-languages.spec.ts'
        - 'pnpm check:i18n'
      delivery: integration-only
      base_policy: integration-tip
  integration_checks:
    - 'pnpm ci'
    - 'pnpm build:desktop'
    - 'pnpm --filter @shadergrove/studio-e2e exec playwright test src/plugin-themes.spec.ts src/plugin-languages.spec.ts src/plugins.spec.ts'
  e2e_scenarios:
    - 'Fresh profile defaults, persistent disable/removal and interrupted seeding'
    - 'Legacy migration, paired System themes and UI/Monaco parity'
    - 'Reference-specific LTR languages, partial fallback and live formatting'
    - 'Profile races, stale selections, SSR recovery and installed offline Electron'
  deferred:
    [RTL, ICU-plurals, fonts, marketplace, cloud-sync, automatic-updates, legacy-endpoint-removal]
```
