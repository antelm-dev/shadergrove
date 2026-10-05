# Release readiness

Use this checklist for the exact commit being released. Record the commit,
commands, outcomes and manual evidence in the release PR. A checked box requires
an actual result; a passing unit suite does not replace a packaged-app check.

## Automated gates

- [ ] Run `pnpm run ci`: lint, formatting, i18n/fonts/IPC checks, TypeScript,
      workspace tests, production builds and built-server readiness smoke. On Windows, if Nx's daemon prevents
      startup, retry with `$env:NX_DAEMON = 'false'` and record the limitation.
- [ ] Confirm all GitHub CI jobs pass on the release candidate: checks/builds,
      UI smoke, Docker image build and Windows desktop package. CI runs on PRs and
      pushes to `develop`, `main`, `master` and `preview`.
- [ ] For a standalone built-server check, run `pnpm build && pnpm smoke:ssr`.
      This checks production startup, anonymous readiness, protected library access,
      sanitized initialization failure and retry recovery using disposable SQLite.
      When server dependencies change, also follow the
      [server dependency checklist](../README.md#server-dependency-changes): this
      smoke does not exercise PostgreSQL or the Docker runtime dependency tree.
- [ ] Run `pnpm smoke` for the real browser workflow and plugin sandbox probes.
- [ ] Build the Windows package with `pnpm pack:win`. For an account-enabled
      build, set `SHADER_STUDIO_ACCOUNT_URL` before building; otherwise verify that
      account controls are disabled. An unpacked package does not validate installer
      protocol registration.

## Deployment checks

Use a disposable deployment with PostgreSQL, HTTPS, SMTP and production auth
settings. Keep real credentials out of release evidence.

- [ ] `docker compose up -d --build` succeeds and `docker compose ps` shows
      healthy containers. The app's probe calls `GET /api/health` without a cookie.
- [ ] `/api/health` returns `200` and `{ "status": "ok" }` with no library
      data; `/api/shaders` without a session returns `401`.
- [ ] Database initialization failure returns a generic `503`. A temporary
      database outage makes readiness fail; a later probe recovers after service
      returns. Health responses use `Cache-Control: no-store`.
- [ ] Verification and password-reset mail arrive with links to the configured
      public origin. SMTP delivery is not covered by the readiness endpoint.
- [ ] Two accounts cannot access each other's shaders, exports or assets.
- [ ] Closing registration leaves existing sign-in working.
- [ ] Back up the database, restore it to a disposable instance, and verify
      accounts, projects, presets and assets survive. Check the upgrade path from
      the previous released schema, including ownership claims for legacy data.

## Packaged desktop checks

- [ ] Install and launch the Windows installer; create, save, close and reopen a
      local shader while offline. Verify the portable executable separately.
- [ ] On an account-enabled build, sign in through the system browser and return
      through the registered `shader-studio:` protocol. Check cancellation and
      signing out during sign-in as well as a successful round trip.
- [ ] Upload a local shader, edit it offline, reconnect and verify the saved
      change reaches the correct account. Test a conflict and verify both versions
      survive, including the currently open editor's draft.
- [ ] Switch accounts and verify uploads never cross account boundaries; signing
      out keeps the local library available.
- [ ] Verify textures, presets, thumbnails, output windows and image/video export
      in the packaged application.

## Documentation and publication

- [ ] README, deployment guide and release notes describe the shipped behavior:
      web accounts, optional desktop accounts, upload-first sync, explicit MCP
      activation, and the plugin host's prototype status.
- [ ] State which desktop builds include an account server. CI and release builds
      currently omit `SHADER_STUDIO_ACCOUNT_URL`, so accounts are disabled unless
      their build environment is explicitly configured.
- [ ] Record remaining manual checks and limitations; do not call the release
      validated while required checks remain open.

The release workflow runs on `master` (or manual dispatch). Release Please
prepares the release PR; when a release is created, the workflow builds and
publishes Windows installers plus the Linux/macOS platforms explicitly enabled
in Actions variables. A shared publication job verifies all required installers
and update manifests before making the draft public. See
[website releases and desktop distribution](website-releases.md) for activation,
signing prerequisites, catalogue URLs and changelog content.
The MCP package has separate build/pack/verify
commands; these release workflows do not publish it. CI's Docker job builds the
image but does not run a production deployment or backup/restore check.
