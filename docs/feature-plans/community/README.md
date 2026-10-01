# Shadergrove community — Phase 1: public creators and remixes

## Goal and boundary

The agreed community scope is remixes, public creator profiles, favorites and
collections (including public sharing), comments and replies, in-app notifications,
and following creators with a subscriptions feed. This plan executes only the
smallest first milestone: opt-in public creator galleries and discoverable direct
remixes, end to end on the web. Two workers, two sequential waves; no implementation
or remote action is authorized by this planning commit.

Profiles start with a chosen public display name and a gallery. Biography, external
links, avatars, custom handles and a creator directory are later profile refinements.
This keeps the first milestone bounded. Challenges, pedagogical shader features and
community/editorial selections are explicitly outside the near-term scope.

Desktop is deferred: current Explore routes use `exploreOnWeb`, desktop has no
`PublicationApi` HttpClient, and private desktop sync contains no publication domain.
Do not promise desktop community support or change local library behavior.

## Repository evidence and launch record

- Original checkout: `E:/Adel/Documents/Orgs/shader-studio`.
- Starting branch: `develop`; source HEAD: `d64762a962395f7dd53e203f52a0f89b65314595`.
- Original status: `?? docs/plugin-adapters-plan.md`; preserve it without staging.
- Default branch: `master`, verified using origin HEAD; observed default SHA:
  `615702fddc89189ae4e4c85f1ef3a82c5287e171` on 2026-10-01.
- Remote: `origin`, `https://github.com/antelm-dev/shadergrove.git`.
- Explore exists at the source HEAD, but not on the observed default branch.
  Consequently both tasks are `integration-only`; do not target master directly.
- Planning ref: `codex/plan-community`; temporary planning checkout:
  `E:/Adel/Documents/Orgs/shader-studio-community-plan` (removed after commit).
- Execution integration branch: `codex/integrate-community`, created from the exact
  source HEAD only during execution. Intended eventual delivery: reviewed integration
  change to `develop`; promotion to master is a separate release decision.
- No applicable AGENTS.md was found in the checkout or its ancestor directories.

Publication contracts are in `libs/shared/src/publication.ts`; domain/store are
`libs/backend/src/publication/publication-library.ts` and `publication-store.ts`.
SQLite and PostgreSQL have additive versioned migrations, currently at version 4.
`PublicationLibrary.copy` already records a server-derived `PublicationOrigin` in
`shader_origins`; publish copies it into `derived_from_json`. A copy of a remix
records its immediate source, while earlier credits are folded into attribution.
There is no reverse remix listing. Never infer ancestry from names or client input.

Server composition is in `apps/web/src/server/index.ts` and `create-library.ts`;
Nest registration is in `libs/api/src/api.module.ts`,
`publications/publications.module.ts`, `explore.ts`, and `explore-config.ts`.
Frontend integration is in `apps/web/src/app/publications/`, `app.routes.ts` and
`workspace/routing-coordinator.ts`. Both English and French catalogs live in root
`i18n/`, with typed keys in `apps/web/src/app/i18n/keys.ts`.

## Shared product and API contract

These are planning decisions, not implemented APIs. Freeze them at the wave-1 gate.

1. **Capability and rollback.** Add default-off `PUBLIC_COMMUNITY_ENABLED=1`, effective
   only together with `PUBLIC_EXPLORE_ENABLED=1`. Add optional `community?: boolean`
   to Explore capabilities; old servers/missing values mean false. New routes are
   absent when off, UI entry points disappear, existing Explore/copy/export remain
   unchanged. Omit additive community fields when off. Keep data on rollback.
2. **Creator identity.** One profile per immutable account, with a generated opaque
   public `creatorId` distinct from the auth user ID; never expose email, auth name,
   account ID or source private shader ID. Profile creation is explicit, verified,
   owner-only. A chosen `displayName` is 1–64 trimmed characters rendered as text.
   Public state is initially off; activation clearly explains that all currently
   visible publications belonging to this account become linked in its gallery.
   Do not auto-create profiles or prefill from private auth data.
3. **Profile lifecycle.** Owner may change the label or disable the profile; stable
   creator ID survives toggles. Restricted publishers' profiles and creator links
   are unavailable, even if they try to reactivate. Use existing server-configured
   moderator privileges and publisher restrictions; admins can resolve a creator ID
   to its owner through an admin-only lookup for the existing restriction action.
   Account deletion cascades its profile. Turning a profile off does not unpublish
   its shaders. Public reads and profile galleries return 404 for unavailable profiles
   and use no-store, consistent with publication reads.
4. **Profile routes.** `GET /api/creators/:creatorId` returns `{ creator: { id,
displayName } }`; `GET /api/creators/:creatorId/publications` returns the existing
   `PublicationPage`. `GET /api/me/creator-profile` returns `{ profile: null | {
id, displayName, ownerVisible, revision } }`; `PUT` accepts `{ displayName,
ownerVisible, expectedRevision }` (0 means create), using transactional uniqueness
   and compare-and-set, 409 on conflict. Cookie writes use TrustedOriginGuard, verified
   auth and the established error envelope; limit profile writes to 30/account/hour.
   Add `GET /api/admin/creators/:creatorId` for moderator-only owner resolution.
5. **Author links.** Optional `creator: { id, displayName }` on public publication
   summaries/details only when the profile is public and unrestricted. Existing
   frozen `authorLabel`, licenses and attribution never change with a profile rename.
   Show the snapshot author label with a separate clear link to the current profile.
   Creator gallery and author links must apply current publication moderation and
   owner visibility, not query private `shaders` for content. Reuse deterministic
   keyset paging and existing page-size/cursor validation.
6. **Remix meaning.** A remix is an explicitly published copy made through existing
   copy-to-library; it need not prove content differences. Private copies are never
   listed or counted. Show direct children only, not an ancestry tree or ranking.
   `GET /api/publications/:id/remixes` returns a `PublicationPage` of currently public
   publications whose server-recorded immediate origin is that ID. Parent must be
   public or the endpoint returns 404. Entries use current creator links from task 01.
7. **Durable provenance.** Add a nullable indexed relational immediate-source ID to
   publications in a new additive migration, without a cascading source foreign key.
   The migration runner exposes only a statement executor, so add the column/index
   there, then backfill valid existing `derived_from_json` via the store executor in
   bounded idempotent initialization batches before community reads are exposed.
   Use conditional writes against the observed JSON so concurrent publication updates
   cannot be overwritten; restart/repeated initialization must be safe on both engines.
   Unparseable legacy origins are not fabricated. Set it transactionally from trusted
   origin on publication creation/update. Preserve historical title/author/license
   credits if the source is hidden/deleted; disable unavailable source links and never
   reveal fresh hidden content. Extend new origins with optional `revision` from the
   copied public snapshot, preserving legacy/import/export compatibility (unknown
   revisions stay unknown). Updating an original neither overwrites its remixes nor
   moves existing copies to the new revision. Preserve share-alike enforcement.
8. **Web navigation.** `/creators/:creatorId` is a standalone web page like Explore;
   update RoutingCoordinator recognition so hydration/library loading cannot normalize
   it to the editor route or discard unsaved work. Put authenticated profile editing
   behind a small entry on the creator/Explore surface. Remix action reuses existing
   copy semantics and verified-account prompt; publishing stays an explicit action.

## Acceptance and responsibility

| ID          | Criterion                                                                                            | Owner                             |
| ----------- | ---------------------------------------------------------------------------------------------------- | --------------------------------- |
| AC-GATE     | Flag matrix, missing capability, legacy client compatibility, desktop excluded                       | 01; coordinator rechecks after 02 |
| AC-PROFILE  | Explicit verified-owner profile creation/edit/deactivation, stable ID, conflict and privacy behavior | 01                                |
| AC-GALLERY  | Public paginated gallery, author links, visibility/restrictions/deletion, admin-only resolution      | 01                                |
| AC-NAV      | Deep-link/hydration/back navigation and unsaved editor preservation, FR/EN states                    | 01; 02 for remix UI               |
| AC-REMIX    | Copy → edit → publish → direct remix listed, no private-copy leakage, deterministic pages            | 02                                |
| AC-ORIGIN   | Durable immediate-source attribution/revision, legacy backfill, deletion and licensing               | 02                                |
| AC-DELIVERY | Additive SQLite/PostgreSQL migrations, full integration CI and browser evidence                      | coordinator                       |

## Tasks and waves

| Task | Primary outcome                                       | Dependency                 | Branch                        | Base policy     | Delivery         |
| ---- | ----------------------------------------------------- | -------------------------- | ----------------------------- | --------------- | ---------------- |
| 01   | Opt-in public creator profile and gallery, end to end | none                       | `codex/community-01-profiles` | integration-tip | integration-only |
| 02   | Public direct-remix discovery, end to end             | 01 accepted and integrated | `codex/community-02-remixes`  | integration-tip | integration-only |

Wave 1 launches 01 from integration initialized at source HEAD. Gate: targeted
profile checks pass; record accepted commit, capabilities, API and migration version.
Wave 2 launches 02 only after accepted 01 commits are reachable from integration.
Resolve `git rev-parse codex/integrate-community` immediately before each launch,
record the exact SHA and clean initial status. Never use a moving name as a base SHA.

Worker sibling paths are `E:/Adel/Documents/Orgs/shader-studio-community-01` and
`E:/Adel/Documents/Orgs/shader-studio-community-02`; do not create them in planning.
Coordinator supplies this README and the corresponding prompt directly, or gives
the verified planning commit and `git show <plan-commit>:docs/feature-plans/community/...`.
Source-based worker branches will not automatically contain the plan files.

Each worker owns one narrow product boundary across its required layers. Supporting
registration, migrations, i18n and tests are allowed only for that boundary. Shared
files are edited sequentially; task 02 preserves task 01 contracts. Coordinator owns
conflict resolution, integration evidence and final checks. Workers make 1–3 logical
commits, inspect the complete diff and report SHAs, checks, skips and residual risks.

## Verification and E2E gate

Worker-specific checks are in their prompts. Coordinator runs `pnpm run ci` once
against the final accepted integration tip (includes lint, format, i18n, typecheck,
tests, builds and SSR smoke), plus desktop web build `pnpm --filter @shadergrove/web
build:desktop` for route/provider exclusion. Add profile routes to the web no-store
path handling at `apps/web/src/server/index.ts`; inspect deep-link SSR in the built
server. A successful build alone is not browser evidence.

Run migration/domain conformance on SQLite and real PostgreSQL. Existing PostgreSQL
harness drops the public schema: only use an explicitly disposable database via
`SHADER_TEST_DATABASE_URL`; never inherit a user's DATABASE_URL for these tests.
Use the existing single PostgreSQL harness for new conformance suites to avoid
parallel schema drops. Missing PostgreSQL or browser access is a validation gap,
not a passed check; complete source work and report the gap before delivery.

Critical browser scenarios, with two accounts and anonymous session:

- E2E-1: Verified A creates/activates a profile; anonymous visits its URL/gallery and
  publication author link. B cannot modify A; no email/user/private shader IDs appear.
- E2E-2: B copies A's public shader, edits and publishes it: listed once under A's
  remixes, B's profile link works, original credits/license survive. Unpublished copy
  never appears. Copying B's remix and publishing C points directly to B, not A.
- E2E-3: Original update preserves copied revision. Hide/unpublish/delete a remix and
  check galleries/remix list; hide/delete original and check 404 source endpoint,
  unavailable source link, retained historical credits in still-public descendants.
- E2E-4: Deactivate/rename profile, restrict its publisher, delete account; refresh
  every public entry without cached identity or hidden-publication leakage. Two
  concurrent owner edits produce one revision conflict, not duplicate profiles.
- E2E-5: Browse/deep-link/reload/back through creator and publication pages with an
  unsaved shader open; editor state persists. Exercise FR/EN, empty/loading/error
  and pagination states; keyboard links/form controls work.
- E2E-6: Community off / Explore on, both off, and old server missing capability;
  new routes and controls unavailable while existing Explore behavior remains.
  Desktop cannot instantiate web-only community HTTP services.

## Delivery and cleanup policy

Integrate accepted worker commits locally; do not push, open PRs or merge remotely
without a later explicit instruction. A suitable authorization is “Review completed
community tasks and open a PR to develop”; merging requires separate authorization.
Reassess delivery classification only if prerequisites subsequently land on master.
Keep unfinished community behavior disabled. Retain worker/integration checkouts
through review; cleanup follows the execution/review workflow, never planning cleanup.

Plan verification: stage only this directory, confirm every branch-changed path is
under root docs, commit, verify the clean temporary worktree and branch SHA, remove
that exact temporary worktree without force from the original checkout, retain branch.
If cleanup fails, retain it and report the exact safe next step.

## Deferred backlog — no executable prompts yet

- Next milestone: favorites (private account bookmarks), private/public collections,
  ordered items, sharing, ownership and hidden/deleted publication handling.
- Then: comments and one-level replies, author badge, bounded code formatting,
  owner deletion, report/moderator hide, rate limits and captured publication revision.
- Then: follow/unfollow creators and subscriptions feed; in-app notifications for
  replies, new public remixes and followed creators' new publications. Specify event
  identity, deduplication, read state and unpublish/restriction behavior before coding.
- Profile refinements: moderated biography/links, avatar strategy, handles and search.
- Desktop community parity and optional email delivery are separate decisions.
- Later only: creative challenges, dedicated pedagogical shader features, curated
  community/editorial selections. No prompts or launch commitment for these.

## Machine-readable handoff

```yaml
review_contract:
  milestone: community-phase-1-creators-remixes
  planning_ref: codex/plan-community
  source_base: 'd64762a962395f7dd53e203f52a0f89b65314595'
  default_branch: master
  integration_branch: codex/integrate-community
  tasks:
    - id: '01'
      branch: codex/community-01-profiles
      depends_on: []
      acceptance: [AC-GATE, AC-PROFILE, AC-GALLERY, AC-NAV]
      checks:
        - 'pnpm --filter @shadergrove/backend test -- src/community/creator.spec.ts'
        - 'pnpm --filter @shadergrove/api test -- src/community/creators.spec.ts'
        - "pnpm --filter @shadergrove/web exec ng test --watch=false --include='src/app/community/**/*.spec.ts' --include='src/app/workspace/routing-coordinator.spec.ts'"
        - 'pnpm check:i18n'
      delivery: integration-only
      base_policy: integration-tip
      feature_flag: PUBLIC_COMMUNITY_ENABLED
    - id: '02'
      branch: codex/community-02-remixes
      depends_on: ['01']
      acceptance: [AC-REMIX, AC-ORIGIN, AC-NAV]
      checks:
        - 'pnpm --filter @shadergrove/backend test -- src/publication/publication.spec.ts'
        - 'pnpm --filter @shadergrove/api test -- src/publications/publications.spec.ts'
        - "pnpm --filter @shadergrove/web exec ng test --watch=false --include='src/app/publications/**/*.spec.ts'"
        - 'pnpm check:i18n'
      delivery: integration-only
      base_policy: integration-tip
      feature_flag: PUBLIC_COMMUNITY_ENABLED
  integration_checks:
    - 'pnpm run ci'
    - 'pnpm --filter @shadergrove/backend test -- src/persistence/postgres/postgres-repository.spec.ts'
    - 'pnpm --filter @shadergrove/web build:desktop'
  e2e_scenarios: [E2E-1, E2E-2, E2E-3, E2E-4, E2E-5, E2E-6]
  deferred:
    - favorites-and-private-public-collections
    - comments-and-replies
    - creator-following-and-subscriptions-feed
    - in-app-notifications
    - profile-refinements-and-desktop-parity
    - challenges-pedagogical-features-curated-selections
```
