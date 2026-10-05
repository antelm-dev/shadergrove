import { Controller, Get, Header, Inject, Param, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { StorageError } from '@shadergrove/backend/library';
import type { ReleaseChannel } from '@shadergrove/shared/model';

import { Public } from '../core/auth.guard';
import { RELEASE_VERSION, ReleaseNotFound, ReleasesService } from './releases.service';

@ApiTags('releases')
@Public()
@Controller('releases')
export class ReleasesController {
  constructor(@Inject(ReleasesService) private readonly releases: ReleasesService) {}

  @Get()
  @Header('Access-Control-Allow-Origin', '*')
  @ApiOperation({ summary: 'List published desktop releases and release notes' })
  list(
    @Query('channel') channel: unknown,
    @Query('page') page: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const channelValue = this.channel(channel);
    const pageValue = page === undefined ? '1' : page;
    if (
      typeof pageValue !== 'string' ||
      !/^[1-9]\d{0,2}$/.test(pageValue) ||
      Number(pageValue) > 100
    ) {
      throw new StorageError('invalid', 'Page must be an integer between 1 and 100');
    }
    return this.respond(response, () => this.releases.list(channelValue, Number(pageValue)));
  }

  @Get('latest')
  @Header('Access-Control-Allow-Origin', '*')
  @ApiOperation({ summary: 'Read the latest stable or beta desktop release' })
  latest(@Query('channel') channel: unknown, @Res({ passthrough: true }) response: Response) {
    const channelValue = this.channel(channel);
    return this.respond(response, async () => ({
      release: await this.releases.latest(channelValue),
    }));
  }

  @Get(':version')
  @Header('Access-Control-Allow-Origin', '*')
  @ApiOperation({ summary: 'Read a published release and its downloads' })
  version(@Param('version') version: string, @Res({ passthrough: true }) response: Response) {
    if (!RELEASE_VERSION.test(version))
      throw new StorageError('invalid', 'Invalid release version');
    return this.respond(response, () => this.releases.version(version));
  }

  private channel(value: unknown): ReleaseChannel {
    if (value === undefined || value === 'stable') return 'stable';
    if (value === 'beta') return 'beta';
    throw new StorageError('invalid', 'Channel must be stable or beta');
  }

  private async respond<T>(response: Response, read: () => Promise<T>) {
    response.setHeader('Access-Control-Allow-Origin', '*');
    try {
      const result = await read();
      response.setHeader('Cache-Control', 'public, max-age=60');
      return result;
    } catch (error) {
      response.setHeader('Cache-Control', 'no-store');
      if (error instanceof ReleaseNotFound)
        throw new StorageError('not_found', 'Release not found');
      response.status(503);
      return {
        error: { code: 'internal', message: 'Release information is temporarily unavailable' },
      };
    }
  }
}
