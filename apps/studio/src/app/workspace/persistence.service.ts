import { Injectable, inject } from '@angular/core';

import type {
  ShaderControl,
  ShaderParams,
  ShaderRecord,
  ThumbnailMeta,
} from '@shadergrove/shared/model';
import { sanitizeParams } from '@shadergrove/shared/validate';
import { ShaderApi } from '../api/shader-api';
import { RendererHandle } from '../rendering/renderer-handle';
import { ThumbnailAssets } from '../assets/thumbnail-assets';
import { DraftRecovery } from './draft-recovery';
import { ProjectPersistence } from './project-persistence';
import { TextureAssets } from '../assets/texture-assets';
import { controlsToText } from './controls-text';
import type { ShaderDraft } from './shader-store';

export interface SaveResult {
  record: ShaderRecord;
  draft: ShaderDraft;
  params: ShaderParams;
}

/**
 * The save/collection half of `ShaderStore`: the API calls behind saving,
 * capturing a preview, and creating/duplicating/removing a shader, plus the
 * response-shaping that turns a saved record into the next draft and params.
 * `ShaderStore` still owns writing the result into its own signals, deciding
 * what to do when the *currently open* shader is the one removed, and
 * refreshing the list — this is the server/cache boundary underneath that.
 */
@Injectable({ providedIn: 'root' })
export class PersistenceService {
  private readonly api = inject(ShaderApi);
  private readonly renderer = inject(RendererHandle);
  private readonly thumbnails = inject(ThumbnailAssets);
  private readonly recovery = inject(DraftRecovery);
  private readonly projects = inject(ProjectPersistence);
  private readonly textures = inject(TextureAssets);

  /**
   * The whole project goes to the server — buffers, Common, files, wiring
   * included. `fragment`/`vertex` are not sent alongside it: the server
   * derives its own mirrors from the project's Image pass source and vertex
   * shader, so sending both would just be two copies of the truth.
   */
  async save(
    recordId: string,
    draft: ShaderDraft,
    controls: ShaderControl[],
    currentParams: ShaderParams,
    expectedRevision?: number,
  ): Promise<SaveResult> {
    const saved = await this.api.update(recordId, {
      project: draft.project,
      controls,
      render: draft.render,
      // Optimistic concurrency: refuse the write if the shader moved on since it
      // was read. Omitted callers keep last-writer-wins.
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    });

    const project = structuredClone(draft.project);
    return {
      record: saved,
      draft: {
        project,
        controlsText: controlsToText(saved.controls),
        render: structuredClone(saved.render),
      },
      params: sanitizeParams(saved.controls, currentParams),
    };
  }

  /**
   * Photographs the shader that was just saved, so the library can show it
   * without opening it. Best-effort: with no renderer — SSR, a test — or on
   * any capture/upload failure, there is simply no thumbnail to return.
   */
  async capturePreview(id: string): Promise<ThumbnailMeta | null> {
    const upload = await this.renderer.captureThumbnail();
    if (!upload) return null;

    const { thumbnail } = await this.api.setThumbnail(id, upload);
    this.thumbnails.releaseShader(id);
    return thumbnail;
  }

  create(name: string): Promise<ShaderRecord> {
    return this.api.create(name);
  }

  duplicate(id: string, name?: string): Promise<ShaderRecord> {
    return this.api.duplicate(id, name);
  }

  rename(id: string, name: string): Promise<ShaderRecord> {
    return this.api.update(id, { name });
  }

  /** Copies a history entry into a new head, refused unless `expectedRevision` is still the head. */
  restoreHistory(id: string, revision: number, expectedRevision: number): Promise<ShaderRecord> {
    return this.api.restoreHistory(id, revision, expectedRevision);
  }

  /** `removeRecord` deletes it another way (account sync); false when it deleted nothing. */
  async remove(id: string, removeRecord?: () => Promise<boolean>): Promise<boolean> {
    if (!removeRecord) await this.api.remove(id);
    else if (!(await removeRecord())) return false;
    this.recovery.remove(id);
    this.projects.remove(id);
    this.textures.releaseShader(id);
    this.thumbnails.releaseShader(id);
    return true;
  }
}
