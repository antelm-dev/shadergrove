import { PLATFORM_ID, computed, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_RENDER, type ShaderControl, type ShaderParams } from '@shadergrove/shared/model';
import {
  PLUGIN_PROTOCOL_VERSION,
  SUPPORTED_PLUGIN_PROTOCOLS,
  parsePluginPackage,
  type AnalyzerReport,
  type PluginPackage,
  type ResourceState,
} from '@shadergrove/shared/plugin';
import { migrateLegacyProject, type ShaderProject } from '@shadergrove/shared/project';
import { AuthService } from '../auth/auth.service';
import { DesktopPlatform } from '../desktop/desktop-platform';
import { I18n, type LanguageEntry } from '../i18n/i18n';
import { AppThemes } from '../themes/app-themes';
import { WorkspaceActions } from '../ui/workspace-actions';
import { ShaderStore } from '../workspace/shader-store';
import { EffectAdoption } from './effect-adoption';
import { PluginCommands } from './plugin-commands';
import { PluginHost } from './plugin-host';
import { PLUGIN_STORE, PluginInstallations } from './plugin-installations';
import type { StoredPlugin } from './plugin-store';
import {
  PluginTools,
  TOOL_ADAPTERS,
  type ToolAdapter,
  type ToolOutcome,
  type ToolSession,
} from './plugin-tools';
import {
  TOOLS_PACKAGE_ID,
  gate,
  newRecord,
  recordingStart,
  resetGate,
  testAnalyzerAdapter,
  testTextureAdapter,
  toolsPackageText,
  type SandboxRecord,
} from './testing/tool-fixtures';

/**
 * AC-LIFECYCLE for the protocol-4 seam, against the real installations, host,
 * sessions and commands: menus, palette and cards reflect the active registered
 * contributions; disabling, updating, removing, switching profile or editing
 * the source makes a pending or displayed result vanish and blocks delivery;
 * nothing is shown, applied, downloaded or assigned from a stale operation.
 */
describe('plugin tools', () => {
  const user = signal<{ id: string } | null>(null);
  const status = signal<'loading' | 'anonymous' | 'authenticated'>('anonymous');
  const selectedId = signal<string | null>('waves');
  const draft = signal<{ project: ShaderProject; render: typeof DEFAULT_RENDER }>({
    project: migrateLegacyProject('void main() {}', 'void main() {}'),
    render: DEFAULT_RENDER,
  });
  const controls = signal<ShaderControl[]>([]);
  const params = signal<ShaderParams>({});
  const record = signal<{ id: string; name: string } | null>({ id: 'waves', name: 'Waves' });
  const notice = signal<{ text: string; error: boolean } | null>(null);
  const navigate = vi.fn(async () => true);
  const languages = signal<LanguageEntry[]>([]);
  let profiles: Map<string, Map<string, StoredPlugin>>;
  let sandbox: SandboxRecord;
  let timeoutMs: number | undefined;

  function setup(adapters: ToolAdapter[] = [testAnalyzerAdapter, testTextureAdapter]) {
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
        { provide: AuthService, useValue: { user, status } },
        { provide: DesktopPlatform, useValue: { available: false } },
        {
          provide: I18n,
          useValue: {
            t: (key: string) => key,
            languages,
            label: () => '',
            select: () => undefined,
          },
        },
        { provide: WorkspaceActions, useValue: {} },
        {
          provide: ShaderStore,
          useValue: { selectedId, draft, controls, params, record, notice },
        },
        {
          provide: AppThemes,
          useValue: { entries: signal([]), pairs: computed(() => []) },
        },
        { provide: EffectAdoption, useValue: { adopt: () => ({ ok: true }) } },
        { provide: Router, useValue: { navigate } },
        ...adapters.map((adapter) => ({ provide: TOOL_ADAPTERS, useValue: adapter, multi: true })),
      ],
    });
    const installations = TestBed.inject(PluginInstallations);
    // Plugin code runs in-process here; the real sandbox needs a browser Worker.
    vi.spyOn(installations, 'host').mockImplementation((id) => {
      const installed = installations.find(id);
      if (!installed?.active || !installed.plugin) return null;
      return new PluginHost(installed.plugin, {
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        start: recordingStart(installed.plugin, sandbox),
      });
    });
    return { tools: TestBed.inject(PluginTools), installations };
  }

  async function settle(): Promise<void> {
    TestBed.tick();
    for (let i = 0; i < 6; i++) await Promise.resolve();
  }

  async function install(
    installations: PluginInstallations,
    text = toolsPackageText(),
    options: { enable?: boolean; update?: boolean } = {},
  ): Promise<string> {
    // The profile's store opens on the first tick.
    await settle();
    const review = installations.review(new TextEncoder().encode(text));
    if (!review.ok) throw new Error(review.errors.join());
    if (options.update) await installations.installReviewedUpdate(review);
    else await installations.install(review);
    if (options.enable !== false) await installations.setEnabled(review.plugin.manifest.id, true);
    await settle();
    return review.plugin.manifest.id;
  }

  const refs = (tools: PluginTools) => tools.tools().map((tool) => tool.ref);
  const plane = (width: number, height: number) => {
    const bytes = new Uint8Array(width * height * 4).map((_, index) => (index * 5) % 256);
    return {
      width,
      height,
      orientation: 'top-left' as const,
      alpha: 'straight' as const,
      usage: 'data' as const,
      rgba: bytes.buffer,
    };
  };
  const snapshot = (name: string, state: ResourceState = 'empty') => ({
    name,
    project: draft().project,
    controls: [],
    params: {},
    render: DEFAULT_RENDER,
    channels: Array.from({ length: 4 }, () => ({
      state,
      present: false,
      ext: null,
      width: 0,
      height: 0,
      wrap: 'clamp' as const,
      filter: 'linear' as const,
      flipY: false,
    })),
    postProcessingActive: false,
  });
  const edit = () =>
    draft.update((current) => ({
      ...current,
      project: { ...current.project, vertex: `${current.project.vertex}\n// edited` },
    }));
  const open = (tools: PluginTools, contribution: string): ToolSession => {
    const session = tools.openSession(TOOLS_PACKAGE_ID, contribution);
    if (!session) throw new Error(`no session for ${contribution}`);
    return session;
  };
  const status_of = <T>(outcome: ToolOutcome<T>) => outcome.status;

  beforeEach(() => {
    profiles = new Map();
    sandbox = newRecord();
    timeoutMs = undefined;
    user.set(null);
    status.set('anonymous');
    selectedId.set('waves');
    record.set({ id: 'waves', name: 'Waves' });
    draft.set({
      project: migrateLegacyProject('void main() {}', 'void main() {}'),
      render: DEFAULT_RENDER,
    });
    notice.set(null);
    navigate.mockClear();
  });

  afterEach(() => {
    resetGate();
    TestBed.resetTestingModule();
  });

  describe('compatibility', () => {
    it('speaks protocols 1-4 and leaves every shipped package exactly as it was', () => {
      expect(PLUGIN_PROTOCOL_VERSION).toBe(4);
      expect(SUPPORTED_PLUGIN_PROTOCOLS).toEqual([1, 2, 3, 4]);
      const generated = resolve(import.meta.dirname, '../../plugins');
      const catalogue = JSON.parse(readFileSync(resolve(generated, 'catalogue.json'), 'utf8')) as {
        packages: { id: string; file: string; protocolVersion: number }[];
      };
      expect(catalogue.packages.length).toBeGreaterThan(0);
      for (const entry of catalogue.packages) {
        const parsed = parsePluginPackage(readFileSync(resolve(generated, entry.file), 'utf8'));
        if (!parsed.ok) throw new Error(`${entry.id}: ${parsed.errors.join()}`);
        // No official package lists a protocol-4 kind yet, and none gained template data.
        expect(parsed.value.manifest.protocolVersion).toBeLessThanOrEqual(3);
        expect(parsed.value.templates).toEqual({});
        expect(
          parsed.value.manifest.contributions.some((c) =>
            ['analyzer', 'assetTool', 'projectTemplate'].includes(c.kind),
          ),
        ).toBe(false);
      }
    });
  });

  describe('active contributions', () => {
    it('offers nothing until the package is installed and switched on', async () => {
      const { tools, installations } = setup();
      await settle();
      expect(refs(tools)).toEqual([]);
      await install(installations, toolsPackageText(), { enable: false });
      expect(refs(tools)).toEqual([]);
      expect(tools.templates()).toEqual([]);
      await installations.setEnabled(TOOLS_PACKAGE_ID, true);
      await settle();
      expect(refs(tools)).toEqual([`${TOOLS_PACKAGE_ID}/doctor`, `${TOOLS_PACKAGE_ID}/pack`]);
      expect(tools.templates().map((template) => template.ref)).toEqual([
        `${TOOLS_PACKAGE_ID}/trails`,
      ]);
    });

    it('offers only contributions whose host adapter is registered', async () => {
      // No palette-studio adapter exists, so that asset tool never appears, nor does an analyzer
      // when no analyzer adapter is registered; templates are data and need no adapter.
      const { tools, installations } = setup([testTextureAdapter]);
      await install(installations);
      expect(refs(tools)).toEqual([`${TOOLS_PACKAGE_ID}/pack`]);
      expect(tools.templates()).toHaveLength(1);
      expect(tools.openSession(TOOLS_PACKAGE_ID, 'palette')).toBeNull();
      expect(tools.openSession(TOOLS_PACKAGE_ID, 'doctor')).toBeNull();
    });

    it('follows switching off, update, removal and a profile change at once', async () => {
      const { tools, installations } = setup();
      await install(installations);
      expect(refs(tools)).toHaveLength(2);

      await installations.setEnabled(TOOLS_PACKAGE_ID, false);
      expect(refs(tools)).toEqual([]);
      expect(tools.templates()).toEqual([]);

      await installations.setEnabled(TOOLS_PACKAGE_ID, true);
      expect(refs(tools)).toHaveLength(2);

      // An update is off until the user switches it on again.
      await install(installations, toolsPackageText({ version: '1.0.1' }), {
        enable: false,
        update: true,
      });
      expect(refs(tools)).toEqual([]);
      await installations.setEnabled(TOOLS_PACKAGE_ID, true);
      await settle();
      expect(refs(tools)).toHaveLength(2);

      user.set({ id: 'u1' });
      status.set('authenticated');
      await settle();
      expect(refs(tools)).toEqual([]);
      user.set(null);
      status.set('anonymous');
      await settle();
      expect(refs(tools)).toHaveLength(2);

      await installations.remove(TOOLS_PACKAGE_ID);
      await settle();
      expect(refs(tools)).toEqual([]);
    });

    it('is inert where tools may not run: the output window and the server render', async () => {
      const { tools, installations } = setup();
      await install(installations);
      expect(tools.available).toBe(true);

      window.history.pushState({}, '', '/output');
      try {
        const output = TestBed.runInInjectionContext(() => new PluginTools());
        expect(output.available).toBe(false);
        expect(output.tools()).toEqual([]);
        expect(output.templates()).toEqual([]);
        expect(output.openSession(TOOLS_PACKAGE_ID, 'doctor')).toBeNull();
      } finally {
        window.history.pushState({}, '', '/');
      }
      expect(sandbox.starts).toBe(0);
    });

    it('is inert on the server render', async () => {
      TestBed.configureTestingModule({ providers: [{ provide: PLATFORM_ID, useValue: 'server' }] });
      const { tools, installations } = setup();
      await install(installations);
      expect(tools.available).toBe(false);
      expect(tools.tools()).toEqual([]);
      expect(tools.openSession(TOOLS_PACKAGE_ID, 'doctor')).toBeNull();
    });
  });

  describe('menu and palette commands', () => {
    it('lists registered tools of active packages, dims the project tool without a shader and opens its panel', async () => {
      const { installations } = setup();
      const commands = TestBed.inject(PluginCommands);
      expect(commands.toolCommands()).toEqual([]);
      await install(installations);

      const list = commands.toolCommands();
      expect(list.map((command) => command.ref)).toEqual([
        `${TOOLS_PACKAGE_ID}/doctor`,
        `${TOOLS_PACKAGE_ID}/pack`,
      ]);
      expect(list.map((command) => command.icon())).toEqual(['health_and_safety', 'texture']);
      // Doctor needs an open draft; the image tool does not.
      expect(list[0]!.disabled?.()).toBe(false);
      record.set(null);
      expect(list[0]!.disabled?.()).toBe(true);
      expect(list[1]!.disabled).toBeUndefined();

      list[1]!.action();
      await settle();
      expect(navigate).toHaveBeenCalledWith(['/plugins'], {
        queryParams: { use: TOOLS_PACKAGE_ID },
      });

      // A palette keeps the commands it opened with: a removed tool must not open.
      navigate.mockClear();
      await installations.setEnabled(TOOLS_PACKAGE_ID, false);
      expect(commands.toolCommands()).toEqual([]);
      list[1]!.action();
      await settle();
      expect(navigate).not.toHaveBeenCalled();
      expect(notice()).toEqual({ text: 'plugins.staleResult', error: true });
    });
  });

  describe('sessions', () => {
    it('shows an analyzer report for the draft it was computed from, and only while that holds', async () => {
      const { tools, installations } = setup();
      await install(installations);
      const session = open(tools, 'doctor');
      expect(session.result()).toBeNull();

      const outcome = await session.analyze('studio-webgl2/v1', snapshot('Seascape'));
      expect(status_of(outcome)).toBe('ok');
      expect(session.result()?.value).toMatchObject({
        profile: 'studio-webgl2/v1',
        revision: expect.any(String),
      });
      expect(session.result()?.source?.shaderId).toBe('waves');
      expect(session.stale()).toBe(false);

      // Editing the draft takes the report away immediately, without another request.
      edit();
      expect(session.result()).toBeNull();
      expect(session.stale()).toBe(true);
    });

    it('keeps a target-profile switch a new request with its own result and version', async () => {
      const { tools, installations } = setup();
      await install(installations);
      const session = open(tools, 'doctor');
      await session.analyze('studio-webgl2/v1', snapshot('a'));
      const first = session.result()!.value as { profile: string };
      await session.analyze('wallpaper-web/v1', snapshot('a'));
      const second = session.result()!.value as { profile: string; targetVersion: number };
      expect([first.profile, second.profile]).toEqual(['studio-webgl2/v1', 'wallpaper-web/v1']);
      expect(second.targetVersion).toBe(1);
      const unknown = await session.analyze('webgpu/v1' as never, snapshot('a'));
      expect(unknown).toMatchObject({ status: 'failed' });
    });

    it('shows no report of another target while the new request runs, then the new target only', async () => {
      const { tools, installations } = setup();
      await install(installations);
      const session = open(tools, 'doctor');
      await session.analyze('studio-webgl2/v1', snapshot('a'));
      expect(session.target()).toBe('studio-webgl2/v1');
      expect(session.result()?.value).toMatchObject({ profile: 'studio-webgl2/v1' });

      const hold = gate();
      const pending = session.analyze('wallpaper-web/v1', snapshot('slow'));
      await vi.waitFor(() => expect(sandbox.sent).toHaveLength(2));
      // The old report belongs to the old target: gone at once, marked out of date.
      expect(session.target()).toBe('wallpaper-web/v1');
      expect(session.result()).toBeNull();
      expect(session.stale()).toBe(true);

      hold.release();
      expect((await pending).status).toBe('ok');
      expect(session.result()?.value).toMatchObject({ profile: 'wallpaper-web/v1' });
      expect(session.stale()).toBe(false);
    });

    it('never falls back to the old target report when the new target request fails', async () => {
      const { tools, installations } = setup();
      // Declares studio-webgl2/v1 only: asking for the wallpaper target fails before any Worker starts.
      await install(installations, toolsPackageText({ analyzerProfiles: ['studio-webgl2/v1'] }));
      const session = open(tools, 'doctor');
      await session.analyze('studio-webgl2/v1', snapshot('a'));
      expect(session.result()).not.toBeNull();
      const starts = sandbox.starts;

      const refused = await session.analyze('wallpaper-web/v1', snapshot('a'));
      expect(refused).toMatchObject({ status: 'failed' });
      expect(sandbox.starts).toBe(starts);
      expect(session.target()).toBe('wallpaper-web/v1');
      expect(session.result()).toBeNull();
      expect(session.stale()).toBe(true);

      // An unknown profile behaves the same.
      expect((await session.analyze('webgpu/v1' as never, snapshot('a'))).status).toBe('failed');
      expect(session.result()).toBeNull();
    });

    it('shows no old report when the Worker fails for the new target', async () => {
      const { tools, installations } = setup();
      await install(installations);
      const session = open(tools, 'doctor');
      await session.analyze('studio-webgl2/v1', snapshot('a'));
      expect(await session.analyze('wallpaper-web/v1', snapshot('boom'))).toMatchObject({
        status: 'failed',
      });
      expect(session.result()).toBeNull();
      // Going back to the first target is a new request with its own result.
      await session.analyze('studio-webgl2/v1', snapshot('a'));
      expect(session.result()?.value).toMatchObject({ profile: 'studio-webgl2/v1' });
    });

    it('reports a slot that is not loaded as unchecked, never as a verdict', async () => {
      const { tools, installations } = setup();
      await install(installations);
      const session = open(tools, 'doctor');
      const textureFindings = async (state: ResourceState) => {
        await session.analyze('studio-webgl2/v1', snapshot('a', state));
        const report = session.result()!.value as AnalyzerReport;
        return report.findings.filter((finding) => finding.ruleId === 'resources.texture');
      };
      for (const state of ['empty', 'loaded'] as const) {
        expect(await textureFindings(state)).toEqual([]);
      }
      for (const state of ['loading', 'failed', 'unknown'] as const) {
        const findings = await textureFindings(state);
        expect(findings).toHaveLength(4);
        expect(findings.every((finding) => finding.coverage === 'unchecked')).toBe(true);
        expect(findings[0]!.message).toContain(state);
      }
    });

    it('sends the render settings and slot states to the Worker', async () => {
      const { tools, installations } = setup();
      await install(installations);
      await open(tools, 'doctor').analyze('studio-webgl2/v1', snapshot('a', 'loading'));
      const sent = sandbox.sent[0]!.params as { render: unknown; channels: { state: string }[] };
      expect(sent.render).toEqual(DEFAULT_RENDER);
      expect(sent.channels.map((channel) => channel.state)).toEqual(Array(4).fill('loading'));
    });

    it('refuses an analyzer request with no draft open, and a tool that is not what was asked', async () => {
      const { tools, installations } = setup();
      await install(installations);
      selectedId.set(null);
      expect(await open(tools, 'doctor').analyze('studio-webgl2/v1', snapshot('x'))).toEqual({
        status: 'failed',
        message: 'Open a shader first.',
      });
      expect(sandbox.starts).toBe(0);
      const asset = open(tools, 'pack');
      expect(await asset.analyze('studio-webgl2/v1', snapshot('x'))).toMatchObject({
        status: 'failed',
      });
      expect(
        await open(tools, 'doctor').runAsset({ operation: 'pack', planes: [plane(1, 1)] }),
      ).toMatchObject({ status: 'failed' });
    });

    describe.each([
      [
        'the draft is edited',
        async () => {
          edit();
        },
      ],
      [
        'another shader is opened',
        async () => {
          selectedId.set('other');
        },
      ],
      [
        'the package is switched off',
        async (installations: PluginInstallations) => {
          await installations.setEnabled(TOOLS_PACKAGE_ID, false);
        },
      ],
      [
        'the package is updated',
        async (installations: PluginInstallations) => {
          await install(installations, toolsPackageText({ version: '1.0.1' }), {
            enable: true,
            update: true,
          });
        },
      ],
      [
        'the package is removed',
        async (installations: PluginInstallations) => {
          await installations.remove(TOOLS_PACKAGE_ID);
        },
      ],
      [
        'the profile changes',
        async () => {
          user.set({ id: 'u1' });
          status.set('authenticated');
          await settle();
        },
      ],
    ])('while a delayed report runs and %s', (_name, change) => {
      it('never shows the late report', async () => {
        const { tools, installations } = setup();
        await install(installations);
        const session = open(tools, 'doctor');
        const hold = gate();
        const pending = session.analyze('studio-webgl2/v1', snapshot('slow'));
        await vi.waitFor(() => expect(sandbox.sent).toHaveLength(1));

        await change(installations);
        hold.release();
        const outcome = await pending;

        expect(outcome.status).toBe('stale');
        expect(session.result()).toBeNull();
        expect(session.running()).toBe(false);
      });
    });

    it('terminates the Worker of a call whose package is switched off', async () => {
      const { tools, installations } = setup();
      await install(installations);
      const session = open(tools, 'doctor');
      gate();
      const pending = session.analyze('studio-webgl2/v1', snapshot('slow'));
      await vi.waitFor(() => expect(sandbox.sent).toHaveLength(1));
      await installations.setEnabled(TOOLS_PACKAGE_ID, false);
      expect((await pending).status).toBe('stale');
      expect(sandbox.terminated.length).toBeGreaterThan(0);
    });

    it('coalesces rapid previews: the newest wins, the older never start or are terminated', async () => {
      const { tools, installations } = setup();
      await install(installations);
      const session = open(tools, 'pack');
      const request = (size: number) =>
        session.runAsset({
          operation: 'pack',
          settings: { mode: 'invert' },
          planes: [plane(size, size)],
          preview: true,
        });
      // Three requests in the same tick: only the last may start a Worker.
      const [a, b, c] = await Promise.all([request(1), request(2), request(3)]);
      expect([a.status, b.status, c.status]).toEqual(['superseded', 'superseded', 'ok']);
      expect(sandbox.starts).toBe(1);
      const shown = session.result()!.value as { images: { width: number }[] };
      expect(shown.images[0]!.width).toBe(3);
    });

    it('terminates a running job a newer request supersedes, and shows only the newer result', async () => {
      const { tools, installations } = setup();
      await install(installations);
      const session = open(tools, 'pack');
      const hold = gate();
      const first = session.runAsset({
        operation: 'pack',
        settings: { mode: 'slow' },
        planes: [plane(1, 1)],
        preview: true,
      });
      await vi.waitFor(() => expect(sandbox.sent).toHaveLength(1));
      const second = session.runAsset({
        operation: 'pack',
        settings: { mode: 'invert' },
        planes: [plane(2, 2)],
        preview: true,
      });
      hold.release();
      expect([(await first).status, (await second).status]).toEqual(['superseded', 'ok']);
      expect(sandbox.terminated.some((reason) => /cancelled/i.test(String(reason)))).toBe(true);
      const shown = session.result()!.value as { images: { width: number }[] };
      expect(shown.images[0]!.width).toBe(2);
      expect(session.running()).toBe(false);
    });

    it('copies inputs: the caller keeps its buffers attached however many previews run', async () => {
      const { tools, installations } = setup();
      await install(installations);
      const session = open(tools, 'pack');
      const input = plane(8, 8);
      const before = new Uint8Array(input.rgba).slice();
      for (const preview of [true, true, false]) {
        const outcome = await session.runAsset({
          operation: 'pack',
          settings: {},
          planes: [input],
          preview,
        });
        expect(outcome.status).toBe('ok');
        expect(input.rgba.byteLength).toBe(256);
        expect(new Uint8Array(input.rgba)).toEqual(before);
      }
      expect(
        sandbox.sent.every((call) => call.transfer.every((buffer) => buffer !== input.rgba)),
      ).toBe(true);
    });

    it('validates settings with the workflow adapter before anything reaches a Worker', async () => {
      const { tools, installations } = setup();
      await install(installations);
      const session = open(tools, 'pack');
      expect(
        await session.runAsset({
          operation: 'pack',
          settings: { shell: 'rm' },
          planes: [plane(1, 1)],
        }),
      ).toEqual({ status: 'failed', message: 'settings.shell is not a known setting' });
      expect(
        await session.runAsset({ operation: 'bake', settings: {}, planes: [plane(1, 1)] }),
      ).toMatchObject({ status: 'failed' });
      expect(sandbox.starts).toBe(0);
    });

    it('reports host rejections of a tool reply with their code and shows nothing', async () => {
      const { tools, installations } = setup();
      await install(installations);
      const asset = open(tools, 'pack');
      const view = await asset.runAsset({
        operation: 'pack',
        settings: { mode: 'view' },
        planes: [plane(1, 1)],
      });
      expect(view).toMatchObject({ status: 'failed', code: 'output-invalid' });
      expect(asset.result()).toBeNull();
      expect(asset.error()).toMatch(/ArrayBuffer/);

      const doctor = open(tools, 'doctor');
      expect(await doctor.analyze('studio-webgl2/v1', snapshot('bad-line'))).toMatchObject({
        status: 'failed',
        code: 'output-invalid',
      });
      expect(await doctor.analyze('studio-webgl2/v1', snapshot('boom'))).toMatchObject({
        status: 'failed',
        message: 'rule crashed',
      });
      expect(doctor.result()).toBeNull();
    });

    it('times out a hung tool with a real termination and shows nothing', async () => {
      timeoutMs = 40;
      const { tools, installations } = setup();
      await install(installations);
      const session = open(tools, 'doctor');
      const outcome = await session.analyze('studio-webgl2/v1', snapshot('hang'));
      expect(outcome).toMatchObject({
        status: 'failed',
        message: expect.stringMatching(/did not answer/),
      });
      expect(sandbox.terminated).toEqual(['Call finished']);
      expect(session.result()).toBeNull();
      expect(session.running()).toBe(false);
    });

    it('cancels on request and refuses everything once closed', async () => {
      const { tools, installations } = setup();
      await install(installations);
      const session = open(tools, 'doctor');
      gate();
      const pending = session.analyze('studio-webgl2/v1', snapshot('slow'));
      await vi.waitFor(() => expect(sandbox.sent).toHaveLength(1));
      session.cancel();
      expect((await pending).status).toBe('cancelled');
      expect(session.result()).toBeNull();

      await session.analyze('studio-webgl2/v1', snapshot('ok'));
      expect(session.result()).not.toBeNull();
      session.close();
      expect(session.result()).toBeNull();
      expect((await session.analyze('studio-webgl2/v1', snapshot('ok'))).status).toBe('cancelled');
    });
  });

  describe('delivery', () => {
    async function withResult() {
      const { tools, installations } = setup();
      await install(installations);
      const session = open(tools, 'pack');
      await session.runAsset({ operation: 'pack', settings: {}, planes: [plane(2, 2)] });
      return { tools, installations, session };
    }

    it('hands over the displayed result while it holds', async () => {
      const { session } = await withResult();
      const delivered = await session.deliver(async (value) => (value as { kind: string }).kind);
      expect(delivered).toEqual({ status: 'delivered', value: 'image' });
    });

    it('refuses to deliver a result whose plugin is gone, without calling the work', async () => {
      const { session, installations } = await withResult();
      await installations.setEnabled(TOOLS_PACKAGE_ID, false);
      const work = vi.fn(async () => 'written');
      expect(await session.deliver(work)).toEqual({ status: 'stale' });
      expect(work).not.toHaveBeenCalled();
    });

    it('re-checks before each step: a change mid-delivery stops the write', async () => {
      const { session, installations } = await withResult();
      const written: string[] = [];
      const delivery = session.deliver(async (_value, check) => {
        check();
        await Promise.resolve();
        await installations.setEnabled(TOOLS_PACKAGE_ID, false);
        check(); // throws: nothing below runs
        written.push('file');
        return 'written';
      });
      expect(await delivery).toEqual({ status: 'stale' });
      expect(written).toEqual([]);
    });

    it('aborts the delivery signal when the package changes during it', async () => {
      const { session, installations } = await withResult();
      let aborted = false;
      const delivery = session.deliver(async (_value, check, signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => ((aborted = true), resolve()));
          void installations.remove(TOOLS_PACKAGE_ID);
        });
        check(); // the work's own guard: it must not go on to write
        return 'done';
      });
      expect((await delivery).status).toBe('stale');
      expect(aborted).toBe(true);
    });

    it('keeps an independent file result valid across draft edits until a target is named', async () => {
      const { session } = await withResult();
      // The image result is independent of the open project: editing it changes nothing.
      edit();
      expect(session.result()).not.toBeNull();
      const target = {
        expected: { shaderId: 'waves', fingerprint: 'fp1:old' },
        current: () => ({ shaderId: 'waves', fingerprint: 'fp1:old' }),
      };
      expect((await session.deliver(async () => 'assigned', target)).status).toBe('delivered');
      // An assignment aimed at a draft that has since changed is refused.
      const moved = { ...target, current: () => ({ shaderId: 'waves', fingerprint: 'fp1:new' }) };
      const work = vi.fn(async () => 'assigned');
      expect(await session.deliver(work, moved)).toEqual({ status: 'stale' });
      expect(work).not.toHaveBeenCalled();
      // A change of target during the delivery stops it at the next check.
      let live = 'fp1:old';
      const mid = await session.deliver(
        async (_value, check) => {
          live = 'fp1:new';
          check();
          return 'late';
        },
        { expected: target.expected, current: () => ({ shaderId: 'waves', fingerprint: live }) },
      );
      expect(mid).toEqual({ status: 'stale' });
    });

    it('invalidates an independent result when its plugin changes', async () => {
      const { session, installations } = await withResult();
      expect(session.result()).not.toBeNull();
      await installations.setEnabled(TOOLS_PACKAGE_ID, false);
      expect(session.result()).toBeNull();
      expect(session.stale()).toBe(true);
    });
  });

  describe('templates', () => {
    it('instantiates a copy with fresh identities and refuses once the package changes', async () => {
      const { tools, installations } = setup();
      await install(installations);
      const first = tools.instantiate(TOOLS_PACKAGE_ID, 'trails')!;
      const second = tools.instantiate(TOOLS_PACKAGE_ID, 'trails')!;
      const ids = (payload: typeof first) => payload.project.passes.map((pass) => pass.id);
      expect(new Set([...ids(first), ...ids(second)]).size).toBe(6);
      const buffer = first.project.passes.find((pass) => pass.kind === 'buffer')!;
      expect(buffer.channels[0]).toEqual({ kind: 'buffer', passId: buffer.id, feedback: true });

      const context = installations.context(TOOLS_PACKAGE_ID);
      expect(tools.instantiate(TOOLS_PACKAGE_ID, 'trails', context)).not.toBeNull();
      await installations.setEnabled(TOOLS_PACKAGE_ID, false);
      expect(tools.instantiate(TOOLS_PACKAGE_ID, 'trails', context)).toBeNull();
      expect(tools.instantiate(TOOLS_PACKAGE_ID, 'trails')).toBeNull();
    });

    it('keeps the package copy intact however many instances are made', async () => {
      const { tools, installations } = setup();
      await install(installations);
      const entry = tools.templates()[0]!;
      const plugin: PluginPackage = entry.installed.plugin!;
      const before = JSON.stringify(plugin.templates);
      tools.instantiate(TOOLS_PACKAGE_ID, 'trails')!.project.passes[0]!.source = 'mutated';
      expect(JSON.stringify(plugin.templates)).toBe(before);
    });
  });
});
