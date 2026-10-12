import { describe, expect, it, vi } from 'vitest';

import type { ShaderLibrary } from '@shadergrove/backend/library';
import { createShaderIpc } from './shader.ipc';
import { createSyncIpc } from './sync.ipc';
import type { SyncService } from '../sync/sync-service';

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, ipcMain: {} }));

type Channel = (event: unknown, ...args: unknown[]) => Promise<unknown>;

/** Registers a module on a fake ipcMain and returns a caller for its channels. */
async function register(module: (ipc: never) => Promise<unknown> | unknown) {
  const channels = new Map<string, Channel>();
  await module({
    handle: (channel: string, fn: Channel) => channels.set(channel, fn),
    removeHandler: () => undefined,
  } as never);
  return (channel: string, ...args: unknown[]) =>
    channels.get(channel)!({ sender: { id: 1 } }, ...args);
}

describe('IPC payload validation', () => {
  it('refuses malformed shader payloads before they reach the library', async () => {
    const storage = { read: vi.fn(async () => ({})), setTexture: vi.fn(async () => ({})) };
    const call = await register(createShaderIpc(storage as unknown as ShaderLibrary));

    await expect(call('shader:read', 42)).rejects.toThrow(/failed validation/);
    await expect(
      call('shader:set-texture', 'a', 0, { ext: 'png', bytes: [1, 2], width: 1, height: 1 }),
    ).rejects.toThrow(/failed validation/);
    await expect(call('shader:update', 'a', ['not', 'an', 'object'])).rejects.toThrow(
      /failed validation/,
    );
    expect(storage.read).not.toHaveBeenCalled();
    expect(storage.setTexture).not.toHaveBeenCalled();

    await call('shader:read', 'a');
    expect(storage.read).toHaveBeenCalledWith('a');
    const bytes = new Uint8Array([1, 2]);
    await call('shader:set-texture', 'a', 0, { ext: 'png', bytes, width: 1, height: 1, extra: 1 });
    expect(storage.setTexture).toHaveBeenCalledWith('a', 0, {
      ext: 'png',
      bytes: Buffer.from(bytes),
      width: 1,
      height: 1,
    });
  });

  it('refuses malformed sync requests', async () => {
    const sync = { upload: vi.fn(async () => undefined), remove: vi.fn(async () => 'ok') };
    const call = await register(createSyncIpc(sync as unknown as SyncService));

    await expect(call('sync:upload', ['a', 1])).rejects.toThrow(/failed validation/);
    await expect(
      call('sync:remove', { id: 'a', mode: 'nowhere', userId: 'u', revision: 1 }),
    ).rejects.toThrow(/failed validation/);
    await expect(
      call('sync:remove', { id: 'a', mode: 'local', userId: 'u', revision: 1.5 }),
    ).rejects.toThrow(/failed validation/);
    expect(sync.upload).not.toHaveBeenCalled();
    expect(sync.remove).not.toHaveBeenCalled();

    await call('sync:remove', { id: 'a', mode: 'local', userId: 'u', revision: 1 });
    expect(sync.remove).toHaveBeenCalledWith({ id: 'a', mode: 'local', userId: 'u', revision: 1 });
  });
});
