/**
 * The HTTP face of public Explore: anonymous reads of published snapshots, the
 * owner's publish/unpublish, and copy and report for any verified account. The
 * moderation routes are in admin/.
 *
 * Two things here are deliberately unlike the private shader API next door:
 *
 *  - The public reads are `@Public()` and answer `Cache-Control: no-store`. A
 *    publication can be hidden at any moment, and a cached copy of its detail
 *    or its textures would keep serving it after that.
 *  - Every cookie-authenticated write is checked against the trusted origins
 *    (`TrustedOriginGuard`).
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Inject,
  Logger,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { fromNodeHeaders } from 'better-auth/node';

import { StorageError } from '@shadergrove/backend/library';
import { THUMBNAIL_ASSET_KEY } from '@shadergrove/backend/persistence';
import type { PublicationLibrary } from '@shadergrove/backend/publication';
import {
  DEFAULT_PUBLICATION_SORT,
  PUBLICATION_LIMITS,
  PUBLICATION_SORTS,
  type ExploreCapabilities,
} from '@shadergrove/shared/publication';
import { buildShaderBundle, slugify } from '@shadergrove/shared/validate';

import { resolvePrincipal, type Auth, type Principal } from '../auth/auth';
import { AUTH_INSTANCE, EXPLORE } from '../core/api.constants';
import { AllowUnverified, CurrentUser, Public } from '../core/auth.guard';
import { ApiErrors } from '../core/swagger';
import { TrustedOriginGuard } from '../core/trusted-origin.guard';
import { windowLimiter } from '../core/window-limiter';
import { sendImage, textureKey } from './assets';
import { isAdmin, type Explore } from './explore';

type JsonBody = Record<string, unknown> | undefined;
type QueryParams = Record<string, unknown>;

const HOUR_MS = 60 * 60 * 1000;

/** Always registered, so the web app can ask whether Explore exists at all. */
@ApiTags('explore')
@Controller()
export class CapabilitiesController {
  constructor(
    @Inject(EXPLORE) private readonly explore: Explore,
    @Inject(AUTH_INSTANCE) private readonly auth: Auth,
  ) {}

  @ApiOperation({
    summary: 'What this server offers the caller',
    description: '`admin` is only ever true for a signed-in, verified moderator.',
  })
  @Public()
  @Get('capabilities')
  @Header('Cache-Control', 'no-store')
  async capabilities(@Req() request: Request): Promise<ExploreCapabilities> {
    if (!this.explore.publications) return { publicExplore: false, admin: false };
    // The route is public, so the guard resolved nobody; look, but never require.
    const principal = await resolvePrincipal(this.auth, fromNodeHeaders(request.headers));
    return { publicExplore: true, admin: isAdmin(this.explore, principal) };
  }
}

@ApiTags('explore')
@Controller()
@UseGuards(TrustedOriginGuard)
export class PublicationsController {
  private readonly logger = new Logger('explore');
  // Per account, per process — the same shape as the sign-in limiter.
  private readonly limits = {
    publish: windowLimiter(HOUR_MS, 30),
    copy: windowLimiter(HOUR_MS, 60),
    report: windowLimiter(HOUR_MS, 10),
  };

  constructor(
    @Inject(EXPLORE) private readonly explore: Explore,
    @Inject(AUTH_INSTANCE) private readonly auth: Auth,
  ) {}

  private get publications(): PublicationLibrary {
    return this.explore.publications!;
  }

  private throttle(kind: keyof PublicationsController['limits'], principal: Principal): void {
    if (this.auth.options.rateLimit?.enabled && !this.limits[kind](principal.userId)) {
      throw new StorageError('rate_limited', 'Too many requests. Try again later.');
    }
  }

  // --- anonymous ------------------------------------------------------------

  @ApiOperation({
    summary: 'List public shaders',
    description:
      'Newest first by `sort`. `search` matches the title, description or author label. ' +
      '`cursor` is the `nextCursor` of the previous page, for the same `search` and `sort`.',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: 'string',
    description: `Case-insensitive substring, at most ${PUBLICATION_LIMITS.searchLength} characters.`,
  })
  @ApiQuery({
    name: 'sort',
    required: false,
    enum: [...PUBLICATION_SORTS],
    description:
      '`updated` (default): last explicit update. `published`: first publication. ' +
      'Anything else is a 400.',
    example: DEFAULT_PUBLICATION_SORT,
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    type: 'string',
    description: 'Opaque. One issued for another `search` or `sort` is a 400.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: 'integer',
    description: `Page size, ${PUBLICATION_LIMITS.pageSize} by default, capped at ${PUBLICATION_LIMITS.maxPageSize}.`,
  })
  @ApiErrors(400)
  @Public()
  @Get('publications')
  @Header('Cache-Control', 'no-store')
  list(@Query() query: QueryParams): Promise<unknown> {
    return this.publications.listPublic(query);
  }

  @ApiOperation({
    summary: 'Read one public shader',
    description: 'Hidden, unpublished and unknown ids are all the same 404.',
  })
  @ApiErrors(404)
  @Public()
  @Get('publications/:id')
  @Header('Cache-Control', 'no-store')
  async read(@Param('id') id: string): Promise<unknown> {
    return { publication: await this.publications.readPublic(id) };
  }

  @ApiOperation({ summary: 'Download a public shader’s thumbnail' })
  @ApiErrors(404)
  @Public()
  @Get('publications/:id/thumbnail')
  async thumbnail(@Param('id') id: string, @Res() response: Response): Promise<void> {
    sendImage(response, await this.publications.readPublicAsset(id, THUMBNAIL_ASSET_KEY));
  }

  @ApiOperation({ summary: 'Download a public shader’s channel texture' })
  @ApiErrors(404)
  @Public()
  @Get('publications/:id/textures/:channel')
  async texture(
    @Param('id') id: string,
    @Param('channel') channel: string,
    @Res() response: Response,
  ): Promise<void> {
    sendImage(response, await this.publications.readPublicAsset(id, textureKey(channel)));
  }

  @ApiOperation({
    summary: 'Export a public shader',
    description:
      'A `shader-studio/v3` bundle with a `publication` block naming the author and license.',
  })
  @ApiErrors(404)
  @Public()
  @Get('publications/:id/export')
  async export(@Param('id') id: string, @Res() response: Response): Promise<void> {
    const { publication, shader } = await this.publications.exportPublic(id);
    const { shader: _snapshot, ...credits } = publication;
    const name = slugify(publication.title);
    response
      .setHeader('Cache-Control', 'no-store')
      .setHeader('Content-Disposition', `attachment; filename="${name}.shader.json"`)
      .json({ ...buildShaderBundle(shader), publication: credits });
  }

  // --- the owner ------------------------------------------------------------

  @ApiOperation({
    summary: 'Publication status of one of your shaders',
    description: 'Its publication if any, where it was copied from, and whether you may publish.',
  })
  @ApiErrors(404)
  @AllowUnverified()
  @Get('shaders/:id/publication')
  @Header('Cache-Control', 'no-store')
  status(@Param('id') id: string, @CurrentUser() principal: Principal): Promise<unknown> {
    return this.publications.status(principal.userId, id);
  }

  @ApiOperation({
    summary: 'Publish, update or republish a shader',
    description:
      'Freezes the saved shader at `expectedRevision` as its public snapshot. Body: ' +
      '`{ expectedRevision, authorLabel, license, attribution?, rightsConfirmed: true }`. ' +
      '201 on first publication, 200 after; the public id never changes.',
  })
  @ApiErrors(400, 403, 404, 409, 429)
  @Put('shaders/:id/publication')
  async publish(
    @Param('id') id: string,
    @Body() body: JsonBody,
    @Res() response: Response,
    @CurrentUser() principal: Principal,
  ): Promise<void> {
    this.throttle('publish', principal);
    const { publication, created } = await this.publications.publish(
      principal.userId,
      id,
      body ?? {},
    );
    this.logger.log(`published "${publication.id}" revision ${publication.revision}`);
    response.status(created ? 201 : 200).json({ publication });
  }

  @ApiOperation({
    summary: 'Unpublish a shader',
    description: 'Takes it out of Explore. The public id is kept for a later republish.',
  })
  @ApiErrors(404)
  @Delete('shaders/:id/publication')
  async unpublish(@Param('id') id: string, @CurrentUser() principal: Principal): Promise<unknown> {
    const publication = await this.publications.unpublish(principal.userId, id);
    this.logger.log(`unpublished "${publication.id}"`);
    return { publication };
  }

  // --- any verified account -------------------------------------------------

  @ApiOperation({
    summary: 'Copy a public shader into your library',
    description: 'Always a new private shader; the source and its license are recorded on it.',
  })
  @ApiErrors(404, 429)
  @Post('publications/:id/copy')
  async copy(
    @Param('id') id: string,
    @Res() response: Response,
    @CurrentUser() principal: Principal,
  ): Promise<void> {
    this.throttle('copy', principal);
    const shader = await this.publications.copy(principal.userId, id);
    response.status(201).json({ shader });
  }

  @ApiOperation({
    summary: 'Report a public shader',
    description:
      'Body: `{ reason, body? }`. One open report per account and publication (409 otherwise).',
  })
  @ApiErrors(400, 404, 409, 429)
  @Post('publications/:id/reports')
  async report(
    @Param('id') id: string,
    @Body() body: JsonBody,
    @Res() response: Response,
    @CurrentUser() principal: Principal,
  ): Promise<void> {
    this.throttle('report', principal);
    const report = await this.publications.report(principal.userId, id, body ?? {});
    response.status(201).json({ report });
  }
}
