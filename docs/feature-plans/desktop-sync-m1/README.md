# Desktop Account Sync — Milestone 1

## Goal and milestone

Let a desktop user connect the app to their web account and keep chosen local shaders in sync with it, while the local library stays fully usable offline and without an account.

The design is **local-first**. On the desktop, the SQLite library remains the only thing the editor reads and writes (`DesktopShaderApi` does not change). The account is a sync target, and the Electron main process drives all sync. The renderer never sees a credential. It receives only account state and a sync status for each shader.

Milestone 1 is complete when a desktop user can:

1. sign in through the system browser and sign out;
2. upload a local shader, or all of them, to the account on demand;
3. see a status icon on each shader and a progress bar while sync runs;
4. edit a linked shader offline and have it pushed automatically on the next connection;
5. get a "keep both" resolution when the same shader was also changed on the web.

Milestone 2 adds pulling from the account and deletion handling; see the deferred backlog.

### Decisions (agreed with the product owner)

- Sync is **bidirectional** in the full feature. Milestone 1 pushes, and it pulls only what a conflict needs.
- A local shader is uploaded only when the user asks. Once linked, it syncs automatically.
- The only conflict resolution is **keep both**. The linked shader takes the account version, and the local version becomes an unlinked copy named `<name> (conflict)`.
- Sign-in uses the **system browser**, as planned in `docs/authentication-authorization-plan.md`. There is no password form inside the desktop app.
- Deletion (milestone 2): the user chooses between unlinking and deleting everywhere. A shader deleted on the web is unlinked and its local copy is kept. "Delete everywhere" while offline is queued.

### Non-goals for this milestone

Pulling shaders created on the web, deleting on either side, any resolution other than "keep both", session management UI on the desktop (it links to the web instead), and byte-level progress.

## Planning and launch context

- Planning ref: `codex/plan-desktop-sync`
- Plan path: `docs/feature-plans/desktop-sync-m1/`
- Source base used for planning: `66bdcbd37186873d9b4112cb08471118e319d8d0` (`develop`)
- Default branch: `master`. **PR target: `develop`**, because it is 6 commits ahead of `master` with the auth fixes this feature relies on. Switch to `master` only once those commits are reachable from it.
- Remote: `origin` (`https://github.com/antelm-dev/shader-studio.git`)
- Integration branch (Task 04 only): `codex/integrate-desktop-sync-m1`

Give each worker this README and its numbered prompt directly, or the planning ref plus both paths. A source branch does not contain these plan files. At launch, replace `<exact-launch-base>` with a recorded SHA resolved from the task's base policy.

## Shared contracts

**C1 — Summary revision (Task 01).** `ShaderSummary` gains `revision: number`. The change is additive and returned by both engines and by every transport.

**C2 — Replace with revision (Task 01).** `ShaderLibrary.replaceFromPayload(id, payload, expectedRevision)`, exposed as `PUT /api/shaders/:id/bundle` with body `{ bundle: ShaderBundle, expectedRevision: number }` and response `{ shader: ShaderRecord }`. In one transaction it replaces content, presets, textures and thumbnail. It keeps `id`, owner, `kind` and `createdAt`, and sets `revision` to `expectedRevision + 1`. A stale revision returns `409 conflict`. The call is scoped, so another user's shader returns `404`. A template is refused. The shared `ShaderApi` does not gain this method; only the desktop sync service calls the endpoint.

**C3 — Desktop handoff (Task 02).** Sign-in follows OAuth-style PKCE (RFC 8252):

1. The desktop opens `<server>/desktop/connect?state=<s>&code_challenge=<S256>` in the system browser.
2. That web page makes the user sign in if needed, then calls `POST /api/desktop/handoff { codeChallenge }` with the cookie session. The server returns `{ code }`: a one-time code that lives 60 seconds, stored in Better Auth's `verifications` table.
3. The page navigates to `shader-studio://auth/callback?code=<c>&state=<s>`.
4. The desktop calls `POST /api/desktop/token { code, codeVerifier }`. The server returns `{ token, user }` for a **new** server session, created with the user agent `Shader Studio Desktop`, so it appears in the account's session list and can be revoked there.
5. After that, every desktop request sends `Authorization: Bearer <token>`, handled by Better Auth's `bearer` plugin.

**C4 — Main-process account (Task 03).** Module `apps/desktop/main/src/account/account-session.ts` exports:

```ts
interface AccountSession {
  state(): AccountState; // { status: 'disabled'|'signed-out'|'signed-in'|'reauth-required', user?: { id, name, email } }
  onChange(listener: (state: AccountState) => void): () => void;
  /** net.fetch against the configured server with the bearer token; marks `reauth-required` on 401. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
}
```

The status is `disabled` when no server URL is configured. That is the milestone's feature flag: the environment variable `SHADER_STUDIO_ACCOUNT_URL`, embedded at build time. With no URL, the desktop behaves exactly as it does today. The token is encrypted with `safeStorage` and stored in `userData`, never in the renderer.

**C5 — Sync state (Task 04).** Links are kept in `storage_metadata` under `sync_links:<accountUserId>`, as JSON: `{ [localId]: { remoteId, remoteRevision, localRevision } }`. No migration is needed. A shader is **dirty** when `summary.revision > link.localRevision`. The renderer receives the IPC event `sync-changed` with `{ statuses: Record<localId, SyncStatus>, progress: { done, total } | null }`, where `SyncStatus` is one of `local-only | synced | pending | syncing | conflict-resolved | reauth-required | other-account | error`. Templates (`kind === 'template'`) never get a status.

## Acceptance criteria

- **AC-API-01** Summaries carry `revision` on SQLite and Postgres (conformance).
- **AC-API-02** Replace-with-revision is atomic and scoped: stale → 409, foreign → 404, template → refused, revision = expected + 1, children replaced.
- **AC-AUTH-01** The handoff code is single-use, expires after 60 s, is bound to its PKCE challenge, and is issued only to a signed-in, verified session.
- **AC-AUTH-02** A desktop bearer session is a normal revocable session: after revocation on the web, the desktop's next request gets 401 → `reauth-required`.
- **AC-DESK-01** With no URL configured, the account UI is absent and desktop behaviour is unchanged.
- **AC-DESK-02** Browser sign-in completes through the deep link, whether the app is already running (`second-instance`) or started by the link. A wrong `state` is rejected.
- **AC-DESK-03** The token is stored only in encrypted form. Signing out revokes the server session and deletes the stored token.
- **AC-SYNC-01** Uploading one shader or "Upload all" links shaders, and the status becomes `synced`.
- **AC-SYNC-02** A linked shader edited offline shows `pending` and is pushed on reconnect or sign-in, and after each save while online. A progress bar counts the shaders.
- **AC-SYNC-03** A 409 on push leads to "keep both": the linked slot takes the account version and an unlinked `(conflict)` copy keeps the local edits. No data is lost.
- **AC-SYNC-04** Links belong to one account: while account B is signed in, shaders linked to A show `other-account` and are never pushed.
- **AC-SYNC-05** A 401 during sync stops the run and shows `reauth-required`; local data is untouched. A 404 on push (deleted remotely) unlinks the shader and shows `local-only`.

## Tasks and delivery

| ID | Primary outcome | Depends on | Branch / sibling worktree | Delivery | Base policy |
| --- | --- | --- | --- | --- | --- |
| 01 | Summary revision + replace-with-revision (library, both engines, REST) | — | `codex/desktop-sync-01` / `shader-studio-wt-desktop-sync-01` | `default-branch-pr` → `develop` | `latest-default` |
| 02 | Server + web desktop handoff (bearer, handoff/token endpoints, `/desktop/connect`) | — | `codex/desktop-sync-02` / `shader-studio-wt-desktop-sync-02` | `default-branch-pr` → `develop` | `latest-default` |
| 03 | Desktop sign-in client (deep link, PKCE, safeStorage, account IPC, account menu) | 02 merged | `codex/desktop-sync-03` / `shader-studio-wt-desktop-sync-03` | `default-branch-pr` → `develop` (flag: `SHADER_STUDIO_ACCOUNT_URL`) | `latest-default` |
| 04 | Push sync engine + status icons + progress | 01 merged; C4 contract (03 in parallel) | `codex/desktop-sync-04` / `shader-studio-wt-desktop-sync-04` | `integration-only` → `codex/integrate-desktop-sync-m1` | `latest-default` at launch, integrated on top of 03 |

**Budget exception:** 4 tasks instead of 3. The smallest milestone a user can actually use crosses the server, the web app, the Electron main process and the renderer. Merging 03 and 04 would give one worker about 12 files. Tasks 01 to 03 are each safe to deploy on their own: additive API, endpoints and a page that nothing calls yet, and desktop sign-in behind a URL that must be configured. Task 04 is useless without 03, so it goes through the integration branch.

## Execution waves

**Wave 1 — Tasks 01 and 02 in parallel.** Gate: backend conformance and server specs pass, the review accepts contracts C1, C2 and C3, and both PRs are merged into `develop`.

**Wave 2 — Tasks 03 and 04 in parallel,** both launched from the refreshed `develop` SHA. Task 04 codes against C4 with a fake `AccountSession`. Gate: Task 03 merged into `develop`. The coordinator then creates `codex/integrate-desktop-sync-m1` from the refreshed `develop`, merges Task 04 into it, and resolves conflicts. The expected conflict points are `apps/desktop/main/src/main.ts` (IPC registration), `apps/web/src/app/app.html`, the i18n catalogs and the generated `libs/desktop-api/src/ipc-bridge.ts` (run `pnpm gen:ipc` again rather than resolving that file by hand). It runs the integration gate, then opens a PR from the integration branch to `develop`.

## Verification

Each prompt lists its worker checks. Integration gate, run by the coordinator:

```text
pnpm ci
pnpm build:desktop
git diff --check
```

Critical E2E scenarios, run against `pnpm dev:server` plus a desktop build with `SHADER_STUDIO_ACCOUNT_URL` set:

1. **E2E-1:** Sign in from the desktop through the browser. The account menu shows the user. Upload two shaders; they appear on the web with the same content, textures and presets.
2. **E2E-2:** Go offline (stop the server). Edit a linked shader; its status is `pending`. Restart the server; the push runs automatically with progress, and the web shows the edit.
3. **E2E-3:** Edit the same linked shader on the web, then on the desktop. The push gets 409. The desktop now holds the web version plus a `(conflict)` copy with the desktop edits.
4. **E2E-4:** Revoke the desktop session from the web account dialog. The next desktop sync shows `reauth-required`. Sign in again; the pending push completes.
5. **E2E-5:** Sign out and sign in as a second account. The first account's links show `other-account`, and nothing appears in the second account.

Workers report: commits, the checks they ran with their results, acceptance IDs covered, and open risks.

## Policies

- Planning does not authorize any remote action. To open or merge PRs, the coordinator uses: `Review completed tasks and open or merge eligible PRs`.
- A PR counts as landed only when it is merged and reachable from the refreshed `develop`.
- The coordinator owns conflicts on the integration branch. Worktrees are removed after their branch is merged.
- Workers never touch `.env` or the files another task owns.

## Deferred backlog (milestone 2, not executable)

- **Pull:** download account shaders that are not linked, stored in SQLite under `owner_user_id = <accountUserId>`. They are visible while that account has a stored session, even offline, and hidden after sign-out or under another account. `DesktopShaderApi` lists both scopes. Remote-only changes are pulled automatically; changes on both sides lead to "keep both".
- **Deletion:** a local delete dialog offering "Unlink" or "Delete everywhere". Offline, "Delete everywhere" is queued in `sync_tombstones:<account>`, and if the shader changed on the web in the meantime the user is warned instead. A remote delete unlinks the shader and keeps the local copy.
- Opening the web session management from the desktop account menu, if it is not already done in 03.
- Byte-level progress for large textures, only if count-based progress turns out to be insufficient.

```yaml
review_contract:
  milestone: desktop-sync-m1
  planning_ref: codex/plan-desktop-sync
  source_base: "66bdcbd37186873d9b4112cb08471118e319d8d0"
  default_branch: master
  pr_target: develop
  integration_branch: codex/integrate-desktop-sync-m1
  tasks:
    - id: "01"
      branch: codex/desktop-sync-01
      depends_on: []
      acceptance: [AC-API-01, AC-API-02]
      checks: ["pnpm nx run @shader-studio/backend:test", "pnpm nx run @shader-studio/server:test"]
      delivery: default-branch-pr
      base_policy: latest-default
    - id: "02"
      branch: codex/desktop-sync-02
      depends_on: []
      acceptance: [AC-AUTH-01, AC-AUTH-02]
      checks: ["pnpm nx run @shader-studio/server:test", "pnpm nx run @shader-studio/web:test", "pnpm check:i18n"]
      delivery: default-branch-pr
      base_policy: latest-default
    - id: "03"
      branch: codex/desktop-sync-03
      depends_on: ["02"]
      acceptance: [AC-DESK-01, AC-DESK-02, AC-DESK-03]
      checks: ["pnpm gen:ipc", "pnpm nx run @shader-studio/desktop:test", "pnpm nx run @shader-studio/web:test", "pnpm check"]
      delivery: default-branch-pr
      base_policy: latest-default
      feature_flag: SHADER_STUDIO_ACCOUNT_URL
    - id: "04"
      branch: codex/desktop-sync-04
      depends_on: ["01", "03"]
      acceptance: [AC-SYNC-01, AC-SYNC-02, AC-SYNC-03, AC-SYNC-04, AC-SYNC-05]
      checks: ["pnpm gen:ipc", "pnpm nx run @shader-studio/desktop:test", "pnpm nx run @shader-studio/web:test", "pnpm check"]
      delivery: integration-only
      base_policy: latest-default
  integration_checks: ["pnpm ci", "pnpm build:desktop", "git diff --check"]
  e2e_scenarios:
    - "desktop signs in via browser and uploads two shaders"
    - "offline edit of a linked shader is pushed on reconnect with progress"
    - "concurrent web and desktop edits resolve as keep both"
    - "revoked desktop session shows reauth-required and recovers"
    - "second account never receives the first account's shaders"
  deferred: [pull-account-shaders, deletion-unlink-or-everywhere, offline-delete-queue]
```
