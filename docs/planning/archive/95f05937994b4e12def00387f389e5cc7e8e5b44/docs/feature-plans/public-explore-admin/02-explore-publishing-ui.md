# Worker 02 - Explore and owner publishing

Read the supplied coordinator README and task 01's frozen API contract first.

## Mission, launch and isolation

Deliver anonymous Explore/detail/copy and verified-owner publish/update/unpublish UX. Delivery: `integration-only`; base policy `integration-tip`; prerequisite: task 01 accepted with tested DTOs/API. Coordinator supplies exact accepted integration SHA `<exact-launch-base>`, seeded from task 01 or its merged master result.

Branch `codex/public-explore-admin-02`; sibling worktree `E:/Adel/Documents/Orgs/shader-studio-public-02`. Coordinator uses managed isolation where available or guarded `git worktree add <path> -b <branch> <exact-launch-base>`. Verify clean initial status.

## Ownership and context

Own new `apps/web/src/app/publications/` API/state/pages/dialogs/tests and minimal integration in private browser/workspace actions. Own `app.routes.ts`, workspace `routing-coordinator.ts`, navigation and shared translation catalogs/keys for both Explore and admin. Primary boundary is public client UI; limit private-store changes to copying and saved-source publication actions.

Inspect `ui/browser/shader-browser.ts`, `api/shader-api.ts`, `workspace/shader-store.ts`, `workspace/routing-coordinator.ts`, `ui/workspace-actions.ts`, auth service, desktop/output capabilities, asset/rendering facilities and SSR route configuration. Public snapshots must not become private ShaderStore records merely by being viewed. Existing private routing effects can overwrite new URLs if not explicitly excluded.

## Required work

Add `/explore` and `/explore/:publicationId` with accessible search, pagination, static thumbnails, loading/empty/error states, public author/license and stable share link. Anonymous detail is readable without opening auth. Reuse rendering facilities in a bounded client-only explicit preview; stop/dispose on navigation, contain compile/context failures and keep SSR free of WebGL work. Copy prompts sign-in/verification when necessary, invokes protected copy API, then opens the new private record with attribution, presets/textures/post-process chain preserved.

Add owner publish/update/unpublish from My Shaders: save first or clearly reject unsaved/unpersisted source, explicit license/rights confirmation, current publication state, stable URL, conflict/restriction feedback. Draft edits never silently update public snapshots. Preserve existing unsaved-navigation and account-change behavior. Gate all entry points by server capabilities; handle disabled server/no network. Phase 1 web-only, no desktop/output cloud calls or sync changes.

Coordinate task 03 labels using README's admin key contract; own all catalog/key modifications. Task 03 owns its component/client and cannot edit routes/catalogs. Report the pending `AdminPublicationsPage` route registration for coordinator integration; do not import its unavailable component on your independent branch. Add final admin entry point only when capability permits. Inspect actual SSR layout/router outlet so new pages are visible, not merely registered.

## Verification and delivery

Cover AC-EXPLORE, AC-OWNER, AC-REGRESSION: public routing unaffected by private selection, direct SSR URLs, paging/errors, copy fidelity, explicit preview cleanup, unsaved navigation cancel, expiry/account switch, flag off, offline desktop/output. Run focused Angular specs (verify include CLI support) and web typecheck; provide concrete browser scenarios for coordinator.

Out of scope: backend contracts, admin components, standalone effects, visual redesign/social features. Intended destination integration branch only; feature stays default-off pending full milestone gate. No remote actions without authorization.

Make 1-3 logical commits, review complete diff and report exact base/HEAD, commits, paths, acceptance evidence, check results, pending admin wiring and risks.
