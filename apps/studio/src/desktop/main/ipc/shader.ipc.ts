import { defineIpcModule, handle } from 'electron-ipc-module';

import {
  fetchShadertoyAsset,
  fetchShadertoySource,
  importShadertoyShader,
} from '@shadergrove/shared/shadertoy-api';
import type { UpdateShaderPatch } from '@shadergrove/shared/api';
import { ShaderLibrary, StorageError } from '@shadergrove/backend/library';
import type {
  ImportMode,
  RenderSettings,
  ShaderHistoryEntry,
  ShaderParams,
  ShaderRecord,
} from '@shadergrove/shared/model';
import {
  buildCollectionBundle,
  buildShaderBundle,
  parseBundle,
  validateImportMode,
} from '@shadergrove/shared/validate';

function stringArg(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new StorageError('invalid', `${name} must be a string`);
  return value;
}

function objectArg(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StorageError('invalid', `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

const SHADERTOY_TIMEOUT_MS = 15_000;

/** Node's fetch with a per-request deadline; the Shadertoy fetchers pick everything else. */
const shadertoyFetch = (url: string, init?: { redirect?: 'manual' }) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(SHADERTOY_TIMEOUT_MS) });

export function createShaderIpc(storage: ShaderLibrary) {
  return defineIpcModule('shader', {
    list: handle(() => storage.list()),
    read: handle((_event, id: string) => storage.read(stringArg(id, 'id'))),
    create: handle((_event, input: { name: string; description?: string }) => {
      const body = objectArg(input, 'input');
      return storage.create({ name: body['name'], description: body['description'] });
    }),
    update: handle((_event, id: string, patch: UpdateShaderPatch) => {
      const body = objectArg(patch, 'patch');
      return storage.update(stringArg(id, 'id'), body as UpdateShaderPatch);
    }),
    duplicate: handle((_event, id: string, name?: string) =>
      storage.duplicate(stringArg(id, 'id'), name),
    ),
    remove: handle(async (_event, id: string) => storage.remove(stringArg(id, 'id'))),
    'save-preset': handle(
      (
        _event,
        id: string,
        input: { name: string; values: ShaderParams; render?: RenderSettings },
      ) =>
        storage.savePreset(
          stringArg(id, 'id'),
          objectArg(input, 'preset') as { name: unknown; values: unknown; render?: unknown },
        ),
    ),
    'delete-preset': handle((_event, id: string, presetId: string) =>
      storage.deletePreset(stringArg(id, 'id'), stringArg(presetId, 'presetId')),
    ),
    'list-history': handle(
      (_event, id: string): Promise<ShaderHistoryEntry[]> =>
        storage.listHistory(stringArg(id, 'id')),
    ),
    /** `name: null` clears the checkpoint; the shader revision does not move. */
    'set-checkpoint': handle(
      (_event, id: string, revision: number, name: string | null): Promise<ShaderHistoryEntry> =>
        storage.setCheckpoint(stringArg(id, 'id'), revision, name),
    ),
    /** Restores into a new head; `expectedRevision` is the head the caller last read. */
    'restore-history': handle(
      (_event, id: string, revision: number, expectedRevision: number): Promise<ShaderRecord> =>
        storage.restoreHistory(stringArg(id, 'id'), revision, expectedRevision),
    ),
    'export-shader': handle(async (_event, id: string) =>
      buildShaderBundle(await storage.exportOne(stringArg(id, 'id'))),
    ),
    'export-all': handle(async () => buildCollectionBundle(await storage.exportAll())),
    'import-bundle': handle(async (_event, bundle: unknown, mode: ImportMode) => {
      const parsedMode = validateImportMode(mode);
      if (!parsedMode.ok)
        throw new StorageError('invalid', 'Invalid import mode', parsedMode.errors);
      const parsed = parseBundle(bundle);
      if (!parsed.ok)
        throw new StorageError('invalid', 'The bundle could not be imported', parsed.errors);
      return storage.importPayloads(parsed.value, parsedMode.value);
    }),
    'import-shadertoy': handle(async (_event, idOrUrl: string, apiKey: string) => {
      const { payload, warnings } = await importShadertoyShader(
        stringArg(idOrUrl, 'idOrUrl'),
        stringArg(apiKey, 'apiKey'),
        { fetch: shadertoyFetch },
      );
      return { bundle: buildShaderBundle(payload), warnings };
    }),
    /**
     * The installed Shadertoy plugin's `shadertoy-api/v1` provider: the JSON
     * document only, bounded. The key is used for this one request; it is not
     * kept, logged or returned.
     */
    'fetch-shadertoy-source': handle(async (_event, idOrUrl: string, apiKey: string) =>
      fetchShadertoySource(stringArg(idOrUrl, 'idOrUrl'), stringArg(apiKey, 'apiKey'), {
        fetch: shadertoyFetch,
      }),
    ),
    /** One Shadertoy media file by path; anything else is refused before a request. */
    'fetch-shadertoy-asset': handle(async (_event, path: string) =>
      fetchShadertoyAsset(stringArg(path, 'path'), { fetch: shadertoyFetch }),
    ),
    'set-texture': handle(
      (
        _event,
        id: string,
        channel: number,
        input: { ext: string; bytes: Uint8Array; width: number; height: number },
      ) => {
        const body = objectArg(input, 'input');
        return storage.setTexture(stringArg(id, 'id'), channel, {
          ext: stringArg(body['ext'], 'ext'),
          bytes: Buffer.from(body['bytes'] as Uint8Array),
          width: body['width'] as number,
          height: body['height'] as number,
        });
      },
    ),
    'clear-texture': handle((_event, id: string, channel: number) =>
      storage.clearTexture(stringArg(id, 'id'), channel),
    ),
    'read-texture': handle(async (_event, id: string, channel: number) => {
      const texture = await storage.readTexture(stringArg(id, 'id'), channel);
      return texture ? { bytes: new Uint8Array(texture.bytes), ext: texture.ext } : null;
    }),
    'set-thumbnail': handle((_event, id: string, input: { ext: string; bytes: Uint8Array }) => {
      const body = objectArg(input, 'input');
      return storage.setThumbnail(stringArg(id, 'id'), {
        ext: stringArg(body['ext'], 'ext'),
        bytes: Buffer.from(body['bytes'] as Uint8Array),
      });
    }),
    'read-thumbnail': handle(async (_event, id: string) => {
      const thumbnail = await storage.readThumbnail(stringArg(id, 'id'));
      return thumbnail ? { bytes: new Uint8Array(thumbnail.bytes), ext: thumbnail.ext } : null;
    }),
  });
}
