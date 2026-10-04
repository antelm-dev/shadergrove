import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLUGIN_LIMITS } from '@shadergrove/shared';
import { createPluginBootstrapFile, createPluginFiles, createPluginsIpc } from './plugins.ipc';

// The real module registers on Electron's ipcMain; here a module is just its handlers.
vi.mock('electron-ipc-module', () => ({
  defineIpcModule: (_name: string, handlers: unknown) => handlers,
  handle: (fn: unknown) => fn,
}));

function packageText(id: string, version = '1.0.0'): string {
  return JSON.stringify({
    manifest: {
      id,
      version,
      protocolVersion: 1,
      appVersionRange: '>=1.0.0',
      name: 'Tint',
      publisher: 'Example',
      license: 'MIT',
      contributions: [{ kind: 'effect', id: 'tint', name: 'Tint', controls: [] }],
    },
    glsl: { tint: 'vec4 effect(vec4 c, vec2 uv) { return c; }' },
  });
}

const record = (text: string, enabled = false) => ({
  id: JSON.parse(text).manifest?.id ?? 'unknown',
  text,
  enabled,
  installedAt: '2026-10-01T00:00:00.000Z',
});

describe('plugin files', () => {
  let dir: string;
  let files: ReturnType<typeof createPluginFiles>;

  beforeEach(async () => {
    dir = join(await mkdtemp(join(tmpdir(), 'sg-plugins-')), 'plugins');
    files = createPluginFiles(dir);
  });

  afterEach(async () => {
    await rm(join(dir, '..'), { recursive: true, force: true });
  });

  it('starts empty, then lists what was put, keyed by the id inside the package', async () => {
    expect(await files.list()).toEqual([]);

    expect(await files.put(record(packageText('dev.example.tint')))).toBe('dev.example.tint');
    expect(await files.list()).toEqual([record(packageText('dev.example.tint'))]);
  });

  it('replaces a package with a newer file of the same id, and removes it', async () => {
    await files.put(record(packageText('dev.example.tint', '1.0.0')));
    await files.put(record(packageText('dev.example.tint', '1.1.0'), true));

    const [stored] = await files.list();
    expect(JSON.parse(stored!.text).manifest.version).toBe('1.1.0');
    expect(stored!.enabled).toBe(true);

    await files.remove('dev.example.tint');
    expect(await files.list()).toEqual([]);
  });

  it('names files by a hash, never by anything the package or the renderer chose', async () => {
    // `con` is a Windows device name; `..` style ids cannot pass the manifest pattern.
    await files.put(record(packageText('con')));
    const names = await readdir(dir);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^[0-9a-f]{32}\.json$/);
  });

  it('refuses a package that does not validate, and writes nothing', async () => {
    await expect(files.put(record('{"manifest":{}}'))).rejects.toThrow(/Invalid plugin package/);
    await expect(
      files.put({ ...record(packageText('dev.example.tint')), id: 'something.else' }),
    ).rejects.toThrow(/does not match/);
    await expect(files.put({ text: 42 } as never)).rejects.toThrow(/Not a plugin record/);
    expect(await readdir(dir).catch(() => [])).toEqual([]);
  });

  it('skips files it does not recognise or cannot read, rather than failing the list', async () => {
    await files.put(record(packageText('dev.example.tint')));
    await writeFile(join(dir, `${'a'.repeat(32)}.json`), '{ not json');
    await writeFile(join(dir, 'notes.txt'), 'hello');

    expect(await files.list()).toHaveLength(1);
  });

  it('does not read a file larger than any record it could have written', async () => {
    await files.put(record(packageText('dev.example.tint')));
    const [name] = await readdir(dir);
    const text = await readFile(join(dir, name!), 'utf8');
    await writeFile(join(dir, name!), text + ' '.repeat(PLUGIN_LIMITS.packageBytes * 6 + 4096));

    expect(await files.list()).toEqual([]);
  });

  it('skips a record whose id is not the one its file is named after, so removing it cannot hit another file', async () => {
    await files.put(record(packageText('dev.example.a')));
    await files.put(record(packageText('dev.example.b')));
    const [first] = await readdir(dir);
    const stored = JSON.parse(await readFile(join(dir, first!), 'utf8'));
    const other = stored.id === 'dev.example.a' ? 'dev.example.b' : 'dev.example.a';
    await writeFile(join(dir, first!), JSON.stringify({ ...stored, id: other }));

    expect((await files.list()).map((item) => item.id)).toEqual([other]);
  });
});

describe('the plugins IPC module', () => {
  it('answers the main window only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sg-plugins-ipc-'));
    const main = { id: 1 };
    const output = { id: 2 };
    const handlers = createPluginsIpc(
      dir,
      join(dir, 'bootstrap.json'),
      (sender) => sender === (main as never),
    ) as unknown as {
      list: (event: { sender: unknown }) => Promise<unknown>;
      put: (event: { sender: unknown }, record: unknown) => Promise<unknown>;
      remove: (event: { sender: unknown }, id: string) => Promise<unknown>;
      bootstrap: (event: { sender: unknown }) => Promise<unknown>;
      saveBootstrap: (event: { sender: unknown }, state: unknown) => Promise<unknown>;
    };
    try {
      await expect(handlers.list({ sender: main })).resolves.toEqual([]);
      await expect(handlers.list({ sender: output })).rejects.toThrow(/main window/);
      await expect(
        handlers.put({ sender: output }, record(packageText('dev.example.tint'))),
      ).rejects.toThrow(/main window/);
      await expect(handlers.remove({ sender: output }, 'dev.example.tint')).rejects.toThrow(
        /main window/,
      );
      await expect(handlers.bootstrap({ sender: output })).rejects.toThrow(/main window/);
      await expect(
        handlers.saveBootstrap({ sender: output }, { version: 1, packages: {} }),
      ).rejects.toThrow(/main window/);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the plugin bootstrap file', () => {
  let dir: string;
  let file: ReturnType<typeof createPluginBootstrapFile>;
  const path = () => join(dir, 'plugin-bootstrap.json');

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sg-plugin-bootstrap-'));
    file = createPluginBootstrapFile(path());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads as empty until written, then reads back what was written', async () => {
    expect(await file.read()).toEqual({ version: 0, packages: {} });
    const state = {
      version: 1,
      packages: {
        'dev.shadergrove.default-themes': 'seeded',
        'dev.shadergrove.language-fr': 'removed',
      },
    } as const;
    await file.write(state);
    expect(await file.read()).toEqual(state);
    // Written whole through a renamed temporary file: nothing else is left behind.
    expect(await readdir(dir)).toEqual(['plugin-bootstrap.json']);
  });

  it('keeps only well-formed entries for default packages, and survives a damaged file', async () => {
    await writeFile(
      path(),
      JSON.stringify({
        version: 1,
        packages: {
          'dev.shadergrove.language-en': 'seeded',
          'dev.example.other': 'seeded',
          'dev.shadergrove.language-fr': 'enabled',
        },
      }),
    );
    expect(await file.read()).toEqual({
      version: 1,
      packages: { 'dev.shadergrove.language-en': 'seeded' },
    });
    await writeFile(path(), '{ not json');
    expect(await file.read()).toEqual({ version: 0, packages: {} });
    await writeFile(path(), 'x'.repeat(64 * 1024));
    expect(await file.read()).toEqual({ version: 0, packages: {} });
  });
});
