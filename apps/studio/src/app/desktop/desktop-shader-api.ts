import { Injectable } from '@angular/core';

import type {
  Bundle,
  ImportMode,
  ImportResult,
  Preset,
  RenderSettings,
  ShaderHistoryEntry,
  ShaderParams,
  ShaderRecord,
  ShaderSummary,
} from '@shadergrove/shared/model';
import {
  ApiError,
  ShaderApi,
  type TextureUpload,
  type ThumbnailUpload,
  type UpdateShaderPatch,
} from '../api/shader-api';

function messageOf(error: unknown): string {
  if (error instanceof Error)
    return error.message.replace(/^Error invoking remote method '[^']+':\s*/, '');
  return String(error);
}

@Injectable()
export class DesktopShaderApi extends ShaderApi {
  private request<T>(work: () => Promise<T>): Promise<T> {
    return work().catch((error: unknown) => {
      throw new ApiError(messageOf(error));
    });
  }

  override list(): Promise<ShaderSummary[]> {
    return this.request(() => window.electron.bridge.shader.list());
  }

  override read(id: string): Promise<ShaderRecord> {
    return this.request(() => window.electron.bridge.shader.read(id));
  }

  override create(name: string, description = ''): Promise<ShaderRecord> {
    return this.request(() => window.electron.bridge.shader.create({ name, description }));
  }

  override update(id: string, patch: UpdateShaderPatch): Promise<ShaderRecord> {
    return this.request(() => window.electron.bridge.shader.update(id, patch));
  }

  override duplicate(id: string, name?: string): Promise<ShaderRecord> {
    return this.request(() => window.electron.bridge.shader.duplicate(id, name));
  }

  override remove(id: string): Promise<void> {
    return this.request(() => window.electron.bridge.shader.remove(id));
  }

  override savePreset(
    id: string,
    name: string,
    values: ShaderParams,
    render?: RenderSettings,
  ): Promise<Preset> {
    return this.request(() =>
      window.electron.bridge.shader.savePreset(id, {
        name,
        values,
        ...(render ? { render } : {}),
      }),
    );
  }

  override deletePreset(id: string, presetId: string): Promise<void> {
    return this.request(() => window.electron.bridge.shader.deletePreset(id, presetId));
  }

  override listHistory(id: string): Promise<ShaderHistoryEntry[]> {
    return this.request(() => window.electron.bridge.shader.listHistory(id));
  }

  override setCheckpoint(
    id: string,
    revision: number,
    name: string | null,
  ): Promise<ShaderHistoryEntry> {
    return this.request(() => window.electron.bridge.shader.setCheckpoint(id, revision, name));
  }

  override restoreHistory(
    id: string,
    revision: number,
    expectedRevision: number,
  ): Promise<ShaderRecord> {
    return this.request(() =>
      window.electron.bridge.shader.restoreHistory(id, revision, expectedRevision),
    );
  }

  override exportShader(id: string): Promise<Bundle> {
    return this.request(() => window.electron.bridge.shader.exportShader(id));
  }

  override exportAll(): Promise<Bundle> {
    return this.request(() => window.electron.bridge.shader.exportAll());
  }

  override importBundle(bundle: unknown, mode: ImportMode): Promise<ImportResult> {
    return this.request(() => window.electron.bridge.shader.importBundle(bundle, mode));
  }

  // IPC cannot be cancelled; an abort stops the caller waiting and the reply is dropped.
  override fetchShadertoySource(
    idOrUrl: string,
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<{ sourceId: string; source: unknown }> {
    return untilAborted(
      this.request(() => window.electron.bridge.shader.fetchShadertoySource(idOrUrl, apiKey)),
      signal,
    );
  }

  override async fetchShadertoyAsset(path: string, signal?: AbortSignal): Promise<Uint8Array> {
    const bytes = await untilAborted(
      this.request(() => window.electron.bridge.shader.fetchShadertoyAsset(path)),
      signal,
    );
    return new Uint8Array(bytes);
  }

  override setTexture(id: string, channel: number, upload: TextureUpload): Promise<ShaderRecord> {
    return this.request(() => window.electron.bridge.shader.setTexture(id, channel, upload));
  }

  override clearTexture(id: string, channel: number): Promise<ShaderRecord> {
    return this.request(() => window.electron.bridge.shader.clearTexture(id, channel));
  }

  override setThumbnail(id: string, upload: ThumbnailUpload): Promise<ShaderRecord> {
    return this.request(() => window.electron.bridge.shader.setThumbnail(id, upload));
  }
}

function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
