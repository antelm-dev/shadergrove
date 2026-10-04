import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_CHANNELS,
  DEFAULT_RENDER,
  type ShaderControl,
  type ShaderParams,
} from '@shadergrove/shared/model';
import { migrateLegacyProject } from '@shadergrove/shared/project';
import { AuthService } from '../auth/auth.service';
import { DesktopPlatform } from '../desktop/desktop-platform';
import { I18n } from '../i18n/i18n';
import { WallpaperWebRuntime } from '../rendering/wallpaper-runtime';
import { WorkspaceActions } from '../ui/workspace-actions';
import { ShaderStore } from '../workspace/shader-store';
import { SOURCE_PROVIDERS, provideHostAdapters, type SourceProvider } from './host-adapters';
import { PluginHost } from './plugin-host';
import { PLUGIN_STORE, PluginInstallations } from './plugin-installations';
import type { StoredPlugin } from './plugin-store';
import { ProjectPluginActions } from './project-actions';
import { DesktopFolderWriter, type ProjectWriter } from './project-delivery';
import { inProcessStart } from './testing/in-process-sandbox';

/**
 * The Plugins tab's project workflow against the real installations, host,
 * packages and runtime — only the library, the dialogs and the network are
 * stand-ins. What matters here is lifecycle: nothing is adopted or written
 * once the context it started under has changed.
 */
const generated = resolve(import.meta.dirname, '../../plugins');
const SHADERTOY = 'dev.shadergrove.shadertoy';
const WALLPAPER = 'dev.shadergrove.wallpaper-engine';
/** A package's text as the release catalogue lists it. */
const text = (id: string) => {
  const catalogue = JSON.parse(readFileSync(resolve(generated, 'catalogue.json'), 'utf8')) as {
    packages: { id: string; file: string }[];
  };
  const entry = catalogue.packages.find((item) => item.id === id)!;
  return readFileSync(resolve(generated, entry.file), 'utf8');
};

const shadertoyJson = {
  Shader: {
    info: { id: 'abc', name: 'Seascape', username: 'TDM' },
    renderpass: [
      {
        type: 'image',
        code: 'void mainImage(out vec4 c, in vec2 p) { c = texture2D(iChannel0, p); }',
        inputs: [{ channel: 0, ctype: 'texture', src: '/media/a/x.png' }],
        outputs: [{ id: 37, channel: 0 }],
      },
    ],
  },
};

function deferred<T>() {
  let resolveIt!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolveIt = done));
  return { promise, resolve: resolveIt };
}

describe('ProjectPluginActions', () => {
  const user = signal<{ id: string } | null>(null);
  const status = signal<'loading' | 'anonymous' | 'authenticated'>('anonymous');
  const selectedId = signal<string | null>('waves');
  const params = signal<ShaderParams>({ speed: 7 });
  const controls = signal<ShaderControl[]>([
    { key: 'speed', type: 'number', default: 1, min: 0, max: 10 },
  ]);
  let records: Map<string, StoredPlugin>;
  let imported: unknown[];
  let written: { stem: string; paths: string[] }[];
  let transition: 'accept' | 'decline';
  let fetchSource: SourceProvider['fetchSource'];
  const sentToWorker: unknown[] = [];

  const provider: SourceProvider = {
    id: 'shadertoy-api/v1',
    fields: [],
    fetchSource: (values, signal) => fetchSource(values, signal),
    fetchAsset: async () => {
      throw new Error('request failed (404)');
    },
  };

  function setup(): { actions: ProjectPluginActions; installations: PluginInstallations } {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: PLUGIN_STORE,
          useValue: () => ({
            list: async () => [...records.values()],
            put: async (record: StoredPlugin) => void records.set(record.id, record),
            remove: async (id: string) => void records.delete(id),
            replace: async (record: StoredPlugin) =>
              records.has(record.id) ? (records.set(record.id, record), true) : false,
            readBootstrap: async () => null,
            writeBootstrap: async () => undefined,
          }),
        },
        { provide: AuthService, useValue: { user, status } },
        { provide: DesktopPlatform, useValue: { available: false } },
        { provide: I18n, useValue: { t: (key: string) => key } },
        {
          provide: WorkspaceActions,
          useValue: {
            guardedTransition: async (action: () => Promise<void>) => {
              if (transition === 'decline') return false;
              await action();
              return true;
            },
          },
        },
        {
          provide: ShaderStore,
          useValue: {
            selectedId,
            params,
            controls,
            record: () => ({ id: 'waves', name: 'Waves' }),
            draft: () => ({
              project: migrateLegacyProject('void main() {}', 'void main() {}'),
              render: DEFAULT_RENDER,
            }),
            exportShader: async () => ({ shader: { channels: structuredClone(DEFAULT_CHANNELS) } }),
            importProjectBundle: async (bundle: unknown) => {
              imported.push(bundle);
              return true;
            },
          },
        },
        { provide: SOURCE_PROVIDERS, useValue: provider, multi: true },
        provideHostAdapters({ exportRuntimes: [WallpaperWebRuntime] }),
      ],
    });
    const installations = TestBed.inject(PluginInstallations);
    // Plugin code runs in-process here; the real sandbox needs a browser Worker.
    vi.spyOn(installations, 'host').mockImplementation((id) => {
      const installed = installations.find(id);
      if (!installed?.active || !installed.plugin) return null;
      const start = inProcessStart(installed.plugin.code!);
      return new PluginHost(installed.plugin, {
        start: async () => {
          const inner = await start();
          return {
            call: (method, input, options) => {
              sentToWorker.push(structuredClone(input));
              return inner.call(method, input, options);
            },
            terminate: inner.terminate,
          };
        },
      });
    });
    const actions = TestBed.inject(ProjectPluginActions);
    actions.writer = (): ProjectWriter => ({
      write: async (output) => {
        written.push({ stem: output.stem, paths: output.files.map((file) => file.path) });
        return { status: 'written', where: `${output.stem}.zip` };
      },
    });
    return { actions, installations };
  }

  async function settle(): Promise<void> {
    TestBed.tick();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  async function installEnabled(installations: PluginInstallations, id: string): Promise<void> {
    const review = installations.review(new TextEncoder().encode(text(id)));
    if (!review.ok) throw new Error(review.errors.join());
    await installations.install(review);
    await installations.setEnabled(id, true);
  }

  beforeEach(() => {
    records = new Map();
    imported = [];
    written = [];
    transition = 'accept';
    sentToWorker.length = 0;
    selectedId.set('waves');
    user.set(null);
    status.set('anonymous');
    fetchSource = async () => ({ sourceId: 'abc', source: shadertoyJson });
  });

  afterEach(() => TestBed.resetTestingModule());

  it('offers only active contributions whose adapters exist, dispatched by metadata', async () => {
    const { actions, installations } = setup();
    await settle();
    await installEnabled(installations, SHADERTOY);
    expect(actions.importers().map(({ installed }) => installed.id)).toEqual([SHADERTOY]);
    expect(actions.exporters()).toEqual([]);
    await installations.setEnabled(SHADERTOY, false);
    expect(actions.importers()).toEqual([]);
  });

  it('imports through the provider and the Worker, keeping the key host-side', async () => {
    const { actions, installations } = setup();
    await settle();
    await installEnabled(installations, SHADERTOY);
    const outcome = await actions.runImport(SHADERTOY, 'shadertoy', {
      mode: 'provider',
      values: { idOrUrl: 'abc', apiKey: 'secret-key' },
    });
    expect(outcome).toMatchObject({ status: 'imported', name: 'Seascape' });
    expect(outcome.status === 'imported' && outcome.warnings.join(' ')).toMatch(
      /Failed to download/,
    );
    expect(imported).toHaveLength(1);
    expect(JSON.stringify(sentToWorker)).not.toContain('secret-key');
  });

  it('adopts nothing when the plugin is switched off mid-call', async () => {
    const { actions, installations } = setup();
    await settle();
    await installEnabled(installations, SHADERTOY);
    const gate = deferred<void>();
    fetchSource = async (_values, signal) => {
      await gate.promise;
      signal.throwIfAborted();
      return { sourceId: 'abc', source: shadertoyJson };
    };
    const running = actions.runImport(SHADERTOY, 'shadertoy', {
      mode: 'provider',
      values: { idOrUrl: 'abc', apiKey: 'k' },
    });
    await installations.setEnabled(SHADERTOY, false);
    gate.resolve();
    expect(await running).toEqual({ status: 'stale' });
    expect(imported).toEqual([]);
  });

  it('adopts nothing after a sign-in, a cancel, or a declined unsaved-changes prompt', async () => {
    const { actions, installations } = setup();
    await settle();
    await installEnabled(installations, SHADERTOY);

    const gate = deferred<void>();
    fetchSource = async () => {
      await gate.promise;
      return { sourceId: 'abc', source: shadertoyJson };
    };
    const signedIn = actions.runImport(SHADERTOY, 'shadertoy', {
      mode: 'provider',
      values: { idOrUrl: 'abc', apiKey: 'k' },
    });
    user.set({ id: 'bob' });
    status.set('authenticated');
    await settle();
    gate.resolve();
    expect(await signedIn).toEqual({ status: 'stale' });

    user.set(null);
    status.set('anonymous');
    await settle();
    expect(installations.find(SHADERTOY)?.active).toBe(true);
    const hold = deferred<void>();
    fetchSource = async () => {
      await hold.promise;
      return { sourceId: 'abc', source: shadertoyJson };
    };
    const cancelled = actions.runImport(SHADERTOY, 'shadertoy', {
      mode: 'provider',
      values: { idOrUrl: 'abc', apiKey: 'k' },
    });
    actions.cancel();
    hold.resolve();
    expect(await cancelled).toEqual({ status: 'cancelled' });

    fetchSource = async () => ({ sourceId: 'abc', source: shadertoyJson });
    transition = 'decline';
    expect(
      await actions.runImport(SHADERTOY, 'shadertoy', {
        mode: 'paste',
        name: 'Pasted',
        text: 'void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }',
      }),
    ).toEqual({ status: 'cancelled' });
    expect(imported).toEqual([]);
  });

  it('exports the unsaved draft without saving, and writes nothing if the shader changes', async () => {
    const { actions, installations } = setup();
    await settle();
    await installEnabled(installations, WALLPAPER);
    params.set({ speed: 7 });

    const outcome = await actions.runExport(WALLPAPER, 'wallpaper-engine');
    expect(outcome).toEqual({ status: 'exported', where: 'Waves.zip', warnings: [] });
    expect(written).toEqual([{ stem: 'Waves', paths: ['index.html', 'project.json'] }]);
    const snapshot = sentToWorker[0] as { params: ShaderParams; channels: { present: boolean }[] };
    expect(snapshot.params).toEqual({ speed: 7 });
    expect(snapshot.channels.every((channel) => channel.present === false)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('"data"');

    const store = TestBed.inject(ShaderStore) as unknown as {
      exportShader: () => Promise<unknown>;
    };
    const gate = deferred<void>();
    store.exportShader = async () => {
      await gate.promise;
      return { shader: { channels: structuredClone(DEFAULT_CHANNELS) } };
    };
    const switched = actions.runExport(WALLPAPER, 'wallpaper-engine');
    selectedId.set('other');
    gate.resolve();
    expect(await switched).toEqual({ status: 'stale' });
    expect(written).toHaveLength(1);
  });

  it('imports nothing when another shader is opened while the import runs', async () => {
    const { actions, installations } = setup();
    await settle();
    await installEnabled(installations, SHADERTOY);
    const gate = deferred<void>();
    fetchSource = async () => {
      await gate.promise;
      return { sourceId: 'abc', source: shadertoyJson };
    };
    const running = actions.runImport(SHADERTOY, 'shadertoy', {
      mode: 'provider',
      values: { idOrUrl: 'abc', apiKey: 'k' },
    });
    selectedId.set('other');
    gate.resolve();
    expect(await running).toEqual({ status: 'stale' });
    expect(imported).toEqual([]);

    // With no shader open at the start, opening one is a change too.
    selectedId.set(null);
    const later = deferred<void>();
    fetchSource = async () => {
      await later.promise;
      return { sourceId: 'abc', source: shadertoyJson };
    };
    const fromNothing = actions.runImport(SHADERTOY, 'shadertoy', {
      mode: 'provider',
      values: { idOrUrl: 'abc', apiKey: 'k' },
    });
    selectedId.set('waves');
    later.resolve();
    expect(await fromNothing).toEqual({ status: 'stale' });
    expect(imported).toEqual([]);
  });

  it('writes nothing when the shader changes while the destination is being chosen', async () => {
    const { actions, installations } = setup();
    await settle();
    await installEnabled(installations, WALLPAPER);
    actions.writer = (): ProjectWriter => ({
      write: async (output, _signal, proceed) => {
        selectedId.set('other'); // the user switched shaders while the folder dialog was open
        proceed?.();
        written.push({ stem: output.stem, paths: [] });
        return { status: 'written', where: output.stem };
      },
    });
    expect(await actions.runExport(WALLPAPER, 'wallpaper-engine')).toEqual({ status: 'stale' });
    expect(written).toEqual([]);
  });

  it('cancels a desktop folder write when the shader changes after the folder was chosen', async () => {
    const { actions, installations } = setup();
    await settle();
    await installEnabled(installations, WALLPAPER);
    // The main process, as the desktop writer sees it: the folder is chosen, then the write
    // is held until either it is cancelled (reported `cancelled`) or allowed to commit.
    const cancelled: string[] = [];
    let commit!: () => void;
    let writeStarted!: () => void;
    const started = new Promise<void>((resolve) => (writeStarted = resolve));
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        bridge: {
          files: {
            beginProjectFolder: async () => ({ status: 'ok', value: { id: 'session-1' } }),
            cancelProjectFolder: async (id: string) => {
              cancelled.push(id);
              commit();
            },
            writeProjectFolder: () => {
              writeStarted();
              return new Promise((resolve) => {
                commit = () =>
                  resolve(
                    cancelled.length > 0
                      ? { status: 'cancelled' }
                      : { status: 'ok', value: { path: '/projects/Waves' } },
                  );
              });
            },
          },
        },
      },
    });
    actions.writer = () => new DesktopFolderWriter();
    try {
      const running = actions.runExport(WALLPAPER, 'wallpaper-engine');
      await started;
      selectedId.set('other');
      TestBed.tick();
      expect(cancelled).toEqual(['session-1']);
      expect(await running).toEqual({ status: 'stale' });
    } finally {
      Reflect.deleteProperty(window, 'electron');
    }
  });

  it('refuses to start for a package that is off, and runs one action at a time', async () => {
    const { actions, installations } = setup();
    await settle();
    await installEnabled(installations, SHADERTOY);
    await installations.setEnabled(SHADERTOY, false);
    expect(
      await actions.runImport(SHADERTOY, 'shadertoy', { mode: 'paste', name: 'x', text: '' }),
    ).toMatchObject({ status: 'failed' });

    await installations.setEnabled(SHADERTOY, true);
    const gate = deferred<void>();
    fetchSource = async () => {
      await gate.promise;
      return { sourceId: 'abc', source: shadertoyJson };
    };
    const first = actions.runImport(SHADERTOY, 'shadertoy', {
      mode: 'provider',
      values: { idOrUrl: 'abc', apiKey: 'k' },
    });
    expect(
      await actions.runImport(SHADERTOY, 'shadertoy', { mode: 'paste', name: 'x', text: '' }),
    ).toMatchObject({ status: 'failed', message: expect.stringMatching(/Another/) });
    gate.resolve();
    expect(await first).toMatchObject({ status: 'imported' });
  });
});
