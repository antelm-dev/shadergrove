# Worker 01 — opt-in public creator galleries

Read the coordinator README supplied alongside this prompt. Implement only its
Phase-1 creator boundary; this prompt does not authorize remote actions.

## Launch and isolation

Delivery: `integration-only`; base policy: `integration-tip`. No worker prerequisite.
Coordinator initializes `codex/integrate-community` at the README source SHA, then
supplies `EXACT_LAUNCH_BASE=<resolved SHA>` plus the plan commit/documents.

```text
git worktree add E:/Adel/Documents/Orgs/shader-studio-community-01 -b codex/community-01-profiles <EXACT_LAUNCH_BASE>
cd E:/Adel/Documents/Orgs/shader-studio-community-01
git status --short --branch
```

Require clean initial status; preserve unrelated files and inspect local instructions.

## Mission and owned boundary

Deliver a usable web path: verified owner explicitly activates a public profile,
anonymous visitors follow author links and browse that creator's visible publications.
Primary ownership is the new narrow `community` profile domain across
`libs/backend/src/community/`, `libs/api/src/community/`, and
`apps/web/src/app/community/`, plus its shared contract in
`libs/shared/src/publication.ts`. Prefer a small number of focused files, following
existing publication patterns; no generic social framework.

Supporting edits are allowed for SQLite/PostgreSQL additive migrations/repository
wiring and exports, Nest module/server composition, capability/configuration,
public publication creator projection, web routes/routing recognition, and FR/EN
catalogs/typed keys. Source API registration is currently under `libs/api/src/`;
locate its actual feature module imports before editing. No unrelated refactors.

## Required behavior

Implement README contracts 1–5 and 8 exactly: default-off flag, optional capability,
explicit opaque identity, owner-only profile routes, paginated gallery, separate
profile author link, and stable frozen author labels. No private-auth autofill.
Require verified trusted-origin writes; cap profile writes at 30/account/hour.
Use transactional one-profile-per-owner uniqueness and revision compare-and-set.
Off/deactivated/restricted profiles return public 404, leak no private owner IDs,
and remain excluded from creator links. Admin-only creator resolution supports the
existing publisher restriction action. Account deletion cascades profiles.

Add an additive migration after the existing version 4 for both engines; no
rewriting old migrations. Reuse existing public visibility and SQL executor patterns.
Profile reads/author projections respect current restrictions, including profiles
created after a restriction. Public gallery never exposes private copies or hidden
publications. Flag rollback preserves stored rows and existing Explore behavior.

Add creator page/editing states, explicit activation explanation, FR/EN labels,
web-only guard/provider access, route coordinator recognition, and built-server
no-store path handling. Preserve the open editor and unsaved shader during navigation.

## Exclusions and verification

No remixes endpoint/index/revision-origin changes (worker 02), favorites, collections,
comments, following, notifications, biography/links/avatar uploads or desktop HTTP.

Acceptance: AC-GATE, AC-PROFILE, AC-GALLERY, AC-NAV; E2E-1, E2E-4–6.
Run the four task-01 commands in README YAML. Add meaningful tests for auth/privacy,
concurrent create/edit, migration of an existing library, gallery visibility/paging,
missing capability, and route/editor preservation. Extend shared conformance and
the existing PostgreSQL harness for coordinator-run real-engine validation.
Report browser scenarios exercised and any unavailable PostgreSQL/browser checks;
skips are not passes. Check the complete diff and typecheck touched projects as needed.

## Delivery

Make 1–3 logical commits. Report SHAs, changed boundaries, frozen API/capability
shape, migration version, acceptance evidence and risks. Destination is local
`codex/integrate-community`; integration acceptance unlocks worker 02. Remain behind
PUBLIC_COMMUNITY_ENABLED; no pushes/PRs/merges without later user authorization.
