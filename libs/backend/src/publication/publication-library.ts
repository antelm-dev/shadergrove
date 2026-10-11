/**
 * The publication domain: everything that decides *what* a public snapshot is,
 * who may change it and who may see it. Like `ShaderLibrary` it is
 * engine-agnostic — the SQL lives in `PublicationStore`.
 *
 * The rules it holds, in one place:
 *   - A snapshot is cut from the private shader inside one transaction that
 *     holds the shader row, so sources, presets and image bytes always belong
 *     to the same moment, whatever else is being saved meanwhile.
 *   - Nothing but an explicit `publish` ever writes a snapshot. Private edits,
 *     sync and thumbnail refreshes do not reach it.
 *   - Public visibility is `ownerVisible && !moderatorHidden`. The owner's
 *     paths never write the moderator's flag and vice versa.
 *   - Anything not publicly visible is `not_found` to the public, without
 *     distinction between hidden, unpublished and never existed.
 *   - Every moderation write is a compare-and-set on a revision and commits
 *     together with its audit row, or not at all.
 *
 * Who is a moderator is not decided here: the server checks that before
 * calling, and passes the acting account in for the audit trail.
 */

import { randomBytes } from 'node:crypto';

import {
  DEFAULT_TEXTURE_CHANNEL,
  toPayload,
  type ShaderPayload,
  type ShaderRecord,
  type TextureChannelPayloads,
} from '@shadergrove/shared/model';
import {
  DEFAULT_PUBLICATION_SORT,
  PUBLICATION_LICENSES,
  PUBLICATION_LIMITS,
  PUBLICATION_SORTS,
  REPORT_REASONS,
  SHARE_ALIKE_LICENSE,
  type AdminPublicationDetail,
  type AdminPublicationSummary,
  type AdminReport,
  type AdminReportPage,
  type ModerationAction,
  type ModerationAuditEntry,
  type ModerationAuditPage,
  type OwnerPublication,
  type PublicationDetail,
  type PublicationLicense,
  type PublicationOrigin,
  type PublicationPage,
  type PublicationSort,
  type PublicationSummary,
  type PublisherRestriction,
  type ReportReason,
  type ReportStatus,
  type ShaderPublicationStatus,
} from '@shadergrove/shared/publication';
import {
  slugify,
  validateId,
  validateName,
  validateShaderPayload,
} from '@shadergrove/shared/validate';

import type { ShaderLibrary } from '../library/shader-library';
import { expect, StorageError } from '../library/storage-error';
import {
  textureAssetKey,
  THUMBNAIL_ASSET_KEY,
  type AssetKey,
} from '../persistence/shader-repository';
import type {
  PageCursor,
  PublicationRepository,
  PublicationRow,
  PublicationStore,
  ReportRow,
} from './publication-store';

/** Twenty hex characters: unguessable, and a valid shader id so a snapshot validates as a payload. */
const PUBLICATION_ID = /^[a-f0-9]{20}$/;
const USER_ID = /^[\w-]{1,64}$/;

type Input = Record<string, unknown>;

export class PublicationLibrary {
  constructor(
    private readonly repo: PublicationRepository,
    private readonly library: ShaderLibrary,
  ) {}

  // --- public reads ---------------------------------------------------------

  /**
   * Its own path rather than `page()`: the public listing searches more fields,
   * sorts two ways and binds its cursors to both, while the moderators' listing
   * keeps its title search, updated order and plain cursors.
   */
  async listPublic(query: Input): Promise<PublicationPage> {
    const sort = oneOf(query['sort'] ?? DEFAULT_PUBLICATION_SORT, PUBLICATION_SORTS, 'sort');
    // Lowercased because that is all the match depends on, so it is what a cursor binds to.
    const search = text(query['search'], 'search', {
      max: PUBLICATION_LIMITS.searchLength,
    }).toLowerCase();
    const limit = pageSize(query['limit']);
    const rows = await this.repo.publications.list({
      state: 'visible',
      searchIn: 'public',
      sort,
      ...(search ? { search } : {}),
      ...publicBefore(query['cursor'], sort, search),
      limit: limit + 1,
    });
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      publications: items.map(toSummary),
      nextCursor: rows.length > limit && last ? publicCursor(sort, search, last) : null,
    };
  }

  async readPublic(id: string): Promise<PublicationDetail> {
    const { row, shader } = await detailed(this.repo.publications, id);
    if (!isPublic(row)) throw notFound();
    return { ...toSummary(row), ...credits(row), shader };
  }

  async readPublicAsset(id: string, key: AssetKey): Promise<{ bytes: Uint8Array; ext: string }> {
    return this.asset(id, key, true);
  }

  /** The snapshot with its image bytes inlined — an importable payload. */
  async exportPublic(
    id: string,
  ): Promise<{ publication: PublicationDetail; shader: ShaderPayload }> {
    return this.repo.publicationTransaction(async (_tx, store) => {
      // Held so an owner's update cannot land between the snapshot and its assets.
      await store.lockPublication(id);
      const row = await this.visible(store, id);
      const shader = await payloadOf(store, row);
      const bare = { ...shader, thumbnail: null, channels: withoutBytes(shader.channels) };
      return { publication: { ...toSummary(row), ...credits(row), shader: bare }, shader };
    });
  }

  // --- the owner ------------------------------------------------------------

  async status(userId: string, shaderId: string): Promise<ShaderPublicationStatus> {
    // Scoped read first: someone else's shader is `not_found` before anything is looked up.
    const record = await this.library.as({ userId }).read(shaderId);
    const store = this.repo.publications;
    const row = await store.findBySource(record.id);
    return {
      publication: row && row.ownerUserId === userId ? toOwner(row) : null,
      origin: parseOrigin(await store.origin(record.id)),
      restricted: (await store.restriction(userId))?.restricted ?? false,
    };
  }

  /**
   * Publishes the shader as it is stored at `expectedRevision`, or replaces the
   * snapshot of one already published (the public id stays). Also how an
   * unpublished shader goes back up. It never clears a moderator's hide.
   */
  async publish(
    userId: string,
    shaderId: string,
    input: Input,
  ): Promise<{ publication: OwnerPublication; created: boolean }> {
    const expectedRevision = integer(input['expectedRevision'], 'expectedRevision', 1);
    const authorLabel = expect(
      validateName(input['authorLabel'], 'authorLabel'),
      'Invalid author name',
    );
    const license = oneOf(input['license'], PUBLICATION_LICENSES, 'license');
    const attribution = text(input['attribution'], 'attribution', {
      max: PUBLICATION_LIMITS.attributionLength,
    });
    if (input['rightsConfirmed'] !== true) {
      throw new StorageError(
        'invalid',
        'Confirm that you have the right to publish these sources and textures',
      );
    }
    const now = new Date().toISOString();

    return this.repo.publicationTransaction(async (tx, store) => {
      const { record, assets } = await this.library.as({ userId }).snapshotWithin(tx, shaderId);
      if (record.revision !== expectedRevision) {
        throw new StorageError(
          'conflict',
          `Shader "${shaderId}" has changed since revision ${expectedRevision}; nothing was published`,
        );
      }
      await store.lockPublisher(userId);
      if ((await store.restriction(userId))?.restricted) {
        throw new StorageError('forbidden', 'Publishing is restricted for this account');
      }
      const origin = parseOrigin(await store.origin(record.id));
      if (origin?.license === SHARE_ALIKE_LICENSE && license !== SHARE_ALIKE_LICENSE) {
        throw new StorageError(
          'invalid',
          `A shader derived from a ${SHARE_ALIKE_LICENSE} work must be published under ${SHARE_ALIKE_LICENSE}`,
        );
      }

      const existing = await store.findBySource(record.id);
      const id = existing?.id ?? randomId();
      const stored = new Set(assets.map((asset) => asset.key));
      const payload = toPayload(record);
      const snapshot: ShaderPayload = {
        ...payload,
        id,
        author: authorLabel,
        // A channel whose bytes are gone is published empty rather than dangling.
        channels: payload.channels.map((channel, index) =>
          channel.ext !== null && !stored.has(textureAssetKey(index))
            ? { ...DEFAULT_TEXTURE_CHANNEL, data: null }
            : channel,
        ) as unknown as TextureChannelPayloads,
      };
      const content = {
        title: record.name,
        description: record.description,
        authorLabel,
        license,
        attribution,
        derivedFromJson: origin ? JSON.stringify(origin) : null,
        sourceRevision: record.revision,
        snapshotJson: JSON.stringify(snapshot),
      };
      if (existing) await store.replaceContent(id, content, now);
      else await store.insert(id, record.id, userId, content, now);
      await store.replaceAssets(id, assets);

      return { publication: toOwner(await found(store, id)), created: !existing };
    });
  }

  /** Takes it down on the owner's side. The row, its id and any moderation state stay. */
  async unpublish(userId: string, shaderId: string): Promise<OwnerPublication> {
    const validId = expect(validateId(shaderId), `Invalid shader id "${shaderId}"`);
    return this.repo.publicationTransaction(async (_tx, store) => {
      const row = await store.findBySource(validId);
      if (!row || row.ownerUserId !== userId) throw notFound();
      await store.setOwnerVisible(row.id, false);
      return toOwner({ ...row, ownerVisible: false });
    });
  }

  // --- any verified account -------------------------------------------------

  /**
   * Copies a public snapshot into the caller's private library as a new
   * shader — never over an existing one — and records where it came from, so
   * the credit follows the copy into anything published from it later.
   */
  async copy(userId: string, id: string): Promise<ShaderRecord> {
    const { row, payload } = await this.repo.publicationTransaction(async (_tx, store) => {
      await store.lockPublication(id);
      const visible = await this.visible(store, id);
      return { row: visible, payload: await payloadOf(store, visible) };
    });
    // Through the same validation as any import: a snapshot is trusted no more than a bundle.
    const valid = expect(
      validateShaderPayload({ ...payload, id: slugify(row.title) }),
      'This publication can no longer be copied',
    );
    const library = this.library.as({ userId });
    const copyId = (await library.importPayloads([valid], 'rename')).imported[0].id;
    try {
      await this.repo.publications.putOrigin(
        copyId,
        JSON.stringify(originOf(row)),
        new Date().toISOString(),
      );
    } catch (error) {
      // A copy without its credit is worse than no copy.
      await library.remove(copyId).catch(() => undefined);
      throw error;
    }
    return library.read(copyId);
  }

  async report(userId: string, id: string, input: Input): Promise<{ id: string }> {
    const reason = oneOf(input['reason'], REPORT_REASONS, 'reason');
    const body = text(input['body'], 'body', { max: PUBLICATION_LIMITS.reportBodyLength });
    const store = this.repo.publications;
    const row = await this.visible(store, id);
    const report = { id: randomId(), publicationId: row.id, reporterUserId: userId, reason, body };
    if (!(await store.insertReport({ ...report, now: new Date().toISOString() }))) {
      throw new StorageError('conflict', 'You already have an open report on this publication');
    }
    return { id: report.id };
  }

  // --- moderators -----------------------------------------------------------

  async adminList(query: Input): Promise<PublicationPage<AdminPublicationSummary>> {
    const state = oneOf(query['state'] ?? 'all', ['all', 'visible', 'hidden'] as const, 'state');
    const { rows, nextCursor } = await this.page(query, state === 'all' ? undefined : state);
    return { publications: rows.map(toAdmin), nextCursor };
  }

  /** Readable whatever its visibility — this is how a reported snapshot is inspected. */
  async adminRead(id: string): Promise<AdminPublicationDetail> {
    const { row, shader } = await detailed(this.repo.publications, id);
    return { ...toAdmin(row), ...credits(row), shader };
  }

  async adminAsset(id: string, key: AssetKey): Promise<{ bytes: Uint8Array; ext: string }> {
    return this.asset(id, key, false);
  }

  async moderate(actorUserId: string, id: string, input: Input): Promise<AdminPublicationSummary> {
    const hidden = boolean(input['hidden'], 'hidden');
    const reason = text(input['reason'], 'reason', { required: true });
    const expected = integer(input['expectedModerationRevision'], 'expectedModerationRevision', 1);
    return this.repo.publicationTransaction(async (_tx, store) => {
      if (!hidden) {
        // A restriction is what hid this publisher's work; restoring one piece
        // of it while the restriction stands would put a restricted account
        // back on Explore. Held under the publisher's lock, so a restriction
        // arriving at the same moment either sees the restore or stops it.
        const { ownerUserId } = await found(store, id);
        await store.lockPublisher(ownerUserId);
        if ((await store.restriction(ownerUserId))?.restricted) {
          throw new StorageError(
            'invalid',
            'This publisher is restricted. Lift the restriction before restoring their publications',
          );
        }
      }
      if (!(await store.setModeratorHidden(id, hidden, expected))) {
        await found(store, id);
        throw stale('publication');
      }
      const action = hidden ? 'publication.hide' : 'publication.restore';
      await audit(store, actorUserId, action, 'publication', id, reason);
      return toAdmin(await found(store, id));
    });
  }

  async listReports(query: Input): Promise<AdminReportPage> {
    const status = oneOf(query['status'] ?? 'open', ['open', 'resolved', 'all'] as const, 'status');
    const publicationId = query['publicationId'];
    const limit = pageSize(query['limit']);
    const rows = await this.repo.publications.listReports({
      ...(status === 'all' ? {} : { status }),
      ...(typeof publicationId === 'string' && publicationId ? { publicationId } : {}),
      ...before(query['cursor']),
      limit: limit + 1,
    });
    const items = rows.slice(0, limit);
    return {
      reports: items.map(toReport),
      nextCursor: nextCursor(rows, limit, (row) => row.createdAt),
    };
  }

  async resolveReport(actorUserId: string, id: string, input: Input): Promise<AdminReport> {
    const reason = text(input['reason'], 'reason', { required: true });
    const expected = integer(input['expectedRevision'], 'expectedRevision', 1);
    const now = new Date().toISOString();
    return this.repo.publicationTransaction(async (_tx, store) => {
      if (!(await store.resolveReport(id, expected, reason, now))) {
        if (!(await store.findReport(id))) throw notFound('Report was not found');
        throw stale('report');
      }
      await audit(store, actorUserId, 'report.resolve', 'report', id, reason);
      return toReport((await store.findReport(id))!);
    });
  }

  async restriction(userId: string): Promise<PublisherRestriction> {
    const store = this.repo.publications;
    await knownUser(store, userId);
    return restrictionOf(store, userId);
  }

  /**
   * Restricting blocks publish, update and republish and takes every current
   * publication down; private editing is untouched. While it stands nothing of
   * theirs can be restored, and lifting it restores nothing either — each
   * publication stays hidden until a moderator restores it.
   */
  async setRestriction(
    actorUserId: string,
    userId: string,
    input: Input,
  ): Promise<PublisherRestriction> {
    const restricted = boolean(input['restricted'], 'restricted');
    const reason = text(input['reason'], 'reason', { required: true });
    const expected = integer(input['expectedRevision'], 'expectedRevision', 0);
    const now = new Date().toISOString();
    return this.repo.publicationTransaction(async (_tx, store) => {
      await knownUser(store, userId);
      await store.lockPublisher(userId);
      if (!(await store.setRestriction(userId, restricted, reason, expected, now))) {
        throw stale('restriction');
      }
      if (restricted) await store.hideAllByOwner(userId);
      const action = restricted ? 'publisher.restrict' : 'publisher.unrestrict';
      await audit(store, actorUserId, action, 'publisher', userId, reason);
      return restrictionOf(store, userId);
    });
  }

  async listAudit(query: Input): Promise<ModerationAuditPage> {
    const targetId = query['targetId'];
    const limit = pageSize(query['limit']);
    const rows = await this.repo.publications.listAudit({
      ...(typeof targetId === 'string' && targetId ? { targetId } : {}),
      ...before(query['cursor']),
      limit: limit + 1,
    });
    return {
      entries: rows.slice(0, limit) as ModerationAuditEntry[],
      nextCursor: nextCursor(rows, limit, (row) => row.at),
    };
  }

  // --- internals ------------------------------------------------------------

  private async page(
    query: Input,
    state: 'visible' | 'hidden' | undefined,
  ): Promise<{ rows: PublicationRow[]; nextCursor: string | null }> {
    const search = text(query['search'], 'search', { max: PUBLICATION_LIMITS.searchLength });
    const limit = pageSize(query['limit']);
    const rows = await this.repo.publications.list({
      ...(state ? { state } : {}),
      ...(search ? { search } : {}),
      ...before(query['cursor']),
      limit: limit + 1,
    });
    return {
      rows: rows.slice(0, limit),
      nextCursor: nextCursor(rows, limit, (row) => row.updatedAt),
    };
  }

  /** The publication, if the public may see it right now. */
  private async visible(store: PublicationStore, id: string): Promise<PublicationRow> {
    const row = await found(store, id);
    if (!isPublic(row)) throw notFound();
    return row;
  }

  private async asset(
    id: string,
    key: AssetKey,
    visibleOnly: boolean,
  ): Promise<{ bytes: Uint8Array; ext: string }> {
    const asset = PUBLICATION_ID.test(id)
      ? await this.repo.publications.asset(id, key, visibleOnly)
      : null;
    if (!asset) throw notFound();
    return { bytes: asset.data, ext: asset.extension };
  }
}

// --- mapping ----------------------------------------------------------------

function toSummary(row: PublicationRow): PublicationSummary {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    authorLabel: row.authorLabel,
    license: row.license as PublicationLicense,
    revision: row.revision,
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
    hasThumbnail: row.hasThumbnail,
  };
}

function credits(row: PublicationRow): {
  attribution: string;
  derivedFrom: PublicationOrigin | null;
} {
  return { attribution: row.attribution, derivedFrom: parseOrigin(row.derivedFromJson) };
}

function toOwner(row: PublicationRow): OwnerPublication {
  return {
    ...toSummary(row),
    ...credits(row),
    ownerVisible: row.ownerVisible,
    moderatorHidden: row.moderatorHidden,
    sourceRevision: row.sourceRevision,
  };
}

function toAdmin(row: PublicationRow): AdminPublicationSummary {
  return {
    ...toSummary(row),
    ownerUserId: row.ownerUserId,
    ownerVisible: row.ownerVisible,
    moderatorHidden: row.moderatorHidden,
    moderationRevision: row.moderationRevision,
    openReports: row.openReports,
    publisherRestricted: row.publisherRestricted,
  };
}

function toReport(row: ReportRow): AdminReport {
  return { ...row, reason: row.reason as ReportReason, status: row.status as ReportStatus };
}

/**
 * What a copy of `row` records about its source. Earlier credits are folded
 * into the text, so they survive any number of copy-and-republish steps.
 */
function originOf(row: PublicationRow): PublicationOrigin {
  const earlier = parseOrigin(row.derivedFromJson);
  const chain = earlier
    ? `Based on "${earlier.title}" by ${earlier.authorLabel} (${earlier.license}). ${earlier.attribution}`
    : '';
  return {
    publicationId: row.id,
    title: row.title,
    authorLabel: row.authorLabel,
    license: row.license as PublicationLicense,
    attribution: [row.attribution, chain]
      .filter(Boolean)
      .join(' ')
      .trim()
      // ponytail: a long chain of credits is cut here; store the chain as a list if that ever bites.
      .slice(0, PUBLICATION_LIMITS.attributionLength * 4),
  };
}

function parseOrigin(json: string | null): PublicationOrigin | null {
  return json === null ? null : (JSON.parse(json) as PublicationOrigin);
}

async function snapshotOf(store: PublicationStore, id: string): Promise<ShaderPayload> {
  const json = await store.snapshot(id);
  if (json === null) throw notFound();
  return JSON.parse(json) as ShaderPayload;
}

/** The snapshot with every stored image inlined as base64. */
async function payloadOf(store: PublicationStore, row: PublicationRow): Promise<ShaderPayload> {
  const snapshot = await snapshotOf(store, row.id);
  const assets = new Map((await store.assets(row.id)).map((asset) => [asset.key, asset]));
  const thumbnail = assets.get(THUMBNAIL_ASSET_KEY);
  return {
    ...snapshot,
    channels: snapshot.channels.map((channel, index) => {
      const asset = assets.get(textureAssetKey(index));
      return { ...channel, data: asset ? base64(asset.data) : null };
    }) as unknown as TextureChannelPayloads,
    thumbnail: thumbnail
      ? { ext: thumbnail.extension, updatedAt: row.updatedAt, data: base64(thumbnail.data) }
      : null,
  };
}

function withoutBytes(channels: TextureChannelPayloads): TextureChannelPayloads {
  return channels.map((channel) => ({
    ...channel,
    data: null,
  })) as unknown as TextureChannelPayloads;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function isPublic(row: PublicationRow): boolean {
  return row.ownerVisible && !row.moderatorHidden;
}

/** The publication and the snapshot that belongs to that very revision of it. */
async function detailed(
  store: PublicationStore,
  id: string,
): Promise<{ row: PublicationRow; shader: ShaderPayload }> {
  const result = PUBLICATION_ID.test(id) ? await store.findWithSnapshot(id) : null;
  if (!result) throw notFound();
  return { row: result.row, shader: JSON.parse(result.snapshotJson) as ShaderPayload };
}

async function found(store: PublicationStore, id: string): Promise<PublicationRow> {
  const row = PUBLICATION_ID.test(id) ? await store.find(id) : null;
  if (!row) throw notFound();
  return row;
}

async function knownUser(store: PublicationStore, userId: string): Promise<void> {
  if (!USER_ID.test(userId) || !(await store.userExists(userId))) {
    throw notFound('Account was not found');
  }
}

async function restrictionOf(
  store: PublicationStore,
  userId: string,
): Promise<PublisherRestriction> {
  const row = await store.restriction(userId);
  return row
    ? { userId, ...row }
    : { userId, restricted: false, revision: 0, reason: '', updatedAt: null };
}

async function audit(
  store: PublicationStore,
  actorUserId: string,
  action: ModerationAction,
  targetType: ModerationAuditEntry['targetType'],
  targetId: string,
  reason: string,
): Promise<void> {
  await store.insertAudit({
    id: randomId(),
    at: new Date().toISOString(),
    actorUserId,
    action,
    targetType,
    targetId,
    reason,
  });
}

function randomId(): string {
  return randomBytes(10).toString('hex');
}

function notFound(message = 'Publication was not found'): StorageError {
  return new StorageError('not_found', message);
}

function stale(what: string): StorageError {
  return new StorageError(
    'conflict',
    `The ${what} was changed by someone else; reload it and try again`,
  );
}

// --- input ------------------------------------------------------------------

function integer(value: unknown, field: string, min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new StorageError('invalid', `${field} must be an integer of at least ${min}`);
  }
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new StorageError('invalid', `${field} must be a boolean`);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value as T)) {
    throw new StorageError('invalid', `${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

/** Trimmed text within `max`; absent is `''` unless `required`. */
function text(
  value: unknown,
  field: string,
  options: { max?: number; required?: boolean },
): string {
  const max = options.max ?? PUBLICATION_LIMITS.reasonLength;
  const raw = value ?? '';
  // oxlint-disable-next-line no-control-regex
  if (typeof raw !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)) {
    throw new StorageError('invalid', `${field} must be text without control characters`);
  }
  const trimmed = raw.trim();
  if (trimmed.length > max) {
    throw new StorageError('invalid', `${field} must be at most ${max} characters`);
  }
  if (options.required && trimmed.length === 0) {
    throw new StorageError('invalid', `${field} is required`);
  }
  return trimmed;
}

/** Query strings arrive as text, so a page size is parsed rather than type-checked. */
function pageSize(value: unknown): number {
  if (value === undefined) return PUBLICATION_LIMITS.pageSize;
  const size = Number(value);
  if (!['string', 'number'].includes(typeof value) || !Number.isInteger(size) || size < 1) {
    throw new StorageError('invalid', 'limit must be a positive integer');
  }
  return Math.min(size, PUBLICATION_LIMITS.maxPageSize);
}

function before(cursor: unknown): { before?: PageCursor } {
  if (cursor === undefined || cursor === '') return {};
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString()) as PageCursor;
    if (typeof parsed.at === 'string' && typeof parsed.id === 'string') {
      return { before: { at: parsed.at, id: parsed.id } };
    }
  } catch {
    // falls through to the one error below
  }
  throw new StorageError('invalid', 'cursor is not valid');
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * A public cursor: `{ v: 2, sort, search, at, id }` as base64url JSON, bound to
 * the sort and normalized search it was issued for. Not signed: it only names a
 * position in a listing anyone may read, so a forged one can do no more than
 * start that listing somewhere else.
 */
function publicCursor(sort: PublicationSort, search: string, row: PublicationRow): string {
  const at = sort === 'published' ? row.publishedAt : row.updatedAt;
  return Buffer.from(JSON.stringify({ v: 2, sort, search, at, id: row.id })).toString('base64url');
}

/**
 * Reads a public cursor back, refusing anything this server would not have
 * issued for this `sort` and `search`. A version-less `{ at, id }` from before
 * sorting existed is still taken, in `updated` order only: it never recorded a
 * search, so it is not checked against one.
 */
function publicBefore(
  cursor: unknown,
  sort: PublicationSort,
  search: string,
): { before?: PageCursor } {
  if (cursor === undefined || cursor === '') return {};
  const invalid = new StorageError('invalid', 'cursor is not valid');
  if (
    typeof cursor !== 'string' ||
    cursor.length > PUBLICATION_LIMITS.cursorLength ||
    !/^[\w-]+$/.test(cursor)
  ) {
    throw invalid;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
  } catch {
    throw invalid;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw invalid;
  const fields = parsed as Record<string, unknown>;
  const { at, id } = fields;
  if (
    typeof at !== 'string' ||
    !TIMESTAMP.test(at) ||
    Number.isNaN(Date.parse(at)) ||
    typeof id !== 'string' ||
    !PUBLICATION_ID.test(id)
  ) {
    throw invalid;
  }
  const keys = Object.keys(fields).length;
  if (!('v' in fields)) {
    if (keys !== 2 || sort !== 'updated') throw invalid;
  } else if (fields['v'] !== 2 || keys !== 5 || typeof fields['search'] !== 'string') {
    throw invalid;
  } else if (fields['sort'] !== sort || fields['search'] !== search) {
    throw new StorageError(
      'invalid',
      'cursor belongs to another search or sort; start again without it',
    );
  }
  return { before: { at, id } };
}

/** `rows` was fetched with one extra: its presence is what says there is a next page. */
function nextCursor<T extends { id: string }>(
  rows: readonly T[],
  limit: number,
  at: (row: T) => string,
): string | null {
  if (rows.length <= limit) return null;
  const last = rows[limit - 1];
  return Buffer.from(JSON.stringify({ at: at(last), id: last.id })).toString('base64url');
}
