# Authentication and authorization implementation plan

## Goal

Give each web user a private Shadergrove library containing one or more shaders, with authentication, account recovery, and server-enforced ownership. Keep the desktop app usable as a local, single-user application.

The first release intentionally excludes shader sharing, collaborators, teams, organizations, and per-shader ACLs. The data model leaves room to add those features later.

## Recommended architecture

- Use [Better Auth](https://better-auth.com/) in the existing Node/Express server.
- Use its Drizzle adapter with PostgreSQL in production and SQLite in local server development.
- Use opaque, database-backed sessions delivered in `HttpOnly`, `Secure`, `SameSite=Lax` cookies.
- Keep the web application and API on the same origin.
- Treat the authenticated user ID from the server session as the only ownership authority.
- Enforce ownership in repository queries, not only in Angular route guards or NestJS controllers.

The target relationship is:

```text
User
 ├── Sessions
 └── Shaders
      ├── Presets
      └── Assets
```

A separate `libraries` table is not needed yet. A user's library is the collection of shaders whose `owner_user_id` matches that user.

## Scope of the first release

### Authentication

- Sign up with display name, email, and password.
- Verify the email address before allowing shader mutations.
- Sign in and sign out.
- Request and complete a password reset.
- View and revoke active sessions, including “sign out everywhere.”
- Optionally disable public registration for private/self-hosted deployments.
- Rate-limit sign-up, sign-in, verification, and password-reset endpoints.

### Authorization

- Anonymous visitors may use authentication endpoints and load public static resources/translations.
- Authenticated users may list, read, create, import, duplicate, update, export, and delete only their own shaders.
- Presets, textures, and thumbnails inherit authorization from their parent shader.
- An unknown shader and another user's shader both return `404` to avoid leaking resource existence.
- Administrative user management is separate from shader ownership. Administrators do not implicitly edit user shaders unless a later support-access policy explicitly allows it.

## Data model

### Auth tables

Generate and version the Better Auth Drizzle schema for:

- `users`
- `sessions`
- `accounts`
- `verifications`

Use non-sequential user IDs. Keep normalized email unique. Add a small application role field only if an administration UI is part of the release; otherwise defer roles.

### Shader ownership

Add a required owner foreign key to `shaders`:

```sql
ALTER TABLE shaders
  ADD COLUMN owner_user_id text REFERENCES users(id);

CREATE INDEX idx_shaders_owner_updated
  ON shaders(owner_user_id, updated_at DESC);
```

After existing rows have been assigned during migration, make the column `NOT NULL`.

The existing `author` field remains shader attribution metadata. It must never grant access.

No ownership column is needed on `presets` or `assets`: their required `shader_id` relation and cascade already make the shader the authorization boundary.

## Existing data and examples

Choose one migration owner before deploying the schema:

1. Create a bootstrap user from deployment configuration.
2. Assign every existing user-created shader to that account.
3. Treat bundled examples as read-only templates.
4. When a user edits a template, create a user-owned copy in their library.

Do not use `NULL` ownership as shorthand for public access. If templates remain in the shader table, give them an explicit system owner and an explicit `kind = 'template'` marker so accidental unscoped queries cannot expose private shaders.

## Server implementation

### 1. Database access

- Extract a reusable Drizzle database/pool provider from the PostgreSQL repository.
- Add the Better Auth schema to the existing migration ledger; never edit migration 1.
- Add equivalent SQLite migrations for development mode.
- Extend repository methods to require an ownership scope:

```ts
interface UserScope {
  userId: string;
}

listShaders(scope: UserScope): Promise<ShaderSummaryRow[]>;
loadShader(scope: UserScope, id: string): Promise<StoredShader | null>;
updateShader(scope: UserScope, id: string, ...): Promise<number>;
deleteShader(scope: UserScope, id: string): Promise<boolean>;
```

- Include `owner_user_id = $userId` directly in `SELECT`, `UPDATE`, and `DELETE` statements.
- Make shader creation and import set the owner from the scope, never from request input.
- Scope `exportAll()` to the current user.

### 2. Authentication integration

- Create the Better Auth server configuration with Drizzle, email/password, verification, and password-reset callbacks.
- Mount `/api/auth/*splat` before `express.json()`; Better Auth must read its request body itself.
- Add required environment variables:
  - `BETTER_AUTH_SECRET`
  - `BETTER_AUTH_URL`
  - mail provider credentials and sender address
  - registration mode (`open` or `invite-only`)
- Refuse production startup when required auth secrets are missing.
- Add trusted-origin configuration for local development and the deployed origin.

### 3. Request identity

- Add a NestJS authentication guard that resolves the Better Auth session from request headers.
- Attach a minimal principal such as `{ userId, email, emailVerified }` to the request.
- Add a typed decorator for accessing that principal in controllers.
- Protect all shader, preset, asset, import, and export endpoints.
- Keep translation and auth endpoints public.
- Require a verified email for mutations; decide whether read-only library access is allowed before verification.

### 4. Error and cache behavior

- Return `401` for a missing or expired session.
- Return `404` for shader resources not owned by the current user.
- Preserve `409` revision-conflict behavior for authorized writes.
- Return `Cache-Control: private` for authenticated shader assets and `no-store` for session/account responses.
- Never log cookies, passwords, reset tokens, verification tokens, or raw session IDs.

## Web application implementation

### 1. Auth client and state

- Add an `AuthService` around the Better Auth browser client.
- Expose explicit states: `loading`, `anonymous`, `authenticated`, and `error`.
- Keep the current user and session in memory; do not copy auth tokens into browser storage.
- Add global `401` handling that refreshes auth state and routes to sign-in without discarding unsaved editor work.

### 2. Screens and chrome

- Turn the title-bar account preview into live controls:
  - anonymous: **Log in** button;
  - authenticated: avatar/display-name menu;
  - menu actions: Profile, Sessions, and Log out.
- Add sign-in, sign-up, verify-email, forgot-password, reset-password, and profile views.
- Preserve the intended destination so a user returns to the shader they attempted to open after signing in.
- Ensure keyboard focus, screen-reader names, validation messages, loading states, and server errors are present.

### 3. SSR and desktop

- During Angular SSR, forward the incoming cookie when server-rendering authenticated content, or defer private library loading until browser hydration.
- Keep desktop persistence local and single-user in this release.
- Hide or adapt cloud account actions in offline desktop mode rather than requiring login to use the editor.
- A future desktop sync feature should authenticate through a system-browser OAuth flow, not an embedded password form.

## Security controls

- HTTPS for the complete authenticated session and HSTS in production.
- `HttpOnly`, `Secure`, appropriately scoped cookies.
- Origin/CSRF protection for every cookie-authenticated mutation.
- Strict trusted-host/origin allowlists.
- Generic login and password-reset responses that do not disclose whether an email exists.
- Password length and compromised-password checks; allow password-manager paste and Unicode.
- Better Auth's password hashing defaults, with configuration reviewed before release.
- Server-enforced idle and absolute session expiry.
- Session rotation after authentication or privilege changes.
- Audit events for sign-in success/failure, reset, session revocation, shader deletion, and administrative action.
- Per-account and per-IP throttling with proxy headers trusted only behind the configured reverse proxy.

Follow the [OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html), [Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), and [Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) guidance during implementation and review.

## Tests

### Repository and service tests

- A user lists only their own shaders.
- A user cannot read, update, delete, export, or access assets belonging to another user.
- Preset and asset operations check the parent shader owner.
- Create, duplicate, and import always assign the authenticated owner.
- `exportAll` never crosses ownership boundaries.
- Optimistic revision conflicts still behave correctly inside an ownership scope.

### API tests

- Every protected endpoint rejects an anonymous request with `401`.
- Expired and revoked sessions are rejected.
- Cross-user IDs return `404` for every HTTP verb and nested resource.
- Cookie flags, logout invalidation, CSRF rejection, and rate limits are verified.
- Verification and reset tokens are one-time and expire.

### Web tests

- Anonymous, loading, authenticated, expired-session, and error states render correctly.
- Route return behavior and unsaved edits survive a login transition.
- Account controls are usable by keyboard and at handset widths.
- SSR never renders one user's private data into another response or shared cache.

## Delivery sequence

1. **Ownership foundation** — migrations, scoped repository API, existing-data migration, and cross-user tests.
2. **Authentication backend** — Better Auth handler, sessions, email verification/reset, environment validation, and rate limits.
3. **API enforcement** — NestJS guard/principal, scoped controller calls, status codes, and audit events.
4. **Web account flows** — auth state, login/signup/recovery views, title-bar account menu, and `401` recovery.
5. **Templates and migration UX** — read-only examples and bootstrap-owner tooling.
6. **Hardening** — CSRF/origin tests, security headers, session lifecycle tests, logging review, and deployment documentation.

Each phase should ship only when its authorization tests pass. In particular, do not expose login publicly while the shader repository can still execute unscoped reads or writes.

## Definition of done

- Two test users can independently create and manage multiple shaders.
- Neither user can discover or operate on the other's shaders or nested resources.
- Signup, verification, sign-in, sign-out, reset, expiry, and session revocation work end to end.
- Existing shaders have an explicit owner and examples behave as read-only templates.
- No credential or session token is stored in browser storage or logs.
- Web SSR, direct REST calls, and the Angular UI enforce the same ownership policy.
- The local desktop application remains usable without network authentication.
