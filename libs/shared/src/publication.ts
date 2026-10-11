/**
 * The public Explore contract, shared by the server and the web client.
 *
 * A publication is a frozen snapshot of one private shader, published on
 * purpose by its owner. Editing the private shader never changes it; only an
 * explicit update does. Whether the world can see it is two independent
 * switches — the owner's (`ownerVisible`) and a moderator's
 * (`moderatorHidden`) — and it is public only while the first is on and the
 * second is off, so neither side can undo the other's decision.
 *
 * Nothing here carries an email address, a session, the private shader's id or
 * a moderator's note to a public caller: those fields exist only on the
 * `Admin*` and `Owner*` shapes.
 */

import type { ShaderPayload } from './model';

/** Licenses a publication may carry. All of them allow the copy-to-edit Explore is built on. */
export const PUBLICATION_LICENSES = ['CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'MIT'] as const;
export type PublicationLicense = (typeof PUBLICATION_LICENSES)[number];

/** A work derived from one under this license has to keep it. */
export const SHARE_ALIKE_LICENSE: PublicationLicense = 'CC-BY-SA-4.0';

export const REPORT_REASONS = ['copyright', 'inappropriate', 'spam', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const PUBLICATION_LIMITS = {
  attributionLength: 500,
  /** A moderator's reason, and a report's resolution. */
  reasonLength: 500,
  reportBodyLength: 1000,
  searchLength: 64,
  pageSize: 24,
  maxPageSize: 50,
  /** Longer than any cursor the server emits; anything past it is refused unread. */
  cursorLength: 1024,
} as const;

/**
 * How the public listing is ordered, newest first either way: by the last
 * explicit update of the snapshot, or by when it was first published (which
 * no update, unpublish or republish ever moves).
 */
export const PUBLICATION_SORTS = ['updated', 'published'] as const;
export type PublicationSort = (typeof PUBLICATION_SORTS)[number];
export const DEFAULT_PUBLICATION_SORT: PublicationSort = 'updated';

/** `GET /api/capabilities` — what this server offers the caller. Anonymous callers never get `admin`. */
export interface ExploreCapabilities {
  publicExplore: boolean;
  admin: boolean;
}

/** Where a private copy came from; carried into anything later published from it. */
export interface PublicationOrigin {
  publicationId: string;
  title: string;
  authorLabel: string;
  license: PublicationLicense;
  attribution: string;
}

export interface PublicationSummary {
  /** Opaque and stable: it survives every update, unpublish and republish. */
  id: string;
  title: string;
  description: string;
  /** The name the owner chose to publish under. Never an email address. */
  authorLabel: string;
  license: PublicationLicense;
  /** Increments on every explicit update of the snapshot. */
  revision: number;
  publishedAt: string;
  updatedAt: string;
  hasThumbnail: boolean;
}

export interface PublicationDetail extends PublicationSummary {
  /** The owner's own credits, free text. */
  attribution: string;
  derivedFrom: PublicationOrigin | null;
  /**
   * The frozen shader. Its `id` is the publication id, image bytes are left
   * out (`channels[n].data` and `thumbnail` are `null`) and come from
   * `/api/publications/:id/textures/:channel` and `/thumbnail` instead.
   */
  shader: ShaderPayload;
}

/** What the owner sees about their own publication. */
export interface OwnerPublication extends PublicationSummary {
  attribution: string;
  derivedFrom: PublicationOrigin | null;
  ownerVisible: boolean;
  /** A moderator took it down. Republishing or updating does not bring it back. */
  moderatorHidden: boolean;
  /** The private shader revision the snapshot was taken at. */
  sourceRevision: number;
}

/** `GET /api/shaders/:id/publication`. */
export interface ShaderPublicationStatus {
  publication: OwnerPublication | null;
  origin: PublicationOrigin | null;
  /** Publishing is blocked for this account; private editing is not. */
  restricted: boolean;
}

/** `PUT /api/shaders/:id/publication` — publish, update or republish. */
export interface PublishRequest {
  /** The private shader revision being published; a stale one is a 409. */
  expectedRevision: number;
  authorLabel: string;
  license: PublicationLicense;
  attribution?: string;
  /** Must be literally `true`: the owner states they may redistribute sources and textures. */
  rightsConfirmed: true;
}

/** `POST /api/publications/:id/reports`. */
export interface ReportRequest {
  reason: ReportReason;
  body?: string;
}

export interface PublicationPage<T = PublicationSummary> {
  publications: T[];
  /** Pass back as `cursor` for the next page; `null` on the last one. */
  nextCursor: string | null;
}

// --- administration ---------------------------------------------------------

export type PublicationStateFilter = 'all' | 'visible' | 'hidden';

export interface AdminPublicationSummary extends PublicationSummary {
  /** Immutable account id — what a restriction is keyed on. */
  ownerUserId: string;
  ownerVisible: boolean;
  moderatorHidden: boolean;
  /** Pass back as `expectedModerationRevision`; a stale one is a 409. */
  moderationRevision: number;
  openReports: number;
  publisherRestricted: boolean;
}

export interface AdminPublicationDetail extends AdminPublicationSummary {
  attribution: string;
  derivedFrom: PublicationOrigin | null;
  /** Readable here even while hidden; bytes come from `/api/admin/publications/:id/...`. */
  shader: ShaderPayload;
}

/** `PUT /api/admin/publications/:id/moderation`. */
export interface ModerationRequest {
  hidden: boolean;
  reason: string;
  expectedModerationRevision: number;
}

export type ReportStatus = 'open' | 'resolved';
export type ReportStatusFilter = ReportStatus | 'all';

export interface AdminReport {
  id: string;
  publicationId: string;
  publicationTitle: string;
  reporterUserId: string;
  reason: ReportReason;
  body: string;
  createdAt: string;
  status: ReportStatus;
  /** Pass back as `expectedRevision` when resolving. */
  revision: number;
  resolvedAt: string | null;
  resolution: string | null;
}

export interface AdminReportPage {
  reports: AdminReport[];
  nextCursor: string | null;
}

/** `POST /api/admin/reports/:id/resolution`. */
export interface ResolveReportRequest {
  reason: string;
  expectedRevision: number;
}

export interface PublisherRestriction {
  userId: string;
  restricted: boolean;
  /** 0 for an account that was never restricted. Pass back as `expectedRevision`. */
  revision: number;
  reason: string;
  updatedAt: string | null;
}

/** `PUT /api/admin/publishers/:userId/restriction`. */
export interface RestrictionRequest {
  restricted: boolean;
  reason: string;
  expectedRevision: number;
}

export type ModerationAction =
  | 'publication.hide'
  | 'publication.restore'
  | 'report.resolve'
  | 'publisher.restrict'
  | 'publisher.unrestrict';

export interface ModerationAuditEntry {
  id: string;
  at: string;
  actorUserId: string;
  action: ModerationAction;
  targetType: 'publication' | 'report' | 'publisher';
  targetId: string;
  reason: string;
}

export interface ModerationAuditPage {
  entries: ModerationAuditEntry[];
  nextCursor: string | null;
}
