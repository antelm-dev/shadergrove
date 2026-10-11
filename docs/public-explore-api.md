# Public Explore — API contract

The server contract behind public shader snapshots and their moderation. The
TypeScript shapes named here live in
[`libs/shared/src/publication.ts`](../libs/shared/src/publication.ts)
(`@shadergrove/shared/publication`) and are the authoritative definition; this
note fixes the routes, status codes and concurrency rules around them.

## Configuration

| Variable                        | Default | Meaning                                                                                   |
| ------------------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `PUBLIC_EXPLORE_ENABLED`        | off     | Exactly `1` turns the feature on. Anything else: the routes below are not registered.     |
| `PUBLIC_EXPLORE_ADMIN_USER_IDS` | empty   | Comma-separated immutable account ids that may moderate. Empty means nobody. Server-only. |

An account id is the `user.id` of `GET /api/auth/get-session` for that account.
Moderation is never derived from an email address or from anything a client
sends. Turning the flag off is the rollback: every route except
`/api/capabilities` answers 404 and the stored data is left intact.

## Rules that hold everywhere

- **Envelope.** Errors use the API's one shape, `{ error: { code, message, details? } }`.
  Codes: `invalid` 400, `unauthorized` 401, `forbidden` 403, `not_found` 404,
  `conflict` 409, `rate_limited` 429.
- **Visibility.** A publication is public while `ownerVisible && !moderatorHidden`.
  To the public, hidden, unpublished, deleted and never-existed are the same
  `404 not_found` with the same body, on every route including assets and export.
- **No caching.** Every publication read answers `Cache-Control: no-store`, so a
  hide takes effect on the next request. A copy already downloaded cannot be
  recalled.
- **No identities.** Public shapes carry the author label the owner typed, never
  an email, account id, session or the private shader's id. A snapshot's
  `shader.id` is the publication id.
- **Sessions.** Writes need a signed-in, email-verified account (401 otherwise).
- **Trusted origin.** A cookie-authenticated `POST`/`PUT`/`DELETE` must carry an
  `Origin` on the server's trusted list (`BETTER_AUTH_URL` plus
  `AUTH_TRUSTED_ORIGINS`), or it is `403 forbidden`.
- **Paging.** `?limit=` (default 24, capped at 50) and `?cursor=` (the previous
  page's `nextCursor`; `null` on the last page). Order is newest first with the
  id as tie-break, so paging a listing nobody is changing never skips or
  repeats. There is no snapshot isolation: an update landing between two pages
  can move a publication across the cursor.
- **Ids.** A publication id is 20 lowercase hex characters, stable across
  update, unpublish and republish.

## Anonymous

| Route                                                | Returns                                                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/capabilities`                              | `ExploreCapabilities`. Always registered; `admin` is `false` for anonymous callers.                                                   |
| `GET /api/publications?search=&sort=&cursor=&limit=` | `PublicationPage`. See [Search, sort and cursors](#search-sort-and-cursors).                                                          |
| `GET /api/publications/:id`                          | `{ publication: PublicationDetail }`                                                                                                  |
| `GET /api/publications/:id/thumbnail`                | Image bytes                                                                                                                           |
| `GET /api/publications/:id/textures/:channel`        | Image bytes for channel `0`–`3`                                                                                                       |
| `GET /api/publications/:id/export`                   | A `shader-studio/v3` bundle (attachment) plus a `publication` block with title, author label, license, attribution and `derivedFrom`. |

## Search, sort and cursors

`GET /api/publications` lists what is public right now; hidden, unpublished and
deleted publications never appear, whatever the query.

- **`search`** (optional, trimmed, at most 64 characters): a case-insensitive
  substring of the title, the description **or** the author label of the
  published snapshot. `%`, `_` and `!` are matched literally. Nothing private
  is searched — not the private shader as it is now, nor any account data.
  Matching is a plain `LIKE` scan: fine at today's volume, not a full-text index.
- **`sort`** (optional): `updated` (the default) orders by the last explicit
  update of the snapshot, `published` by when it was first published. Update,
  unpublish and republish never move `publishedAt`. Both are newest first with
  the id as tie-break. Any other value — including an empty or repeated
  `sort` — is `400 invalid`. The values are `PUBLICATION_SORTS` in the shared
  contract.
- **`cursor`**: opaque to clients. The server issues base64url JSON
  `{ v: 2, sort, search, at, id }`, where `search` is the trimmed, lowercased
  term and `at` the sort's timestamp of the last item. A cursor is only valid
  with the same `sort` and (normalized) `search`; anything else — another
  query, an unknown version, a malformed or out-of-range field, more than 1024
  characters — is `400 invalid`. Cursors are validated, not signed: forging one
  can only start the same public listing at another position.
- **Older cursors.** A version-less `{ at, id }` cursor issued before sorting
  existed is still accepted, in `updated` order only. It never recorded a
  search, so it is not checked against one. The moderators' publication,
  report and audit listings keep issuing and reading plain `{ at, id }`
  cursors exactly as before; their `search` stays title-only.

Indexes: `(updated_at DESC, id DESC)` since migration 4, and
`(published_at DESC, id DESC)` from migration 6 (both engines). On SQLite with
20,000 rows, both sorts walk their index without a sort step, a page takes
under 1 ms, and a search that matches nothing scans the whole index (~14 ms).

**Rollback.** Migration 6 only adds an index. A build without it refuses to
start on a store that has it (the ledger is newer than it supports), so a
behaviour rollback must keep migration 6 and its version: revert the API
change, never the migration, and never lower the ledger. A reverted API cannot
serve `sort=published` to a web client that still asks for it.

## Owner

| Route                                 | Body             | Returns                                                                                    |
| ------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------ |
| `GET /api/shaders/:id/publication`    | —                | `ShaderPublicationStatus` (also readable before email verification)                        |
| `PUT /api/shaders/:id/publication`    | `PublishRequest` | `{ publication: OwnerPublication }` — 201 on first publication, 200 on update or republish |
| `DELETE /api/shaders/:id/publication` | —                | `{ publication: OwnerPublication }` with `ownerVisible: false`                             |

Publishing freezes the shader **as saved** at `expectedRevision`: project
sources, controls, presets, render settings (the post-processing chain), texture
bytes and thumbnail, all read in one transaction that holds the shader row. A
revision that has moved on is `409 conflict` and nothing is published. The title
and description are the shader's own name and description at that revision.

- `rightsConfirmed` must be literally `true`, `license` one of
  `PUBLICATION_LICENSES`, `authorLabel` 1–64 characters, `attribution` at most 500.
- A shader copied from a `CC-BY-SA-4.0` publication can only be published under
  `CC-BY-SA-4.0` (400 otherwise). Its `derivedFrom` is set by the server from
  the recorded origin and cannot be edited away.
- Private edits, sync and thumbnail refreshes never change a snapshot.
- Update and republish keep the public id and **never** clear a moderator's hide.
- A restricted account gets `403 forbidden`; its private library is unaffected.
- Someone else's shader, a bundled template and an unknown id are all `404`.
- Deleting the private shader (including an overwriting import of the same id)
  deletes its publication, assets and reports in the same statement. Deleting
  the account does the same for everything it published, reported or was
  restricted under. The moderation audit trail is kept.

## Any verified account

| Route                                | Body            | Returns                                                                   |
| ------------------------------------ | --------------- | ------------------------------------------------------------------------- |
| `POST /api/publications/:id/copy`    | —               | 201 `{ shader: ShaderRecord }` — a new private shader, never an overwrite |
| `POST /api/publications/:id/reports` | `ReportRequest` | 201 `{ report: { id } }`                                                  |

A copy goes through the same payload validation as any import, takes the author
label as its `author`, and records its origin (`PublicationOrigin`), which
`GET /api/shaders/:id/publication` returns and a later publication carries as
`derivedFrom`. A second open report by the same account on the same publication
is `409 conflict`; after it is resolved the account may report again.

Per account and hour: 30 publishes, 60 copies, 10 reports, then `429`.

## Moderators

All under `/api/admin`, all `403 forbidden` for anyone not on the configured list.

| Route                                                         | Body                   | Returns                                                                             |
| ------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------- |
| `GET /admin/publications?state=&search=&cursor=&limit=`       | —                      | `PublicationPage<AdminPublicationSummary>`; `state` is `all`, `visible` or `hidden` |
| `GET /admin/publications/:id`                                 | —                      | `{ publication: AdminPublicationDetail }`, whatever its visibility                  |
| `GET /admin/publications/:id/thumbnail`, `/textures/:channel` | —                      | Image bytes, whatever its visibility                                                |
| `PUT /admin/publications/:id/moderation`                      | `ModerationRequest`    | `{ publication: AdminPublicationSummary }`                                          |
| `GET /admin/reports?status=&publicationId=&cursor=&limit=`    | —                      | `AdminReportPage`; `status` is `open` (default), `resolved` or `all`                |
| `POST /admin/reports/:id/resolution`                          | `ResolveReportRequest` | `{ report: AdminReport }`                                                           |
| `GET /admin/publishers/:userId/restriction`                   | —                      | `{ restriction: PublisherRestriction }` (`revision: 0` if never restricted)         |
| `PUT /admin/publishers/:userId/restriction`                   | `RestrictionRequest`   | `{ restriction: PublisherRestriction }`                                             |
| `GET /admin/audit?targetId=&cursor=&limit=`                   | —                      | `ModerationAuditPage`                                                               |

- Every write needs a non-empty `reason` (at most 500 characters) and the
  revision the moderator last read: `expectedModerationRevision` for a
  publication, `expectedRevision` for a report or a restriction. A stale one is
  `409 conflict` and nothing changes.
- Every write commits together with its audit row (actor, action, target,
  reason, time). A refused or failed write leaves no audit row.
- Restoring a publication does not make it public if its owner unpublished it.
- A publication cannot be restored while its publisher is restricted (`400 invalid`,
  nothing changes and nothing is audited): lift the restriction first.
- Restricting a publisher hides all their current publications and blocks
  publish, update and republish. Lifting the restriction restores nothing: each
  publication stays hidden until a moderator restores it.

## Deliberately not here yet

Desktop Explore or publishing, publication data in desktop sync, role
management, appeals, likes/comments, server-side rendering of shaders, fetching
remote assets, ranking, tag or capability filters, full-text search, and
search beyond titles for moderators.
