# Worker 03 - minimal administration UI

Read supplied coordinator README and task 01's frozen API contract first.

## Mission, launch and isolation

Deliver a small internal interface for publication moderation, reports and publishing restrictions. Delivery: `integration-only`; base policy `integration-tip`; prerequisite task 01 accepted. Coordinator supplies exact integration SHA `<exact-launch-base>`.

Branch `codex/public-explore-admin-03`; sibling worktree `E:/Adel/Documents/Orgs/shader-studio-public-03`. Coordinator creates managed isolation where available or guarded `git worktree add <path> -b <branch> <exact-launch-base>`. Verify clean initial status. Launch in parallel with task 02 only after wave 1 gate.

## Owned scope and context

Own new `apps/web/src/app/admin/admin-api.ts`, `admin-publications-page.ts`, a small admin state file if needed and focused specs. Export `AdminPublicationsPage` for `/admin/publications`. Task 02 exclusively owns route registration/navigation, RoutingCoordinator and shared i18n catalogs/keys; do not edit those files. Send extra required labels early, using README's shared admin translation keys. Coordinator attaches the final route import after both UI branches are integrated.

Inspect existing auth/HTTP error handling, Material components, i18n/translate pipe and task 01 capabilities/admin DTOs. UI admin visibility is convenience only; server checks every action. Keep reports/publisher identity/history in admin state separate from private ShaderStore and public DTOs.

## Required work

Build accessible paginated/searchable list of public and hidden publications, author/public ID/state and drill-down into reported snapshots. Use static previews/source inspection; if renderer is reused, require explicit client-side execution and cleanup/error isolation. No analytics charts or generic database editor.

Support hide/restore with required reason, current revision and clear state feedback; inspect reports and resolve them; restrict/restore publisher access by server-provided immutable user ID. Show consequences: restricting hides existing publications and blocks publishing but preserves private editing; lifting restriction does not automatically restore publications. Respect owner-unpublished state. Show durable action history from server; never fabricate success from local state.

Handle loading/empty/failure and stale-write conflicts by refreshing without discarding the operator's reason unnecessarily. Disable duplicate pending mutations. On unauthorized/expired session or account switch, clear admin records promptly; do not retain another account's privileged data or automatically replay moderation. Capability false/flag off means no admin data fetches. UI and SSR must not leak privileged data through shared caches or transfer state.

## Verification and delivery

Cover AC-ADMIN, AC-MODERATION, AC-REGRESSION through focused component/client/state tests: configured admin workflows, denied user/direct page, required reason, conflict refresh, failed write, duplicate click, report pagination, restriction/restore semantics, action history and session/account clearing. Run focused Angular specs (verify include option) and web typecheck using README commands. Provide reproducible browser E2E steps for coordinator; backend authorization/audit proof belongs to task 01.

Out of scope: role assignment, passwords/full account bans, private-library access, backend/persistence changes, route/catalog edits, analytics, redesign. Intended destination integration branch, with final admin route wiring coordinator-owned; feature remains disabled until full gate. No remote actions without explicit authorization.

Make 1-3 logical commits; review full diff. Report exact base/HEAD, commits, changed files, acceptance evidence, actual checks/skips, export contract, translation requests and remaining risks.
