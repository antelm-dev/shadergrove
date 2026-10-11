import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { ShaderRecord } from '@shadergrove/shared/model';
import {
  DEFAULT_PUBLICATION_SORT,
  type ExploreCapabilities,
  type OwnerPublication,
  type PublicationDetail,
  type PublicationPage,
  type PublicationSort,
  type PublishRequest,
  type ReportRequest,
  type ShaderPublicationStatus,
} from '@shadergrove/shared/publication';
import { API_BASE_URL } from '../api/api-base-url';
import { apiRequest } from '../api/shader-api';

/**
 * The public Explore endpoints — see `docs/public-explore-api.md`.
 *
 * Web only: the desktop app has no `HttpClient` and no Explore, so nothing may
 * inject this there (the routes and entry points are gated before they do).
 */
@Injectable({ providedIn: 'root' })
export class PublicationApi {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);

  private url(path: string): string {
    return `${this.baseUrl}/api${path}`;
  }

  capabilities(): Promise<ExploreCapabilities> {
    return apiRequest(
      firstValueFrom(this.http.get<ExploreCapabilities>(this.url('/capabilities'))),
    );
  }

  /** `cursor` is opaque and only valid with the `search` and `sort` that produced it. */
  list(
    search: string,
    cursor: string | null,
    sort: PublicationSort = DEFAULT_PUBLICATION_SORT,
  ): Promise<PublicationPage> {
    const params = {
      ...(search ? { search } : {}),
      ...(sort === DEFAULT_PUBLICATION_SORT ? {} : { sort }),
      ...(cursor ? { cursor } : {}),
    };
    return apiRequest(
      firstValueFrom(this.http.get<PublicationPage>(this.url('/publications'), { params })),
    );
  }

  async read(id: string): Promise<PublicationDetail> {
    const path = `/publications/${encodeURIComponent(id)}`;
    const response = await apiRequest(
      firstValueFrom(this.http.get<{ publication: PublicationDetail }>(this.url(path))),
    );
    return response.publication;
  }

  // The three below are for the browser to fetch by itself (`<img>`, the texture
  // loader, a download link), so they are always relative: the absolute origin
  // `API_BASE_URL` carries during SSR would render a different `src` on the
  // server than in the browser.

  /** Revision-stamped, so an updated snapshot is a different URL to whatever cached the old one. */
  thumbnailUrl(publication: { id: string; revision: number }): string {
    return `/api/publications/${publication.id}/thumbnail?v=${publication.revision}`;
  }

  textureUrl(publication: { id: string; revision: number }, channel: number): string {
    return `/api/publications/${publication.id}/textures/${channel}?v=${publication.revision}`;
  }

  exportUrl(id: string): string {
    return `/api/publications/${id}/export`;
  }

  async copy(id: string): Promise<ShaderRecord> {
    const response = await apiRequest(
      firstValueFrom(
        this.http.post<{ shader: ShaderRecord }>(this.url(`/publications/${id}/copy`), {}),
      ),
    );
    return response.shader;
  }

  async report(id: string, request: ReportRequest): Promise<void> {
    await apiRequest(
      firstValueFrom(this.http.post(this.url(`/publications/${id}/reports`), request)),
    );
  }

  status(shaderId: string): Promise<ShaderPublicationStatus> {
    return apiRequest(
      firstValueFrom(
        this.http.get<ShaderPublicationStatus>(this.url(`/shaders/${shaderId}/publication`)),
      ),
    );
  }

  async publish(shaderId: string, request: PublishRequest): Promise<OwnerPublication> {
    const response = await apiRequest(
      firstValueFrom(
        this.http.put<{ publication: OwnerPublication }>(
          this.url(`/shaders/${shaderId}/publication`),
          request,
        ),
      ),
    );
    return response.publication;
  }

  async unpublish(shaderId: string): Promise<OwnerPublication> {
    const response = await apiRequest(
      firstValueFrom(
        this.http.delete<{ publication: OwnerPublication }>(
          this.url(`/shaders/${shaderId}/publication`),
        ),
      ),
    );
    return response.publication;
  }
}
