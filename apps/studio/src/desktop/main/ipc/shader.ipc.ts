import { defineIpcModule, handle } from 'electron-ipc-module';
import { z } from 'zod';

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

/** A plain object whose fields the library checks itself. */
const body = <T>() =>
  z.custom<T>(
    (value) => !!value && typeof value === 'object' && !Array.isArray(value),
    'must be an object',
  );
const id = z.string();
const bytes = z.instanceof(Uint8Array);

const SHADERTOY_TIMEOUT_MS = 15_000;

/** Node's fetch with a per-request deadline; the Shadertoy fetchers pick everything else. */
const shadertoyFetch = (url: string, init?: { redirect?: 'manual' }) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(SHADERTOY_TIMEOUT_MS) });

export function createShaderIpc(storage: ShaderLibrary) {
  return defineIpcModule(
    'shader',
    {
      list: handle(() => storage.list()),
      read: handle((_event, id: string) => storage.read(id)),
      create: handle((_event, input: { name: string; description?: string }) =>
        storage.create({ name: input.name, description: input.description }),
      ),
      update: handle((_event, id: string, patch: UpdateShaderPatch) => storage.update(id, patch)),
      duplicate: handle((_event, id: string, name?: string) => storage.duplicate(id, name)),
      remove: handle(async (_event, id: string) => storage.remove(id)),
      'save-preset': handle(
        (
          _event,
          id: string,
          input: { name: string; values: ShaderParams; render?: RenderSettings },
        ) => storage.savePreset(id, input),
      ),
      'delete-preset': handle((_event, id: string, presetId: string) =>
        storage.deletePreset(id, presetId),
      ),
      'list-history': handle(
        (_event, id: string): Promise<ShaderHistoryEntry[]> => storage.listHistory(id),
      ),
      /** `name: null` clears the checkpoint; the shader revision does not move. */
      'set-checkpoint': handle(
        (_event, id: string, revision: number, name: string | null): Promise<ShaderHistoryEntry> =>
          storage.setCheckpoint(id, revision, name),
      ),
      /** Restores into a new head; `expectedRevision` is the head the caller last read. */
      'restore-history': handle(
        (_event, id: string, revision: number, expectedRevision: number): Promise<ShaderRecord> =>
          storage.restoreHistory(id, revision, expectedRevision),
      ),
      'export-shader': handle(async (_event, id: string) =>
        buildShaderBundle(await storage.exportOne(id)),
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
        const { payload, warnings } = await importShadertoyShader(idOrUrl, apiKey, {
          fetch: shadertoyFetch,
        });
        return { bundle: buildShaderBundle(payload), warnings };
      }),
      /**
       * The installed Shadertoy plugin's `shadertoy-api/v1` provider: the JSON
       * document only, bounded. The key is used for this one request; it is not
       * kept, logged or returned.
       */
      'fetch-shadertoy-source': handle(async (_event, idOrUrl: string, apiKey: string) =>
        fetchShadertoySource(idOrUrl, apiKey, { fetch: shadertoyFetch }),
      ),
      /** One Shadertoy media file by path; anything else is refused before a request. */
      'fetch-shadertoy-asset': handle(async (_event, path: string) =>
        fetchShadertoyAsset(path, { fetch: shadertoyFetch }),
      ),
      'set-texture': handle(
        (
          _event,
          id: string,
          channel: number,
          input: { ext: string; bytes: Uint8Array; width: number; height: number },
        ) => storage.setTexture(id, channel, { ...input, bytes: Buffer.from(input.bytes) }),
      ),
      'clear-texture': handle((_event, id: string, channel: number) =>
        storage.clearTexture(id, channel),
      ),
      'read-texture': handle(async (_event, id: string, channel: number) => {
        const texture = await storage.readTexture(id, channel);
        return texture ? { bytes: new Uint8Array(texture.bytes), ext: texture.ext } : null;
      }),
      'set-thumbnail': handle((_event, id: string, input: { ext: string; bytes: Uint8Array }) =>
        storage.setThumbnail(id, { ext: input.ext, bytes: Buffer.from(input.bytes) }),
      ),
      'read-thumbnail': handle(async (_event, id: string) => {
        const thumbnail = await storage.readThumbnail(id);
        return thumbnail ? { bytes: new Uint8Array(thumbnail.bytes), ext: thumbnail.ext } : null;
      }),
    },
    {
      // Ids and strings are checked here; the library validates every field it stores.
      validate: {
        read: z.tuple([id]),
        create: z.tuple([body<{ name: string; description?: string }>()]),
        update: z.tuple([id, body<UpdateShaderPatch>()]),
        duplicate: z.tuple([id, z.string().optional()]),
        remove: z.tuple([id]),
        'save-preset': z.tuple([
          id,
          body<{ name: string; values: ShaderParams; render?: RenderSettings }>(),
        ]),
        'delete-preset': z.tuple([id, id]),
        'list-history': z.tuple([id]),
        'set-checkpoint': z.tuple([id, z.number(), z.string().nullable()]),
        'restore-history': z.tuple([id, z.number(), z.number()]),
        'export-shader': z.tuple([id]),
        'import-shadertoy': z.tuple([z.string(), z.string()]),
        'fetch-shadertoy-source': z.tuple([z.string(), z.string()]),
        'fetch-shadertoy-asset': z.tuple([z.string()]),
        'set-texture': z.tuple([
          id,
          z.number(),
          z.object({ ext: z.string(), bytes, width: z.number(), height: z.number() }),
        ]),
        'clear-texture': z.tuple([id, z.number()]),
        'read-texture': z.tuple([id, z.number()]),
        'set-thumbnail': z.tuple([id, z.object({ ext: z.string(), bytes })]),
        'read-thumbnail': z.tuple([id]),
      },
    },
  );
}
