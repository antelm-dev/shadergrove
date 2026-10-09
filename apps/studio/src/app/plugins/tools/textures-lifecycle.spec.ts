import { computed, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CHANNELS, type ShaderRecord } from '@shadergrove/shared/model';
import { sourceFingerprint, type AssetToolOutput } from '@shadergrove/shared/plugin';

import { AuthService } from '../../auth/auth.service';
import { DesktopPlatform } from '../../desktop/desktop-platform';
import { I18n } from '../../i18n/i18n';
import { ShaderStore } from '../../workspace/shader-store';
import { PluginHost } from '../plugin-host';
import { PLUGIN_STORE, PluginInstallations } from '../plugin-installations';
import type { StoredPlugin } from '../plugin-store';
import {
  PluginTools,
  provideToolAdapters,
  type ToolSession,
  type ToolSource,
} from '../plugin-tools';
import { PluginToolsOutlet } from '../plugin-tools-outlet';
import { newRecord, recordingStart, type SandboxRecord } from '../testing/tool-fixtures';
import { buildTextureRequest, type TextureSelection } from './textures';
import { TEXTURE_UTILITIES_ID, solidPlane, textureUtilitiesText } from './textures-fixtures';
import {
  assignPngToChannel,
  channelTarget,
  encodePng,
  fromToolImage,
} from './textures-image-bridge';
import { TextureUtilitiesAdapter, TexturesTool } from './textures-adapter';

/**
 * AC-LIFECYCLE for Texture Utilities: the official package behind the real
 * installations, tools and sessions (Worker code in-process). Results are tied
 * to the selection and the install; a preview never cancels a full job; a
 * download or assignment of a stale result, or to a slot that changed, writes
 * nothing.
 */
const firstImage = (value: unknown) => (value as AssetToolOutput & { kind: 'image' }).images[0]!;

describe('texture utilities lifecycle', () => {
  const record = signal<ShaderRecord | null>(null);
  const setTextureImage = vi.fn(async (channel: number) => {
    const current = record()!;
    record.set({
      ...current,
      channels: current.channels.map((meta, index) =>
        index === channel ? { ...meta, ext: 'png', width: 2, height: 1 } : meta,
      ) as unknown as ShaderRecord['channels'],
    });
  });
  let profiles: Map<string, Map<string, StoredPlugin>>;
  let sandbox: SandboxRecord;

  function setup() {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: PLUGIN_STORE,
          useValue: (profile: string) => {
            const records = profiles.get(profile) ?? new Map<string, StoredPlugin>();
            profiles.set(profile, records);
            return {
              list: async () => [...records.values()],
              put: async (stored: StoredPlugin) => void records.set(stored.id, stored),
              remove: async (id: string) => void records.delete(id),
              replace: async (stored: StoredPlugin) =>
                records.get(stored.id)?.installedAt === stored.installedAt
                  ? (records.set(stored.id, stored), true)
                  : false,
              readBootstrap: async () => null,
              writeBootstrap: async () => undefined,
            };
          },
        },
        { provide: AuthService, useValue: { user: signal(null), status: signal('anonymous') } },
        { provide: DesktopPlatform, useValue: { available: false } },
        { provide: I18n, useValue: { t: (key: string) => key } },
        {
          provide: ShaderStore,
          useValue: {
            record,
            setTextureImage,
            selectedId: computed(() => record()?.id ?? null),
            draft: signal(null),
            controls: signal([]),
            params: signal({}),
          },
        },
        provideToolAdapters([TextureUtilitiesAdapter]),
      ],
    });
    const installations = TestBed.inject(PluginInstallations);
    vi.spyOn(installations, 'host').mockImplementation((id) => {
      const installed = installations.find(id);
      if (!installed?.active || !installed.plugin) return null;
      return new PluginHost(installed.plugin, { start: recordingStart(installed.plugin, sandbox) });
    });
    return { tools: TestBed.inject(PluginTools), installations };
  }

  async function settle(): Promise<void> {
    TestBed.tick();
    for (let i = 0; i < 6; i++) await Promise.resolve();
  }

  async function install(installations: PluginInstallations, text = textureUtilitiesText()) {
    await settle();
    const review = installations.review(new TextEncoder().encode(text));
    if (!review.ok) throw new Error(review.errors.join());
    await installations.install(review);
    await installations.setEnabled(TEXTURE_UTILITIES_ID, true);
    await settle();
  }

  const two = solidPlane(2, 1, [10, 20, 30, 255]);
  const selection = signal<TextureSelection>({
    operation: 'pack',
    images: [two, null, null, null],
    width: 2,
    height: 1,
    filter: 'nearest',
    usage: 'data',
    channels: [
      { plane: 0, channel: 'b' },
      { plane: 0, channel: 'g' },
      { plane: 0, channel: 'r' },
      { constant: 255 },
    ],
    normal: { channel: 'r', strength: 2, green: 'up', edges: 'wrap' },
    name: 'swapped',
  });
  const source = computed<ToolSource>(() => {
    const { images: _images, ...settings } = selection();
    return { shaderId: 'texture-utilities', fingerprint: sourceFingerprint(settings) };
  });
  const open = (tools: PluginTools): ToolSession => {
    const session = tools.openSession(TEXTURE_UTILITIES_ID, 'texture-utilities', { source });
    if (!session) throw new Error('not offered');
    return session;
  };

  beforeEach(() => {
    profiles = new Map();
    sandbox = newRecord();
    setTextureImage.mockClear();
    record.set({
      id: 'waves',
      name: 'Waves',
      channels: DEFAULT_CHANNELS.map((channel) => ({ ...channel })),
    } as unknown as ShaderRecord);
    selection.update((current) => ({ ...current, name: 'swapped' }));
  });

  afterEach(() => TestBed.resetTestingModule());

  it('offers the official package through the registered adapter, with no project needed', async () => {
    const { tools, installations } = setup();
    await install(installations);
    const [tool] = tools.toolsOf(TEXTURE_UTILITIES_ID);
    expect(tool?.adapter).toBeInstanceOf(TextureUtilitiesAdapter);
    expect(tool?.adapter).toMatchObject({
      kind: 'assetTool',
      workflow: 'texture-utilities/v1',
      panel: TexturesTool,
      needsProject: false,
      command: { label: 'textures.command', icon: 'texture' },
    });
    await installations.setEnabled(TEXTURE_UTILITIES_ID, false);
    expect(tools.toolsOf(TEXTURE_UTILITIES_ID)).toEqual([]);
  });

  it('refuses settings outside the schema before any Worker starts', async () => {
    const { tools, installations } = setup();
    await install(installations);
    const outcome = await open(tools).runAsset({
      operation: 'pack',
      planes: [two],
      settings: { width: 2 },
    });
    expect(outcome.status).toBe('failed');
    expect(sandbox.starts).toBe(0);
  });

  it('shows a full result only while the selection it was made from holds', async () => {
    const { tools, installations } = setup();
    await install(installations);
    const full = open(tools);
    const outcome = await full.runAsset(buildTextureRequest(selection(), false));
    expect(outcome.status).toBe('ok');
    const image = fromToolImage(firstImage(full.result()!.value));
    expect([...image.rgba]).toEqual([30, 20, 10, 255, 30, 20, 10, 255]);

    selection.update((current) => ({ ...current, name: 'renamed' }));
    expect(full.result()).toBeNull();
    expect(full.stale()).toBe(true);
    const work = vi.fn();
    expect(await full.deliver(work)).toEqual({ status: 'stale' });
    expect(work).not.toHaveBeenCalled();
  });

  it('runs previews in a session of their own, so a preview never cancels a full job', async () => {
    const { tools, installations } = setup();
    await install(installations);
    const [preview, full] = [open(tools), open(tools)];
    const job = full.runAsset(buildTextureRequest(selection(), false));
    const first = preview.runAsset(buildTextureRequest(selection(), true));
    const second = preview.runAsset(buildTextureRequest(selection(), true));
    expect((await first).status).toBe('superseded');
    expect((await second).status).toBe('ok');
    expect((await job).status).toBe('ok');
    expect(full.result()).not.toBeNull();
  });

  it('cancels a full job on request, and nothing is shown', async () => {
    const { tools, installations } = setup();
    await install(installations);
    const full = open(tools);
    const job = full.runAsset(buildTextureRequest(selection(), false));
    full.cancel();
    expect((await job).status).toBe('cancelled');
    expect(full.result()).toBeNull();
  });

  it.each([
    [
      'switched off',
      (installations: PluginInstallations) => installations.setEnabled(TEXTURE_UTILITIES_ID, false),
    ],
    ['removed', (installations: PluginInstallations) => installations.remove(TEXTURE_UTILITIES_ID)],
  ])('drops a result and refuses its delivery once the package is %s', async (_label, change) => {
    const { tools, installations } = setup();
    await install(installations);
    const full = open(tools);
    await full.runAsset(buildTextureRequest(selection(), false));
    await change(installations);
    await settle();
    expect(full.result()).toBeNull();
    const work = vi.fn();
    expect(await full.deliver(work)).toEqual({ status: 'stale' });
    expect(work).not.toHaveBeenCalled();
  });

  it('assigns to the slot it was aimed at, and to nothing when that slot changed meanwhile', async () => {
    const { tools, installations } = setup();
    await install(installations);
    const full = open(tools);
    await full.runAsset(buildTextureRequest(selection(), false));
    const store = TestBed.inject(ShaderStore);
    const assign = (channel: 1 | 2, meanwhile: () => void = () => undefined) =>
      full.deliver(
        async (value, check) => {
          const png = await encodePng(fromToolImage(firstImage(value)));
          meanwhile();
          await assignPngToChannel(store, channel, png, 'swapped.png', check);
        },
        { expected: channelTarget(store, channel)!, current: () => channelTarget(store, channel) },
      );

    expect(await assign(1)).toEqual({ status: 'delivered', value: undefined });
    expect(setTextureImage).toHaveBeenCalledTimes(1);
    expect(setTextureImage.mock.calls[0]![0]).toBe(1);
    expect(record()!.channels.map((meta) => meta.ext)).toEqual([null, 'png', null, null]);

    // Another texture lands in slot 2 while the PNG is encoded: nothing is written.
    const outcome = await assign(2, () =>
      record.update((current) => ({
        ...current!,
        channels: current!.channels.map((meta, index) =>
          index === 2 ? { ...meta, ext: 'jpg' } : meta,
        ) as unknown as ShaderRecord['channels'],
      })),
    );
    expect(outcome).toEqual({ status: 'stale' });
    expect(setTextureImage).toHaveBeenCalledTimes(1);
  });

  it('draws the panel in the Installed card only while the package is on, and closes its sessions', async () => {
    const { installations } = setup();
    await install(installations);
    const fixture = TestBed.createComponent(PluginToolsOutlet);
    fixture.componentRef.setInput('packageId', TEXTURE_UTILITIES_ID);
    await fixture.whenStable();
    const host: HTMLElement = fixture.nativeElement;
    expect(host.querySelector('app-textures-panel')).not.toBeNull();
    expect(host.querySelector('[data-testid="textures-op-pack"]')).not.toBeNull();
    // No image yet: the preview says which one it needs, and no Worker started.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await fixture.whenStable();
    expect(host.querySelector('[data-testid="textures-preview-status"]')?.textContent).toContain(
      'textures.needImages',
    );
    expect(sandbox.starts).toBe(0);

    await installations.setEnabled(TEXTURE_UTILITIES_ID, false);
    await settle();
    await fixture.whenStable();
    expect(host.querySelector('app-textures-panel')).toBeNull();
    fixture.destroy();
  });
});
