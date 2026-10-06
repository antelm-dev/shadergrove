<div align="center">
  <h1>Shadergrove</h1>
  <p><strong>Your self-hosted workspace for building, tuning, and collecting WebGL shaders.</strong></p>
  <p>
    Browse a shader library, edit GLSL with live diagnostics, generate controls from a schema,
    save presets, and move everything between installations as portable JSON.
  </p>

  <p>
    <a href="https://github.com/antelm-dev/shadergrove/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/antelm-dev/shadergrove/actions/workflows/ci.yml/badge.svg?branch=develop" /></a>
    <a href="https://angular.dev/"><img alt="Angular 22" src="https://img.shields.io/badge/Angular-22-DD0031?logo=angular&amp;logoColor=white" /></a>
    <a href="https://nodejs.org/"><img alt="Node.js 22 or newer" src="https://img.shields.io/badge/Node.js-22%2B-5FA04E?logo=nodedotjs&amp;logoColor=white" /></a>
    <a href="https://pnpm.io/"><img alt="pnpm 10" src="https://img.shields.io/badge/pnpm-10-F69220?logo=pnpm&amp;logoColor=white" /></a>
  </p>
</div>

<br />

![Shadergrove showing the Warp Tunnel shader and its generated controls — sliders, a checkbox, a select, and color pickers](docs/shadergrove-preview.jpg)

The shader you select becomes the application canvas, so you edit the thing you
are looking at. A broken draft never blanks the preview: Shadergrove keeps the
last valid version running and places compiler diagnostics in the editor.

## Highlights

- **Live GLSL workflow** — Monaco editing, driver-backed diagnostics, and a safe
  compile pipeline that preserves the last working render.
- **Schema-generated controls** — describe numbers, booleans, colors, and selects
  once; Shadergrove builds the control panel and uniforms for you.
- **A library that stays yours** — projects, presets, and assets live in SQLite
  on desktop or PostgreSQL on the web, with transactional writes and portable exports.
- **Portable by design** — export one shader or the complete collection to a
  versioned JSON bundle and import it elsewhere.
- **Official plugins** — import from Shadertoy and export to Wallpaper Engine
  with two packages from **Plugins → Available**; they run in the isolated
  plugin sandbox, and the app has no hidden built-in copy of either.
- **Interactive previews** — pointer velocity, click ripples, pause, screenshots,
  a configurable post-processing chain (Bloom, Vignette), render scaling, and
  texture inputs are built in.
- **Web and desktop** — self-host the web app with private account libraries,
  or use the Windows desktop app offline with optional uploads to an account.
- **MCP server** — let Claude Code, Codex, or Cursor drive a running Shader
  Studio tab: list shaders, edit GLSL, tune uniforms, and capture screenshots.

## Contents

- [User guide (GitHub Wiki)](https://github.com/antelm-dev/shadergrove/wiki)
- [Quick start](#quick-start)
- [Self-hosting](#self-hosting)
- [Desktop app](#desktop-app)
- [Using Shadergrove](#using-shadergrove)
- [Shader format](#shader-format)
- [Import and export](#import-and-export)
- [API](#api)
- [MCP server](#mcp-server)
- [Included shaders](#included-shaders)
- [Architecture](#architecture)
- [Development](#development)
- [Tests](#tests)
- [Known limitations](#known-limitations)
- [License](#license)

## Name and compatibility

Shadergrove was previously named **Shader Studio**. The application, repository,
and desktop installers now use Shadergrove. Existing installations keep their
installer identity, data directories, `shader-studio:` protocol, browser storage
keys, and `shader-studio/v1`–`v3` bundle tags. Configuration variables beginning
with `SHADER_STUDIO_` and the published npm package `@shader-studio/mcp` also keep
their existing names; current integrations continue to work.
The Compose application service and container names also retain their original
names so updating an existing deployment replaces its running containers.

For an existing Docker Compose deployment, keep its checkout directory and
Compose project name unchanged. If you move it to a directory named `shadergrove`,
set `COMPOSE_PROJECT_NAME` to the previous project name to reuse its database volume.

## Quick start

### Requirements

- Node.js `^22.22.3 || ^24.15.0 || >=26`
- [pnpm](https://pnpm.io/) 10

Clone the repository and start the development server:

```bash
git clone https://github.com/antelm-dev/shadergrove.git
cd shadergrove
pnpm install
pnpm dev
```

Open [http://localhost:4200](http://localhost:4200). The development server runs
the real NestJS API on Express and the SSR application; the API is not mocked.
Without `DATABASE_URL`, development uses a local SQLite database. Sign up in the
web app and confirm your address; when SMTP is not configured in development,
verification and password-reset links are printed in the server terminal.

## Self-hosting

### Docker

The fastest way to run Shadergrove. Compose brings up PostgreSQL and the app
together; the app waits for the database to be healthy before it starts.

```bash
git clone https://github.com/antelm-dev/shadergrove.git
cd shadergrove
cp .env.example .env         # then fill in the required values it lists
docker compose up -d --build
```

Compose publishes the app on port 4000. Put an HTTPS reverse proxy in front of
it and open the origin configured in `BETTER_AUTH_URL`; production session
cookies require HTTPS. Sign up and verify your address to create your private
library, which starts empty.

Each web user gets a private library, so the deployment needs a few things
before it will start: `BETTER_AUTH_SECRET`, the public `BETTER_AUTH_URL`, and an
SMTP server for verification and password-reset mail. Compose refuses to come up
without them rather than falling back to a development secret.
**[docs/deploying-authentication.md](docs/deploying-authentication.md)** covers
the setup, what to do with shaders that predate accounts, and what each control
enforces. Desktop editing remains local and works offline; builds configured
with an account server can sign in and upload selected shaders (see [Desktop
accounts and uploads](#desktop-accounts-and-uploads)).

Keep `.env` local: it is ignored by both Git and the Docker build context.
Only `.env.example`, which contains no usable credential, belongs in version
control. If `.env` was already tracked, adding it to `.gitignore` is not enough:
remove it from the index and rotate any password that may have been shared.

Your shaders live in **PostgreSQL**, persisted in the named `postgres-data`
volume; everything else in the image is disposable. The database is not published
on a host port — only the app container reaches it, over Compose's internal
network — and the connection string never leaves the server (the browser only
ever talks to the REST API).

Reaching the app under any name other than `localhost` — a machine name on your
LAN, a domain behind a reverse proxy — means telling SSR about it in `.env`,
otherwise the request is rejected:

```bash
SHADER_ALLOWED_HOSTS=localhost,127.0.0.1,[::1],shaders.example.com
```

`.env` also sets `SHADER_PORT` (host port, default `4000`). To
upgrade, `docker compose up -d --build`; the volume and its data are left alone.

### From source

Build the production application and run its Node server against PostgreSQL:

```bash
pnpm build
NODE_ENV=production DATABASE_URL=postgres://user:pass@localhost:5432/shader_studio pnpm serve:ssr
```

Configure the authentication and SMTP variables described in
[the deployment guide](docs/deploying-authentication.md) before starting, and
serve the app through HTTPS. The Node server listens on port 4000 by default.
When `DATABASE_URL` is set the server uses PostgreSQL; when it is **not** set the
server falls back to a local SQLite file under `SHADER_DATA_DIR` (`./data`),
which is convenient for `pnpm dev:server` but not intended for production. When
exposing the app beyond localhost, set `NG_ALLOWED_HOSTS` to the hostnames that
are allowed to reach SSR.

> [!IMPORTANT]
> The web app authenticates users and isolates their private libraries. Production
> requires HTTPS, a configured authentication secret and public origin, and SMTP.
> Set `AUTH_REGISTRATION=invite-only` after creating your accounts to close sign-up.

### Configuration

The server reads these directly; under Compose they are derived from `.env`
(see [`.env.example`](.env.example)).

| Variable             | Default                                | Purpose                                                                      |
| -------------------- | -------------------------------------- | ---------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET` | Development fallback only              | Cookie-signing secret; required in production                                |
| `BETTER_AUTH_URL`    | `http://localhost:4200` in development | Public app origin; required in production                                    |
| `MAIL_SMTP_URL`      | Console links in development           | SMTP transport; required in production                                       |
| `MAIL_FROM`          | `Shadergrove <no-reply@localhost>`     | Transactional email sender                                                   |
| `AUTH_REGISTRATION`  | `open`                                 | `invite-only` closes sign-up while allowing sign-in                          |
| `TRUST_PROXY`        | `0`                                    | Enable only behind a reverse proxy you control                               |
| `DATABASE_URL`       | —                                      | PostgreSQL connection string; when set, selects PostgreSQL, otherwise SQLite |
| `PORT`               | `4000`                                 | Port for the SSR server                                                      |
| `SHADER_DATA_DIR`    | `./data`                               | SQLite database directory (used only when `DATABASE_URL` is unset)           |
| `NG_ALLOWED_HOSTS`   | `localhost,127.0.0.1,[::1]`            | Comma-separated hosts SSR may render for; set this when deploying            |
| `DATABASE_POOL_MAX`  | `10`                                   | Maximum PostgreSQL pool connections                                          |

Public Explore — publishing shader snapshots for anyone to browse and copy — is
off unless `PUBLIC_EXPLORE_ENABLED=1`, and moderated by the account ids listed
in `PUBLIC_EXPLORE_ADMIN_USER_IDS`. Its routes and rules are in
[docs/public-explore-api.md](docs/public-explore-api.md).

Compose-only variables (`.env`): `POSTGRES_DB`, `POSTGRES_USER`,
`POSTGRES_PASSWORD` (build `DATABASE_URL`), plus `SHADER_PORT` (host port) and
`SHADER_ALLOWED_HOSTS` (feeds `NG_ALLOWED_HOSTS`).

### Data & backups

**PostgreSQL (Web / Docker)** is the primary store. Back it up and restore it
with the standard tools, e.g. against the bundled Compose service:

```bash
# Backup
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > backup.sql
# Restore (into an empty database)
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < backup.sql
```

**SQLite (Desktop / dev)** lives at one file. On the desktop app it is
`<userData>/library/shader-studio.sqlite` (`%APPDATA%/Shader Studio/library` on
Windows, `~/Library/Application Support/Shader Studio/library` on macOS,
`~/.config/Shader Studio/library` on Linux). These original directory names are
retained so upgrading to Shadergrove preserves existing libraries and preferences.
From-source dev without
`DATABASE_URL` uses `<SHADER_DATA_DIR>/shader-studio.sqlite`. Back it up by
copying the file (and its `-wal`/`-shm` siblings) while the app is closed.

**Importing an old file library.** The legacy per-shader folder format is never
deleted. The desktop app imports `<userData>/library/shaders` automatically on
first launch after upgrading (once, verified, files kept). For Docker, mount the
old library and run the one-shot importer explicitly — it never modifies the
source:

```bash
# with the old library mounted at /legacy-data (see docker-compose.yml)
docker compose --profile migrate run --rm migrate --source=/legacy-data
# add --mode=overwrite to replace shaders whose id already exists (default: rename)
```

**Examples.** New libraries start empty on web and desktop. The shaders in
`examples/` remain available to import manually. Old shared example templates
are omitted from libraries and collection exports; personal copies and existing
desktop shaders are preserved. `SHADER_SEED` no longer enables startup seeding.

**Diagnostics.** The app fails fast and loudly if the database is unreachable or
its schema cannot be brought to the expected version — check the container logs
(`docker compose logs shader-studio` / `docker compose logs postgres`). The
readiness endpoint is unauthenticated `GET /api/health` (also the container
`HEALTHCHECK`): `200` with `{ "status": "ok" }` after a successful database
metadata read, or `503` when initialization or database access fails. Responses
are not cached and expose no library data. This checks API/database readiness,
not SMTP delivery or browser rendering. `/api/shaders` requires a session.
Internal database errors are never leaked to the client: the REST/IPC layer only
ever returns `{ error: { code, message, details? } }`, never SQL, the connection
string, or a stack trace.

## Desktop app

The Electron target currently packages for Windows:

```bash
pnpm dev:desktop  # Angular dev server + Electron with main-process reload
pnpm pack:win     # unpacked app in release/win-unpacked
pnpm dist:win     # NSIS installer and portable executable in release/
```

The desktop target uses
[`electron-ipc-module`](https://github.com/antelm-dev/electron-ipc-module) and
[`electron-run`](https://github.com/antelm-dev/electron-run). It stores its
library in a SQLite database under Electron's per-user application-data directory
(`<userData>/library/shader-studio.sqlite`) and does not start the Express
server. The web and SSR targets use PostgreSQL (or SQLite for development)
behind the NestJS REST API.

### Desktop accounts and uploads

Accounts are optional. Set `SHADER_STUDIO_ACCOUNT_URL` **before building** the
desktop app to the origin of your Shadergrove server; the build embeds it in
the Electron main process. Use HTTPS, or HTTP only for loopback development.
Without a valid configured origin, account controls are disabled.

For example, in PowerShell:

```powershell
$env:SHADER_STUDIO_ACCOUNT_URL = 'https://shaders.example.com'
pnpm pack:win
```

Sign-in opens the system browser, where you confirm your password before
returning to the app. The desktop session is kept in the main process and stored
using Electron's encrypted storage. Upload individual local shaders or all
local-only shaders from the account actions. Subsequent saved changes to linked
shaders are pushed automatically, with status and retry controls in the UI.

This is the first sync milestone: **uploads, not a full two-way library mirror**.
There is no general download of shaders created on the web. Conflicts keep both
versions; a linked shader deleted on the server remains local and becomes
unlinked. Signing out leaves the local library available offline.

## Development

The application uses Angular 22 (zoneless SSR), Angular Material, NestJS on Express,
three.js, lil-gui, and Monaco.

| Script           | What it does                                      |
| ---------------- | ------------------------------------------------- |
| `pnpm dev`       | Dev server with HMR, SSR and the API              |
| `pnpm build`     | Production build into `dist/`                     |
| `pnpm serve:ssr` | Run the built SSR server                          |
| `pnpm test`      | Unit tests (Vitest), incl. the MCP server         |
| `pnpm lint`      | Oxlint                                            |
| `pnpm format`    | Oxfmt                                             |
| `pnpm typecheck` | Generate IPC types and check workspace TypeScript |
| `pnpm dev:mcp`   | Run the [MCP server](#mcp-server) from source     |

## Using Shadergrove

### Keyboard shortcuts

| Key               | Action                        |
| ----------------- | ----------------------------- |
| `Space`           | Pause / resume time           |
| `H`               | Show / hide the controls      |
| `S`               | Save the frame as a PNG       |
| `Z`               | Zen mode: hide all the chrome |
| `Ctrl`+`K`        | Command palette               |
| `Ctrl`+`S`        | Save the shader               |
| `Shift`+`Alt`+`F` | Format the GLSL in the editor |

Web library requests require a signed-in account; mutations require a verified
email address. Each account's library contains its own shaders. Desktop editing
needs no account.

### The editor

Right-click the editor's toolbar for its menu.

- **Format GLSL** re-indents by block depth and does nothing else. No rewrapping,
  no spacing opinions: a shader is dense numeric code whose columns are usually
  aligned on purpose, and a formatter that argues with that is one people turn
  off.
- **Copy full GLSL** copies the fragment as a file that stands on its own — the
  source plus the declarations the engine would otherwise have supplied: the
  precision qualifier, the built-in uniforms, and one `uniform` per control.
  Anything the source already declares is left alone, so the result never
  redeclares its way into a compile error somewhere else.

Typing offers snippets for the things you would otherwise be looking up: `main`,
`uv`, `ripple` (the `u_clickData` loop), `channel`, `palette`, `hash21`, `noise`,
`fbm`, `rot2` and `uniform`.

### Post-processing

The **Effects Rack**, in the inspector's Post-processing tab, is the
configurable chain applied after the shader's own Image pass (never to Buffer
A-D): built-in **Bloom** and **Vignette**, plus custom GLSL effects and multiple
instances. A master switch bypasses the whole chain without touching any effect's
own settings; each effect has its own enable toggle, a reset to defaults, and
remove/add.
Reordering (drag, or the move-up/move-down buttons) changes the order the
effects are actually applied in — order is part of the chain, not just the
rack's display. Every change to the rack is a draft edit like any parameter:
it marks the shader unsaved and is undone by discarding the draft.

### Presets

A preset captures the live parameter values under a name. Ticking **Also capture
the render settings** when saving stores the shader's post-processing chain
alongside them, and applying that preset brings it back — which, since the
chain belongs to the shader rather than to the knobs, leaves the document with
unsaved changes. Presets saved without it never touch the chain. The ones that
carry it are marked with an icon on their chip.

On desktop, **More actions → Open output window** opens a clean, independently
resizable render surface. It follows the active draft, live parameters, pause
state, render scale, and texture assignments, making it suitable for a second
monitor or projector while the main window remains the control workspace.

Move the pointer over the background to push the shader around; click to drop a
ripple. Both are fed to the shader as uniforms (see below) — what a shader does
with them is up to it.

---

## Architecture

Application runtimes and reusable libraries keep their own boundaries. The libraries do not depend on Angular.

```
apps/
  studio/                one application package for web, SSR and desktop
    src/
      app/               Angular workspace state, rendering, editor, and UI
      server/            Express host: security headers, /api mount, static, SSR
        create-library.ts  picks PostgreSQL (DATABASE_URL) or SQLite
        api/             NestJS modules: core, system, shaders, auth, publications, admin
      desktop/
        main/            Electron lifecycle, windows, updates, and IPC handlers
        preload/         sandboxed context bridge
        contracts/       plain IPC contracts and the generated bridge
    scripts/desktop/     Electron development, IPC generation and packaging
    package.json         @shadergrove/studio, with separate runtime targets

libs/
  shared/                model, validation, GLSL, capture, and MCP contracts
  backend/               Node-only storage and i18n shared by server and desktop
    src/library/         ShaderLibrary — engine-agnostic shader domain logic
    src/persistence/     ShaderRepository + SQLite / Postgres / legacy adapters
    src/storage/         the legacy file store, now a read-only import source

tools/
  maintenance/           CLI: legacy import and pre-account shader ownership claims
  mcp/                   standalone `@shader-studio/mcp` server
  workspace/             checks, generators, smoke tests, and repo automation
```

The application package keeps its runtime checks separate: Angular uses
`tsconfig.app.json` and `tsconfig.spec.json`, the Express host uses
`tsconfig.server.json`, and Electron uses `tsconfig.desktop.main.json` and
`tsconfig.desktop.preload.json`. Angular test discovery excludes `src/server`
and `src/desktop`. API and Electron tests use `vitest.server.config.ts` and
`vitest.desktop.config.ts` in Node. The browser entry points cannot import the
server or Electron main/preload (enforced by oxlint); they may import the
generated IPC bridge only as a type. IPC contracts are local to studio, while
`libs/backend` remains shared with the maintenance CLI and `libs/shared` with
backend, studio and MCP.

The root commands remain the entry points for developers. Within
`@shadergrove/studio`, `build` produces web + SSR, `build:renderer` produces the
static Angular desktop renderer, and `build:desktop` builds renderer + main +
preload. Likewise, `dev:renderer` starts Angular on port 4201 while `dev:desktop`
also starts Electron. `test` runs server, desktop and web checks, in that
order; `typecheck` covers all three runtimes. `test:web`, `test:server`,
`test:desktop`, `typecheck:web`, `typecheck:server` and `typecheck:desktop` can
target one runtime. Nx excludes Electron sources and tooling from web build inputs; desktop
builds retain their own outputs in `dist-main` and `dist-web`.

Root Angular build, development and test targets generate the IPC bridge first.
When invoking Angular directly inside studio, run `pnpm gen:ipc` beforehand.
Complete generation before compilation; concurrent generation can temporarily
leave the compiler without the bridge types. Cached web checks and builds also
hash the generated bridge output.

### Storage

Shaders, projects, presets, textures and thumbnails live in **SQL**: SQLite in
the Electron app (via Node's built-in `node:sqlite`, so there is no native module
to rebuild), PostgreSQL on the Web/Docker server (via Drizzle ORM's
`node-postgres` adapter). Both sit behind one
`ShaderRepository` contract, and all the domain logic — validation, id
generation, deriving `fragment`/`vertex` from the project, presets, import/export,
seeding — lives once in `ShaderLibrary`, above the contract. The web app knows
none of this: it still talks only to `ShaderApi` (`HttpShaderApi` over REST,
`DesktopShaderApi` over IPC), so SQLite stays in the Electron main process and the
PostgreSQL connection string never reaches the browser.

Every mutation of a shader and its dependents runs in a transaction. The schema
is versioned by ordered, deterministic migrations that run before any API/IPC is
exposed and fail loudly rather than auto-generate. Concurrent writes are caught
with a per-shader `revision`: a save may send the revision it read as
`expectedRevision` and get a `409 conflict` instead of silently clobbering a newer
write (absent, it stays last-writer-wins). The old per-shader file library is no
longer the primary store but is kept as a read-only import source — imported once
on the desktop, or on demand via `migrate-files` under Docker, and never deleted.

The typed PostgreSQL model is in
`libs/backend/src/persistence/postgres/schema.ts`. Users and sessions already share this database. Add future server relations
(such as memberships or invitations) there, and add the corresponding
ordered migration in `postgres/migrations.ts`. Migrations deliberately continue
to use the existing `storage_metadata.schema_version` ledger: deployed databases
already have that history, so introducing the ORM does not create a second
baseline or attempt to recreate live tables.

Each directory above is a pnpm workspace package with its own dependency manifest and
runtime-specific scripts/configuration. The root package only orchestrates workspace commands and
retains the desktop application metadata consumed by Electron Builder. Its
production dependencies provide the PostgreSQL driver and Swagger package
externalized by the SSR bundle, so `pnpm serve:ssr` can resolve them from `dist`.

### Server dependency changes

Angular builds the Express host and its local API from
`apps/studio/src/server/index.ts`. A new Node-only dependency in studio or
`libs/backend` can affect development, the production SSR bundle, and the Docker
image in different ways. When adding or upgrading one:

1. Declare it in the workspace package that imports it (`apps/studio` for API
   dependencies). If `pnpm dev` fails during Vite SSR dependency resolution, check
   `apps/studio/angular.json` → `serve.options.prebundle.exclude`. This list is for
   the web dev server; the desktop static target has its own configuration.
2. Check `apps/studio/angular.json` → `build.options.externalDependencies`. Packages
   needed at runtime but left outside the SSR bundle must be available to the
   built server. `pg` and `@nestjs/swagger` currently have pinned versions in
   the root `package.json`; the Dockerfile installs those same versions into
   the runtime image. Keep these declarations in sync when changing them.
   Entries for Node built-ins or optional modules do not automatically require
   a new Docker installation. Do not externalize a package just because it is
   server-only; first establish whether bundling actually fails.
3. Run `pnpm dev` for the development SSR path, then
   `pnpm build && pnpm smoke:ssr` for the built server. The smoke test uses
   SQLite; it does not prove that the external PostgreSQL driver is present in
   the Docker runtime.
   For changes to runtime dependencies or their versions, also build and start
   the image in a disposable Compose deployment and check `/api/health` with
   PostgreSQL configured (see `docs/release-readiness.md`).

The Angular build imports the server entry to extract routes without initializing
storage. That build can pass even when a dependency loaded only on the first API
request is missing, which is why the built-server and container checks matter.

The store keeps three layers of state deliberately distinct:

- **record** — the shader as the server last gave it to us.
- **draft** — the editor buffers. The difference from `record` is what "unsaved
  changes" means, and what `Save` sends.
- **params** — the live uniform values. Turning a knob is _not_ an unsaved edit to
  the source; it is a value you can capture as a preset.

### SSR

Express serves the API and renders the app in the same process. During SSR the
app calls its own `/api` over a same-origin request (the absolute origin comes
from the incoming request; see `app.config.server.ts`).

SSR's library request does not forward the browser's session cookie, so it
normally receives a `401` and renders the shell without private shader data.
A failed list publishes no `TransferState` snapshot: the browser fetches its
own authenticated library after hydration, then opens the routed or remembered
shader. If SSR does obtain a successful list, `TransferState` carries that
snapshot to the browser; the server cannot read `localStorage` to choose the
last-opened shader itself.

three.js, lil-gui and Monaco are all **dynamically imported**: none of them exist
on the server (lil-gui injects a stylesheet at import time and would throw), and
keeping them out of the initial bundle lets the shell paint first.

### Compiling without breaking the preview

A candidate shader is compiled against an offscreen 1×1 render target before it
is allowed anywhere near the screen. Only if the driver accepts it does the live
material get swapped. If it does not, the previous shader keeps rendering and the
driver's log comes back as diagnostics.

Line numbers in a driver's log count from the top of the source _three.js_
assembled, which is not the source you typed — three prepends a prelude. The
engine finds your source inside the full source and subtracts the offset, so a
diagnostic lands on the line you are actually looking at.

---

## Shader format

> [!NOTE]
> The live store is now SQL (see [Storage](#storage)). The per-shader directory
> layout below is the **legacy/import** format: it is what the old file store
> wrote, what the desktop app and `migrate-files` read to import into the
> database, and the shape the examples ship in. The `.shader.json` bundle format
> further down is unchanged and remains the interchange format for import/export.

One directory per shader. The directory name is the id — it is the primary key,
which is why it is validated before it is ever joined onto a path.

```
data/
  .seeded                    marker; stops examples coming back after you delete them
  shaders/
    poured-paint/
      meta.json              name, description, control schema, render settings
      project.json           the multi-pass project: passes, buffers, files,
                              channel wiring — the source of truth for a shader
      fragment.glsl          the Image pass's source — a mirror of project.json
      vertex.glsl            the project's vertex shader — also a mirror
      presets.json           { "presets": [ ... ] }
```

A shader is a _project_ — an Image pass, an optional Common pass of shared code,
up to four buffers, and any number of plain source files a pass can `#include`.
`project.json` is that whole document; `fragment.glsl`/`vertex.glsl` are kept in
sync with it (the Image pass's source, and the project's vertex shader) so that
anything reading the old two-file shape still works. A shader that predates
`project.json` — or one whose copy of it is unreadable — reads as a single-pass
project built from its `fragment.glsl`/`vertex.glsl`, wired up exactly as the old
single-pass engine bound its four `iChannel`s.

`examples/shaders/` uses exactly this layout, and is copied into `data/` the first
time you run an empty store. `data/` is gitignored; `examples/` is not.

Writes are atomic (temp file + rename), and mutations of a given shader are
serialized, so a half-written `meta.json` is never observable — `project.json`
included.

**Ids** are lowercase letters, digits and inner hyphens — no dots, no separators.
That rules out `..`, hidden files, and Windows' reserved device names. Renaming a
shader changes its display name only; the id, and therefore the path, is stable.

### `meta.json`

```json
{
  "name": "Hex Pulse",
  "description": "A hexagonal lattice that answers back.",
  "author": "Shadergrove",
  "createdAt": "2026-07-12T00:00:00.000Z",
  "updatedAt": "2026-07-12T00:00:00.000Z",
  "controls": [/* see below */],
  "render": {
    "postProcessing": {
      "enabled": true,
      "effects": [
        {
          "type": "bloom",
          "enabled": true,
          "settings": { "strength": 0.55, "radius": 0.55, "threshold": 0.65 }
        },
        {
          "type": "vignette",
          "enabled": false,
          "settings": { "intensity": 0.4, "softness": 0.5, "roundness": 1 }
        }
      ]
    }
  }
}
```

`postProcessing.effects` is ordered — that order is what the renderer applies
the chain in, not just how the rack displays it. Older `render` shapes,
including a bare `{ "bloom": {...} }` (pre-chain) record, still import; see
[Import and export](#import-and-export).

### `presets.json`

```json
{
  "presets": [
    {
      "id": "solar-storm",
      "name": "Solar Storm",
      "createdAt": "2026-07-12T00:00:00.000Z",
      "values": { "timeScale": 1.4, "colorLine": "#ff7a3d" },
      "render": {
        "postProcessing": {
          "enabled": true,
          "effects": [
            {
              "type": "bloom",
              "enabled": true,
              "settings": { "strength": 1.2, "radius": 0.4, "threshold": 0.7 }
            }
          ]
        }
      }
    }
  ]
}
```

`render` is optional and usually absent: a preset without it restores the values
and leaves the shader's own post-processing chain alone. `values` are projected
onto the current control schema when applied — anything the schema no longer
declares is dropped, and a number outside a narrowed range is clamped rather
than discarded, so a preset outlives the edits made to the shader underneath it.

---

### Control schema

A shader declares its parameters; the GUI is generated from that declaration. No
shader ever writes GUI code. Add a control in the **Config** tab and its knob
appears immediately, bound to a uniform, without a reload.

**The rule: a control keyed `warpIntensity` feeds `uniform float u_warpIntensity`.**
The uniform is always the key prefixed with `u_`.

| `type`    | GLSL uniform    | Widget       | Required fields                       |
| --------- | --------------- | ------------ | ------------------------------------- |
| `number`  | `float u_<key>` | slider       | `default`, `min`, `max`, (`step`)     |
| `boolean` | `bool u_<key>`  | checkbox     | `default`                             |
| `color`   | `vec3 u_<key>`  | color picker | `default` as `#rrggbb`                |
| `select`  | `float u_<key>` | dropdown     | `default`, `options` (label → number) |

`label` (GUI text) and `folder` (grouping) are optional on all of them.

```json
[
  {
    "key": "timeScale",
    "type": "number",
    "label": "Time Scale",
    "folder": "Motion",
    "default": 0.5,
    "min": 0,
    "max": 2
  },
  { "key": "mirror", "type": "boolean", "label": "Mirror", "folder": "Flight", "default": false },
  {
    "key": "colorLine",
    "type": "color",
    "label": "Lattice",
    "folder": "Palette",
    "default": "#54e0ff"
  },
  {
    "key": "paletteMode",
    "type": "select",
    "label": "Palette Mode",
    "folder": "Palette",
    "default": 1,
    "options": { "Classic": 0, "Neon": 1, "Ember": 2 }
  }
]
```

Colors are passed to the shader as **display-space sRGB** `vec3` (three.js's
colour management is off), which is what you almost certainly want when you pick
`#54e0ff` and expect to see `#54e0ff`.

### Built-in uniforms

Provided to every shader whether it declares them or not. Declare the ones you use.

```glsl
uniform vec2  iResolution;             // drawing-buffer size, pixels
uniform float iTime;                   // seconds; pausable, and it does not
                                       // fast-forward when you resume
uniform vec4  iMouse;                  // xy: pointer in pixels, z: 1 while pressed
uniform vec2  iMouseVel;               // pointer velocity, pixels/second
uniform vec3  u_clickData[__MAX_WAVES__]; // per click: xy pixels, z = birth time
                                          // (z <= 0 means the slot is unused)
```

`__MAX_WAVES__` is substituted with the ripple-slot count (24) before compiling,
so use it for the array size and any loop bound. `examples/shaders/hex-pulse` is
the worked example.

The vertex shader is an ordinary three.js `ShaderMaterial` vertex shader, and gets
`position`, `uv`, `projectionMatrix` and `modelViewMatrix`. The default passes
`vUv` through, which is all a full-screen shader needs.

### Editing the schema

Changing the controls re-projects every preset onto the new schema: a value for a
control you deleted is dropped, and a value now out of range is **clamped** rather
than discarded — a preset saved before you narrowed a slider is still worth
keeping. A schema that does not parse is reported in the diagnostics strip, blocks
saving, and leaves the working GUI alone.

---

## Import and export

One documented format, used for both a single shader and a whole collection.
Everything needed to reproduce a shader elsewhere is in it: the whole project
(passes, buffers, files, channel wiring), schema, render settings and presets.

`GET /api/shaders/:id/export` →

```json
{
  "format": "shader-studio/v3",
  "kind": "shader",
  "exportedAt": "2026-07-12T12:00:00.000Z",
  "shader": {
    "id": "hex-pulse",
    "name": "Hex Pulse",
    "description": "...",
    "author": "Shadergrove",
    "controls": [/* the schema */],
    "render": { "postProcessing": { "enabled": true, "effects": [/* see meta.json above */] } },
    "fragment": "precision highp float; ...",
    "vertex": "varying vec2 vUv; ...",
    "project": {
      "version": 1,
      "vertex": "varying vec2 vUv; ...",
      "passes": [/* Image, an optional Common, up to four buffers */],
      "files": [/* plain #include-able source files */]
    },
    "presets": [
      {
        "id": "circuit",
        "name": "Circuit",
        "createdAt": "...",
        "values": { "timeScale": 0.5, "colorPulse": "#5ef2ff" }
      }
    ]
  }
}
```

`fragment`/`vertex` stay in the payload as mirrors of `project` (the Image pass's
source and the project's vertex shader), for anything that still reads the old
two-string shape.

`GET /api/export` returns the same thing with `"kind": "collection"` and a
`"shaders": [ ... ]` array of those payloads. Import accepts either kind.

**`shader-studio/v1` and `v2` bundles still import.** `v1` predates `project`
entirely; on import, a project is synthesized from `fragment`/`vertex` the same
way a shader that predates `project.json` on disk does — one Image pass, an
empty Common pass, and the four `iChannel`s bound exactly as the old
single-pass engine bound them. `v2` has `project` but predates the
post-processing chain: its bare `{ "bloom": {...} }` `render` is migrated into
a single-effect chain the same way a `render` missing entirely is filled in.

**Import modes.** `rename` (the default) never destroys anything: a shader whose id
already exists is given a fresh, suffixed one. `overwrite` replaces the shader
holding that id, which is what makes an export → import round trip idempotent. The
UI asks before it overwrites.

Bundles are validated on the way in, and a bundle with a broken id but a usable
name is recovered rather than rejected — hand-edited files are expected.

### Official plugins: Shadertoy Import and Wallpaper Engine Export

Importing from Shadertoy and exporting to Wallpaper Engine are plugins. Both
ship with each release and are listed under **Plugins → Available**; install
one (it arrives switched off), switch it on, and use it from its card under
**Installed**. Menu entries follow the plugins that are switched on: while a
plugin is missing or off, nothing offers it; once it is on, **Import from
Shadertoy…** (in Import & export, the desktop File menu and the New shader
dialog) leads to its card, and **Export to Wallpaper Engine…** (also on the
shader's own menu) exports the open shader directly, dimmed while none is open.
Every other plugin's project importers and exporters, effects and themes are
offered the same way, in the command palette too. Removing a plugin never
touches a shader it imported. Plugin authors: see [`plugins/official/README.md`](plugins/official/README.md).

**Shadertoy Import** (`dev.shadergrove.shadertoy`) creates a new shader either
from a Shadertoy URL or ID with your own API key — the Image pass, Common,
buffers with feedback, channel wiring, samplers and up to four textures — or
from one pasted Image pass. Your key is kept in this app's preferences and sent
only to Shadergrove's own server (or the desktop main process), which fetches the
shader from `www.shadertoy.com` and nothing else; it never reaches the plugin.
Sound and cubemap passes and keyboard, video, webcam, music, microphone, volume
and cubemap inputs are dropped with a warning, as before. Imported content keeps
its author's rights and licence.

**Wallpaper Engine Export** (`dev.shadergrove.wallpaper-engine`) exports the
open shader as it is — unsaved edits included, nothing saved — as a Wallpaper
Engine web-wallpaper project:

- `index.html` — a live WebGL player with the composed Image and buffer passes,
  current parameter values and base64-embedded textures; no CDN or network use.
- `project.json` — `"type": "web"`, `"file": "index.html"`, and one user
  property per control: Slider for number, Checkbox (`bool`) for boolean, Color
  for colour and Combo for select, keyed `ss<key>` with the draft's values as
  defaults. The page's `wallpaperPropertyListener` reads the same keys.

In the browser the project downloads as `<name>.zip` holding one `<name>/`
folder; extract it. The desktop app asks for a parent folder and creates
`<name>/` inside it (`<name>-2/`… if taken; an existing folder is never
overwritten, and it only appears once every file is written). In Wallpaper
Engine, open the editor, choose **Create Wallpaper** and select `index.html` from
that folder. Time, resolution, pointer velocity, click ripples, texture sampling,
fixed/scaled buffer resolutions and multipass feedback are supported; the
post-processing chain (Bloom, Vignette) is not reproduced, and the export says so
whenever the shader has a post effect enabled.

> **Not yet verified in Wallpaper Engine itself.** Whether Wallpaper Engine keeps
> the supplied `project.json` properties when it imports the folder, rather than
> writing its own, has not been confirmed on an installed copy. If it does not,
> the wallpaper still renders with the exported values; add the properties under
> **Edit → Change Project settings** with the keys from `project.json`.

**Rolling back.** Disable or remove either plugin from Plugins at any time; its
shaders stay. The HTTP `POST /api/import/shadertoy` and desktop
`shader.import-shadertoy` IPC conversions remain for other clients, running the
same converter host-side without any plugin code.

---

## API

Library endpoints require an authenticated web session or desktop bearer token.
Mutations require a verified email address, and all library operations are
scoped to that account. `GET /api/health` and translation catalogs are public.

Interactive docs are served by the running app at `/api/docs` (OpenAPI JSON at
`/api/docs-json`).
For local manual requests, open the [Bruno collection](.bruno/README.md).

Shader library and readiness errors use `{ "error": { "code", "message", "details"? } }`.
Authentication endpoints use Better Auth's own response format.
`400` invalid · `401` unauthorized · `404` not found · `409` conflict.
Readiness failures return `503` with a generic `internal` error.

| Method   | Route                                | Purpose                                         |
| -------- | ------------------------------------ | ----------------------------------------------- |
| `GET`    | `/api/health`                        | API and database readiness (no session)         |
| `GET`    | `/api/shaders`                       | List (summaries)                                |
| `POST`   | `/api/shaders`                       | Create from the template                        |
| `GET`    | `/api/shaders/:id`                   | Read one, in full                               |
| `PUT`    | `/api/shaders/:id`                   | Partial update (name, source, controls, render) |
| `DELETE` | `/api/shaders/:id`                   | Delete                                          |
| `POST`   | `/api/shaders/:id/duplicate`         | Copy, presets included                          |
| `GET`    | `/api/shaders/:id/presets`           | List presets                                    |
| `POST`   | `/api/shaders/:id/presets`           | Save; reusing a name overwrites                 |
| `DELETE` | `/api/shaders/:id/presets/:presetId` | Delete a preset                                 |
| `GET`    | `/api/shaders/:id/export`            | Export one                                      |
| `GET`    | `/api/export`                        | Export everything                               |
| `POST`   | `/api/import`                        | Import a bundle                                 |
| `POST`   | `/api/import/shadertoy`              | Convert a Shadertoy shader to a bundle          |
| `POST`   | `/api/import/shadertoy/source`       | Shadertoy JSON for the Shadertoy plugin         |
| `GET`    | `/api/import/shadertoy/asset`        | One Shadertoy texture for the Shadertoy plugin  |

Preset values are sanitized against the shader's schema on save, so a preset can
never carry a value for a control that does not exist.

---

## MCP server

`tools/mcp` publishes [`@shader-studio/mcp`](https://www.npmjs.com/package/@shader-studio/mcp)
on npm: an [MCP](https://modelcontextprotocol.io) server that lets Claude Code,
Codex, Cursor, and other MCP clients drive a **locally-open Shadergrove
tab** — list shaders, edit GLSL live, tune uniforms, apply presets, and
capture screenshots — through the same authenticated localhost WebSocket
bridge. The app enables this bridge by default in development; production
and packaged desktop builds must explicitly opt in through `provideMcpBridge()`
in their application configuration. Token pairing alone does not enable the
bridge in a production build. It speaks MCP over stdio to the client and
makes no outbound network calls of its own.

```bash
npx -y @shader-studio/mcp
# or, wired into Claude Code:
claude mcp add shadergrove -- npx -y @shader-studio/mcp
```

Pairing the browser tab, the security model, environment variables, and
per-client config (Codex, Cursor, Windows) are documented in
[`tools/mcp/README.md`](tools/mcp/README.md).

---

## Included shaders

| Shader           | Shows                                                                                                                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Poured Paint** | 43 controls. Domain-warped fbm, layers quantized into pooled bands with hard contour lips, wet specular relief, OKLab palette ramp, click ripples with chromatic dispersion, and momentum-tunable pointer smearing. Bloom on. |
| **Aurora Veil**  | Curtains draped by warping the x axis with slow noise, over a twinkling star field.                                                                                                                                           |
| **Hex Pulse**    | `u_clickData`: click and a wavefront crosses the lattice. Hover lights the cells under the cursor.                                                                                                                            |
| **Warp Tunnel**  | A tunnel from `1/r` — no raymarching. Demonstrates `select` and `boolean` controls.                                                                                                                                           |

Poured Paint and its five presets are carried over from the project this app grew
out of, and are the reference for what the format can express.

All shaders distributed in `examples/shaders` are original Shadergrove examples
and are licensed under Apache-2.0 with the rest of the project.

---

## Tests

See [the release checklist](docs/release-readiness.md) for automated gates and
manual validation required before publishing a release.

```bash
pnpm test
```

~600 tests, focused where a bug would actually cost you something:

- **`backend/library/conformance.ts`** — one behavioural suite the storage engines
  must both pass, run against SQLite (a temp file) and, when
  `SHADER_TEST_DATABASE_URL` is set, PostgreSQL. It is where "the logic is not
  duplicated between engines" is enforced: init/migrations, CRUD, sorted listing,
  cascade delete, duplicate, presets, textures on all four channels, thumbnails,
  import/export (v1 and v2, rename/overwrite), multipass projects, idempotent
  seeding, transaction rollback, revision conflicts, legacy migration, corrupt
  JSON and missing assets, and persistence across a restart.
- **`apps/studio/src/server/api/test/router.spec.ts`** — the REST layer over a real SQLite-backed
  library: status codes, the `{ error: { code, message } }` envelope, a `409` on
  a stale `expectedRevision`, and texture upload/serve/clear.

- **`libs/shared/src/validate/validate.spec.ts`** — ids (every traversal and reserved-name case),
  the control schema, preset sanitization and clamping, and bundle round-trips —
  including a `shader-studio/v1` bundle (no `project` field) synthesizing one via
  `migrateLegacyProject`, and a malformed `project` being sanitized rather than
  failing the import.
- **`backend/storage/shader-storage.spec.ts`** — the legacy file store (now the
  read-only import source) against a real temp directory, not a mocked fs,
  because the whole point of that layer is what it does to the filesystem and a
  mock would let a traversal bug through. Covers
  CRUD, path traversal, atomic update, preset lifecycle, import modes, and
  seeding, plus a `project` describe block: `project.json` round-trips through a
  fresh read and a fresh `ShaderStorage`, a shader with none reads as a
  legacy-migrated project, duplicate and export/import carry buffers/Common/
  files/wiring, and a legacy `fragment`/`vertex`-only patch reconciles onto the
  current project instead of replacing it.
- **`core/shader-store.spec.ts`** — the client-side store: selection, dirty
  tracking, save/discard paths, and preset application.
- **`core/project-workspace.spec.ts`** — a shader record becoming a project
  (legacy and otherwise), unsaved-changes detection, and the pre-upgrade
  `localStorage` → server migration: a matching baseline pushes and clears, a
  stale one reconciles (record wins for the Image pass, buffers survive) before
  pushing, and a failed push leaves the local copy for the next load to retry.
- **`ui/document-status.spec.ts`** — the saved/dirty/saving indicator, including
  the debounce timing.
- **`core/draft-recovery.spec.ts`** and **`core/panel-prefs.spec.ts`** — what
  survives a reload: unsaved drafts, and panel sizes.
- **`rendering/glsl-diagnostics.spec.ts`** — both driver log dialects, and the
  prelude offset that makes a line number point at the right line.
- **`rendering/glsl-export.spec.ts`** — the generated uniform prelude, and above
  all what it declines to generate: a declaration the source already carries
  would be a redeclaration error wherever the copy is pasted.
- **`editor/glsl-format.spec.ts`** — indentation depth, braces that are only
  part of a comment, and idempotence.
- **`rendering/shadertoy-import.spec.ts`** — the Shadertoy source rewrite.
- **`plugins/shadertoy-plugin.spec.ts`, `plugins/wallpaper-plugin.spec.ts`** —
  the official packages as shipped, through the real plugin host, against the
  parity fixtures in `plugins/official/*/fixtures`.

---

## Known limitations

- **One active shader.** The browser list displays saved thumbnails, but it does
  not continuously render every shader in the library. The selected shader and
  the optional output window are the live render surfaces.
- **Desktop sync is upload-first.** Account-enabled builds push linked local
  shaders; they do not download the entire account library or propagate every
  deletion in both directions.
- **Public Explore is optional and web-only.** Libraries are private by default;
  publishing shader snapshots requires a server with public Explore enabled.
- **Plugins are local and official only.** Packages come from a file or from the
  catalogue that ships with the release; there is no hosted marketplace,
  publisher signing or automatic update, and the protocol is versioned but young.
- **MCP production setup is explicit.** Packaged builds need application
  configuration to enable the bridge; there is no pairing screen yet.
- **Bloom and Vignette are the built-in post effects.** The rack also supports
  custom GLSL effects and multiple instances. A preset can optionally capture
  the complete render settings, including the chain.
- **Monaco's stylesheet is global** (~88 kB gzipped), not lazy: the CSS its ESM
  modules import lands in a chunk nothing links, so the editor comes out
  structurally unstyled if you rely on it. The editor's _code_ is still lazy.
- **Shader compilation uses a real draw call** to a 1×1 target to force a compile.
  It is the only reliable way to make three.js compile eagerly, but it does mean a
  recompile costs one hidden frame.
- GLSL diagnostics come from the driver, so their exact wording varies by
  browser and GPU.

---

## License

Copyright 2026 Adel Terki.

Shadergrove is licensed under the [Apache License 2.0](LICENSE). Third-party
software included by the project remains under its respective license; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
