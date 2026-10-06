# Public Explore and minimal administration - Phase 1

## Goal and bounded milestone

Deliver a web-only journey: verified owner saves a shader, explicitly publishes a snapshot, anonymous visitor discovers and opens it, verified visitor copies it into their private library, and an administrator can review reports, hide/restore publications and restrict/restore publishing access. Explore and moderation ship together. This is a plan, not implemented functionality.

Private drafts remain private. Public snapshots include project sources, controls, presets, textures, thumbnail and the existing ordered post-processing settings. Standalone effect entities and a new custom-effect editor are deferred; this milestone does not fulfill those additional product ambitions.

## Repository and handoff

- Repository: `E:/Adel/Documents/Orgs/shader-studio`.
- Starting branch: `master`; clean `git status --short` (including untracked files).
- Source HEAD and locally recorded `origin/master`: `e3c1ea6b78855be835bdcf762f4aa9b294676b36`. No remote fetch was performed during planning.
- Default branch: `master`; remote: `origin`, `https://github.com/antelm-dev/shader-studio.git`.
- Planning ref: `codex/plan-public-explore-admin`; directory: `docs/feature-plans/public-explore-admin`.
- Integration branch: `codex/integrate-public-explore-admin`.
- No applicable repository/ancestor AGENTS.md was found during inspection.

Give each worker this README and its prompt directly, or provide a readable exact planning commit and these paths. Plan files will not automatically exist on source-based worker branches. Refresh the remote default branch at execution, compare changes with this source, and record an exact launch SHA for every worker. Never launch from a moving branch name alone.

Current boundaries: `ShaderLibrary.as(scope)` and SQL enforce private ownership. `ApiModule` globally registers `AuthGuard`; `@Public()` bypasses session resolution and must only mark anonymous publication reads. `Principal` has no admin role. SQLite serves local development and HTTP tests; PostgreSQL serves deployed web storage. `shader-browser.ts` currently lists private ShaderStore records. `RoutingCoordinator` keeps private selection and `/shaders/:id` synchronized. Existing bundles are `shader-studio/v3`; post-processing already travels in `RenderSettings`. `exportOne()` reads multiple pieces and is not proof of a coherent publication snapshot.

## Shared implementation contracts

These are proposed contracts for the workers, not existing APIs. Worker 01 freezes concrete DTOs in `libs/shared/src/publication.ts` and records any justified deviation before wave 2.

- Add a dedicated publication domain/repository boundary; do not make the private library globally readable or add publication data to desktop sync. Support SQLite and PostgreSQL with additive, versioned migrations; never edit shipped migrations.
- Server config `PUBLIC_EXPLORE_ENABLED` defaults false. When off, all new publication/admin routes are unavailable and all UI entry points are absent. A small capabilities endpoint returns enabled state and current admin capability without leaking identities; anonymous callers get no admin capability. SSR and the browser must agree. Disable the flag for operational rollback; additive data remains intact.
- Admins are authenticated verified users explicitly listed by immutable account ID in server-only `PUBLIC_EXPLORE_ADMIN_USER_IDS`; empty configuration grants nobody access. Never infer admin access from an email suffix, UI state, or client claims. No role-management dashboard in Phase 1.
- Publication has a stable opaque ID, owner/source reference, immutable current snapshot, monotonically increasing publication revision, public author label, required license/attribution metadata, and separate owner-visible and moderator-hidden states. Effective public visibility requires owner-visible AND not moderator-hidden. Public DTOs omit email, sessions, private source IDs and internal moderation notes.
- Publish/update requires a verified owner, persisted source and expected source revision; snapshot source, presets and asset bytes coherently within the same database transaction/isolation boundary. A stale source yields conflict. Existing thumbnail-only edits are independent of the content revision: guarantee snapshot coherence even when they race. Updating replaces the snapshot atomically, retains the public ID and cannot clear a moderation hide. Unpublishing preserves moderator state; republishing cannot evade it. No silent updates from draft edits or sync.
- Source deletion removes public visibility in the same transaction. Account deletion leaves no public publication, asset access or active restriction target; define safe cleanup/retention in migrations and tests. No ambiguous dangling ownership.
- Public list is paginated, searchable by title and deterministically ordered by publish/update time plus ID. `/api/publications/:id` and its snapshot assets/export return only effectively visible content; hidden/unpublished/missing are uniformly not found. Use `Cache-Control: no-store` for Phase 1 publication reads and SSR responses: URLs and cached assets must not bypass a hide. Previously downloaded copies cannot be recalled.
- Proposed API families: `/api/publications` (anonymous list/detail/assets/export), `/api/shaders/:id/publication` (owner status, publish/update/unpublish), `/api/publications/:id/copy` (verified copy into caller's library), `/api/publications/:id/reports` (verified report), `/api/admin/publications`, `/api/admin/reports`, `/api/admin/publishers/:userId/restriction`. Worker 01 specifies exact methods and response/error schemas, including a small capabilities endpoint.
- Copy creates a new private record, retains attribution/license and source public URL, validates the snapshot through existing payload validation, and never overwrites another record. Require explicit supported license selection and rights confirmation when publishing; do not assume every imported shader/texture is redistributable. No new arbitrary external URLs or server-side URL fetching.
- Admin hide/restore, report resolution and publisher restrictions require a reason, expected moderation revision and transactional durable audit (actor, target, action, reason, time). Failed writes have no audit success record. Restriction blocks publish/update/republish, hides that publisher's current publications, and leaves private editing available. Lifting it does not automatically republish hidden content; deliberate restoration still respects owner-unpublished state.
- Reports: verified users, bounded reason/body, deduplicate open report per reporter/publication, bounded request rate and list pagination. Admin can inspect the reported snapshot without making it public, then resolve the report. Public clients never receive reporters' identities. Apply limits to publishing/copying too using existing repository patterns where available.
- Cookie-authenticated mutations need explicit trusted-origin/CSRF enforcement in the new Nest routes; Better Auth's own endpoint protection must not be assumed to protect Nest. Invalid input follows the existing API error envelope. No public GPU execution on the server.
- UI routes: `/explore`, `/explore/:publicationId`, `/admin/publications`. Public state is separate from ShaderStore/private routing. Static thumbnails in lists; detail rendering is client-only, user-triggered, bounded and stoppable, with compile/context-loss errors contained. Preserve unsaved private work and provide clear copy-to-edit behavior.
- Phase 1 is web-only. Desktop/output windows retain existing navigation and APIs; no hidden network requests, publication IPC or sync metadata. Backend schema evolution must keep local/offline operation intact.

## Tasks, isolation and waves

| Task | Primary outcome                                                      | Dependencies | Delivery / base                    | Branch and sibling worktree                                                       |
| ---- | -------------------------------------------------------------------- | ------------ | ---------------------------------- | --------------------------------------------------------------------------------- |
| 01   | Publication lifecycle and moderation REST contract, with persistence | none         | default-branch-pr / latest-default | `codex/public-explore-admin-01`, `E:/Adel/Documents/Orgs/shader-studio-public-01` |
| 02   | Explore, public detail/copy and owner publishing UI                  | 01           | integration-only / integration-tip | `codex/public-explore-admin-02`, `E:/Adel/Documents/Orgs/shader-studio-public-02` |
| 03   | Minimal admin publication/report/restriction UI                      | 01           | integration-only / integration-tip | `codex/public-explore-admin-03`, `E:/Adel/Documents/Orgs/shader-studio-public-03` |

Wave 1: task 01. Safe alone only with default-off flag, additive migrations, backward compatibility and all new routes gated. Accept after targeted real-HTTP and storage tests. If authorized and merged, refresh master and seed integration from the merge result; otherwise seed integration from the accepted task 01 SHA. Record the precise integration base.

Wave 2: tasks 02 and 03 launch from that recorded integration SHA in parallel. Task 02 owns route registration, RoutingCoordinator changes, navigation and shared i18n catalogs; task 03 owns new admin components/API client only. Pre-agree exported `AdminPublicationsPage` and translation keys `admin.publications`, `admin.reports`, `admin.hide`, `admin.restore`, `admin.restrict`, `admin.unrestrict`, `admin.reason`, `admin.resolve`, `admin.conflict`, `admin.forbidden`, `admin.empty`, `admin.loading`, `admin.error`. Task 03 sends any additional required labels before task 02 finishes catalogs. Task 02 must not import task 03's component in a standalone runnable branch until integration; report the exact pending route import for the coordinator. Task 03 does not edit routes/catalogs. The coordinator adds the final admin route import/registration after both are accepted, resolves glue conflicts and verifies the integrated build. No separate integration worker is necessary for this small registration.

The backend task owns one narrow domain across persistence/HTTP/shared DTOs and necessarily exceeds the usual 3-5-file guide; splitting those layers into agents would introduce avoidable sequencing and ownership problems. Three workers, two waves, 1-3 logical commits each remain the budget.

## Acceptance and validation

- AC-SNAPSHOT: coherent assets/project/presets/post-process snapshot; stale publish conflict; private edits and sync leave public snapshot unchanged; explicit update retains public URL.
- AC-PRIVACY: anonymous Explore works while private APIs remain protected; direct IDs/assets/export cannot reveal hidden/draft content or account information.
- AC-LIFECYCLE: publish/update/unpublish/source deletion/account deletion and hide/restore combinations obey visibility; republish/update cannot evade moderation; concurrent transitions conflict safely.
- AC-MODERATION: only configured admin can act; reports are bounded/deduplicated; restriction blocks publication without blocking private edits; actions and reasons are durably audited.
- AC-EXPLORE: search/pagination/detail/client preview/copy-to-private retain attribution, license, textures, presets and post-processing; failed compile does not break navigation.
- AC-OWNER: saved-source publish/update/unpublish controls show current state and conflict/restriction feedback; cancelled navigation and session expiry preserve unsaved work.
- AC-ADMIN: admin can find visible/hidden publications, inspect reports, hide/restore, restrict/restore publisher access and review action history; stale/unauthorized responses remain safe.
- AC-REGRESSION: flag off preserves current behavior; SSR refresh of public URLs works; account switching clears private/admin state; desktop/output windows remain offline-compatible.

Worker commands use existing scripts: `pnpm --filter @shader-studio/backend test -- <new publication spec paths>`, `pnpm --filter @shader-studio/backend typecheck`, `pnpm --filter @shader-studio/server test -- <new publication HTTP spec paths>`, `pnpm --filter @shader-studio/server typecheck`, `pnpm --filter @shader-studio/web test -- --watch=false --include=<new spec glob>`, `pnpm --filter @shader-studio/web typecheck`. Record the resolved new spec paths; verify Angular's include option locally before relying on it. PostgreSQL tests require a disposable dedicated `SHADER_TEST_DATABASE_URL`; existing conformance tests drop tables. Never point them at production or user databases. Skipped PostgreSQL checks are not passed checks.

Coordinator gate: complete diff review, `pnpm run ci`, `pnpm build:desktop`, real SQLite and PostgreSQL migration/publication/concurrency checks, built-server SSR smoke and manual/browser E2E. Record unavailable infrastructure and manual checks as unresolved. Green unit CI does not replace these journeys:

1. Alice publishes a textured multipass shader with controls, presets and post-processing; anonymous visitor finds it, opens stable URL, starts/stops preview; Bob copies it and modifies his private copy with fidelity and attribution.
2. Alice edits privately; public snapshot stays unchanged until Update publication. Concurrent source/asset edit during publish never creates a torn snapshot.
3. Admin hides publication while direct detail/asset/export requests race; fresh requests become not found. Owner update/unpublish/republish cannot bypass hide; admin restore cannot undo owner unpublish.
4. Bob reports once; duplicate open reports are prevented; admin inspects and resolves with durable reason/history. Non-admin and cross-origin requests cannot moderate.
5. Admin restricts Alice; her publications disappear and publishing fails, private edits still work. Unrestrict does not silently republish. Source/account deletion leaves no public assets.
6. Explore/admin navigation with an unsaved private shader, session expiry, sign-out/account switch, SSR reload, flag disabled and offline desktop: no lost draft, redirect loop, private data leak or accidental cloud calls.

## Delivery and review contract

Workers inspect instructions again at execution, start clean, preserve unrelated changes, stay within scope, run targeted checks and review their complete diff. Return exact base/HEAD, 1-3 commit SHAs, changed paths, check results including skips, acceptance evidence and risks. Coordinator owns shared wiring and integration regressions; worker 01 owns API/storage contract disputes. Do not redesign Material tokens or refactor sync/auth unrelated to this boundary.

Planning authorizes no execution, pushes, PR creation or merges. Intended destinations are master for eligible task 01 and the integration branch for tasks 02/03; only the complete milestone is eligible for a final master PR. Request explicit remote-action authorization at execution/review; never auto-merge. Preserve worker/integration worktrees while work or processes use them, and follow managed worktree tools for lifecycle operations.

```yaml
review_contract:
  milestone: public-explore-admin-phase-1
  planning_ref: codex/plan-public-explore-admin
  source_base: e3c1ea6b78855be835bdcf762f4aa9b294676b36
  default_branch: master
  integration_branch: codex/integrate-public-explore-admin
  tasks:
    - id: '01'
      branch: codex/public-explore-admin-01
      depends_on: []
      acceptance: [AC-SNAPSHOT, AC-PRIVACY, AC-LIFECYCLE, AC-MODERATION]
      checks:
        [
          'pnpm --filter @shader-studio/backend test -- <publication spec paths>',
          'pnpm --filter @shader-studio/server test -- <publication HTTP spec paths>',
          'pnpm --filter @shader-studio/backend typecheck',
          'pnpm --filter @shader-studio/server typecheck',
        ]
      delivery: default-branch-pr
      base_policy: latest-default
      feature_flag: PUBLIC_EXPLORE_ENABLED
    - id: '02'
      branch: codex/public-explore-admin-02
      depends_on: ['01']
      acceptance: [AC-EXPLORE, AC-OWNER, AC-REGRESSION]
      checks:
        [
          'pnpm --filter @shader-studio/web test -- --watch=false --include=<explore spec glob>',
          'pnpm --filter @shader-studio/web typecheck',
        ]
      delivery: integration-only
      base_policy: integration-tip
      feature_flag: PUBLIC_EXPLORE_ENABLED
    - id: '03'
      branch: codex/public-explore-admin-03
      depends_on: ['01']
      acceptance: [AC-ADMIN, AC-MODERATION, AC-REGRESSION]
      checks:
        [
          'pnpm --filter @shader-studio/web test -- --watch=false --include=<admin spec glob>',
          'pnpm --filter @shader-studio/web typecheck',
        ]
      delivery: integration-only
      base_policy: integration-tip
      feature_flag: PUBLIC_EXPLORE_ENABLED
  integration_checks:
    [
      'pnpm run ci',
      'pnpm build:desktop',
      'SQLite and disposable PostgreSQL publication/migration tests',
      'built-server SSR and browser E2E',
    ]
  e2e_scenarios:
    - 'publish textured multipass shader, discover anonymously, copy with fidelity and attribution'
    - 'private edits and concurrent snapshot asset writes'
    - 'hide/update/republish races and direct asset visibility'
    - 'reports, admin authorization, cross-origin mutation denial and durable audit'
    - 'publisher restriction, restore and source/account deletion'
    - 'unsaved work, session/account changes, SSR, flag off and offline desktop'
  deferred:
    [
      'standalone custom post-process effects',
      'desktop Explore/publishing',
      'likes/comments/follows',
      'featured collections',
      'analytics',
      'full role/account management',
    ]
```

Deferred backlog (not executable): independently authorable/shareable custom post-process effects and licensing model; desktop online Explore/publishing/sync; likes/comments/follows; curated collections; statistics; rich search; appeals; full account bans/role management; CDN/object-store architecture. None should be smuggled into Phase 1.
