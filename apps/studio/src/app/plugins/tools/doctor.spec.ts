import { PLATFORM_ID, computed, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Router } from '@angular/router';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_CHANNELS,
  DEFAULT_RENDER,
  createVignetteEffect,
  type RenderSettings,
  type ShaderControl,
  type TextureChannels,
} from '@shadergrove/shared/model';
import {
  CAPABILITY_PROFILES,
  WALLPAPER_WEB_LIMITS,
  parsePluginPackage,
  type AnalyzerInput,
  type AnalyzerReport,
  type CapabilityProfile,
  type CapabilityProfileId,
  type PluginPackage,
  type ProjectExportInput,
  type ResourceState,
} from '@shadergrove/shared/plugin';
import {
  BUFFER_SLOTS,
  DEFAULT_VERTEX,
  addBuffer,
  bufferPasses,
  createProject,
  imagePass,
  setChannelBinding,
  setPassEnabled,
  type ShaderProject,
} from '@shadergrove/shared/project';
import { AuthService } from '../../auth/auth.service';
import { DesktopPlatform } from '../../desktop/desktop-platform';
import { EditorNavigation } from '../../editor/editor-navigation';
import { I18n } from '../../i18n/i18n';
import { RendererHandle } from '../../rendering/renderer-handle';
import type { ShaderEngine } from '../../rendering/shader-engine';
import { AppThemes } from '../../themes/app-themes';
import { WorkspaceActions } from '../../ui/workspace-actions';
import { ShaderStore } from '../../workspace/shader-store';
import { EffectAdoption } from '../effect-adoption';
import { PluginHost, type SandboxHandle } from '../plugin-host';
import { PLUGIN_STORE, PluginInstallations } from '../plugin-installations';
import type { StoredPlugin } from '../plugin-store';
import { PluginTools, TOOL_ADAPTERS } from '../plugin-tools';
import { inProcessStart } from '../testing/in-process-sandbox';
import { newRecord, recordingStart } from '../testing/tool-fixtures';
import { ShaderDoctorAdapter } from './doctor';
import { DoctorPanel } from './doctor-panel';
import { doctorSlotStates } from './doctor-source';

/**
 * AC-DOCTOR and AC-LIFECYCLE for Shader Doctor: the official package as the
 * generator builds it, run through the real `PluginHost` (and its report
 * validation) against the registered capability profiles; the host's
 * observation of texture load outcomes; and the panel's report lifecycle —
 * target switches, edits and texture changes while a report runs or shows,
 * navigation, and the compiler's diagnostics left alone.
 */
const root = resolve(import.meta.dirname, '../../../../../..');
const packageText = (folder: string): string => {
  const manifest = JSON.parse(
    readFileSync(resolve(root, `plugins/official/${folder}/manifest.json`), 'utf8'),
  ) as { id: string; version: string };
  return readFileSync(
    resolve(root, `apps/studio/src/plugins/${manifest.id}-${manifest.version}.sgplugin.json`),
    'utf8',
  );
};
const load = (folder: string): PluginPackage => {
  const parsed = parsePluginPackage(packageText(folder));
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return parsed.value;
};
const doctor = load('shader-doctor');
const DOCTOR_ID = doctor.manifest.id;

const IMAGE = 'void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }';

/** A feedback buffer, the Image pass sampling it and texture slot 0, all wired correctly. */
function feedbackProject(): ShaderProject {
  let project = addBuffer(createProject(IMAGE, DEFAULT_VERTEX));
  const buffer = bufferPasses(project)[0]!;
  const image = imagePass(project);
  project = setChannelBinding(project, buffer.id, 0, {
    kind: 'buffer',
    passId: buffer.id,
    feedback: true,
  });
  project = setChannelBinding(project, image.id, 0, {
    kind: 'buffer',
    passId: buffer.id,
    feedback: false,
  });
  project = setChannelBinding(project, image.id, 1, { kind: 'texture', slot: 0 });
  project = setChannelBinding(project, image.id, 2, { kind: 'none' });
  return setChannelBinding(project, image.id, 3, { kind: 'none' });
}

const channel = (state: ResourceState) => ({
  ...DEFAULT_CHANNELS[0],
  ext: state === 'empty' ? null : 'png',
  width: state === 'empty' ? 0 : 8,
  height: state === 'empty' ? 0 : 8,
  present: state !== 'empty',
  state,
});

function request(
  project: ShaderProject,
  states: ResourceState[] = ['loaded', 'empty', 'empty', 'empty'],
  render: RenderSettings = DEFAULT_RENDER,
) {
  return {
    name: 'Doctor fixture',
    project,
    controls: [] as ShaderControl[],
    params: {},
    render,
    channels: states.map(channel),
    postProcessingActive:
      render.postProcessing.enabled && render.postProcessing.effects.some((e) => e.enabled),
  };
}

const VIGNETTE: RenderSettings = {
  postProcessing: { enabled: true, effects: [createVignetteEffect({ enabled: true })] },
};

async function check(
  profileId: CapabilityProfileId,
  snapshot: ReturnType<typeof request>,
): Promise<AnalyzerReport> {
  const host = new PluginHost(doctor, { start: inProcessStart(doctor.code!) });
  return host.analyze('doctor', { ...snapshot, profileId, revision: 'fp1:test' });
}

const rules = (report: AnalyzerReport, ruleId: string) =>
  report.findings.filter((finding) => finding.ruleId === ruleId);

describe('Shader Doctor package', () => {
  it('passes a supported feedback project on both targets and says what it did not check', async () => {
    for (const profileId of ['studio-webgl2/v1', 'wallpaper-web/v1'] as const) {
      const report = await check(profileId, request(feedbackProject()));
      expect(report).toMatchObject({ profile: profileId, targetVersion: 1, revision: 'fp1:test' });
      expect(report.findings).toEqual([]);
      expect(report.checkedRules).toEqual(
        expect.arrayContaining(['features.feedback', 'bindings.buffer', 'resources.texture']),
      );
      // The GLSL itself is never read: no portability or source verdict is claimed.
      expect(report.uncheckedRules).toEqual([
        'limits.source',
        'source.portability',
        'limits.files',
        'limits.textures',
      ]);
    }
  });

  it('reports post-processing as unsupported on the Wallpaper target only, as its exporter does', async () => {
    const studio = await check('studio-webgl2/v1', request(feedbackProject(), undefined, VIGNETTE));
    expect(rules(studio, 'features.post-processing')).toEqual([]);

    const wallpaper = await check(
      'wallpaper-web/v1',
      request(feedbackProject(), undefined, VIGNETTE),
    );
    expect(rules(wallpaper, 'features.post-processing')).toEqual([
      expect.objectContaining({
        severity: 'error',
        confidence: 'certain',
        coverage: 'structural',
        targetVersion: 1,
        message: expect.stringContaining('Vignette'),
      }),
    ]);

    // The executable adapter agrees: the Wallpaper exporter renders without the chain and says so.
    const exporter = load('wallpaper-engine');
    const host = new PluginHost(exporter, { start: inProcessStart(exporter.code!) });
    const snapshot = request(feedbackProject(), undefined, VIGNETTE);
    const exported = await host.exportProject('wallpaper-engine', {
      name: snapshot.name,
      project: snapshot.project,
      controls: snapshot.controls,
      params: snapshot.params,
      channels: snapshot.channels.map(({ state: _state, ...meta }) => meta),
      postProcessingActive: true,
    } satisfies ProjectExportInput);
    expect(exported.warnings.join(' ')).toContain('Post-processing is not included');
  });

  it('keeps the profiles in step with what the renderer and the Wallpaper exporter execute', () => {
    const studio = CAPABILITY_PROFILES['studio-webgl2/v1'];
    const wallpaper = CAPABILITY_PROFILES['wallpaper-web/v1'];
    // The exporter's own schema limit is the profile's; the editor never draws more passes.
    expect(wallpaper.limits.passes).toBe(WALLPAPER_WEB_LIMITS.passes);
    expect(BUFFER_SLOTS.length + 1).toBeLessThanOrEqual(wallpaper.limits.passes);
    expect(BUFFER_SLOTS.length + 1).toBeLessThanOrEqual(studio.limits.passes);
    expect(wallpaper.limits.controls).toBe(WALLPAPER_WEB_LIMITS.uniforms);
    expect([studio.features, wallpaper.features]).toEqual([
      { commonPass: true, feedback: true, postProcessing: true, textures: true },
      { commonPass: true, feedback: true, postProcessing: false, textures: true },
    ]);
    // Profile ids are the analyzer's own declaration; nothing else is registered.
    expect(doctor.manifest.contributions).toEqual([
      expect.objectContaining({ kind: 'analyzer', profiles: Object.keys(CAPABILITY_PROFILES) }),
    ]);
  });

  it('exports a feedback project to Wallpaper Engine, so feedback is no Wallpaper finding', async () => {
    const exporter = load('wallpaper-engine');
    const host = new PluginHost(exporter, { start: inProcessStart(exporter.code!) });
    const snapshot = request(feedbackProject());
    const exported = await host.exportProject('wallpaper-engine', {
      name: snapshot.name,
      project: snapshot.project,
      controls: [],
      params: {},
      channels: snapshot.channels.map(({ state: _state, ...meta }) => meta),
      postProcessingActive: false,
    });
    const passes = (exported.data as { passes: { channels: { feedback?: boolean }[] }[] }).passes;
    expect(passes.some((pass) => pass.channels.some((binding) => binding.feedback))).toBe(true);
  });

  it('judges texture slots only by observed load outcomes, grouping the empty ones', async () => {
    // The default project binds iChannel0–3 to slots 0–3.
    const project = createProject(IMAGE, DEFAULT_VERTEX);
    const image = imagePass(project).id;
    for (const profileId of ['studio-webgl2/v1', 'wallpaper-web/v1'] as const) {
      const report = await check(
        profileId,
        request(project, ['empty', 'failed', 'loading', 'unknown']),
      );
      const textures = rules(report, 'resources.texture');
      expect(textures.map((finding) => [finding.severity, finding.coverage])).toEqual([
        ['warning', 'unchecked'], // failed: surfaced, never a pass, and no verdict either
        ['warning', 'structural'], // the empty slot: a placeholder on purpose, intent unknown
        ['info', 'unchecked'], // loading
        ['info', 'unchecked'], // never observed
      ]);
      expect(textures[1]!).toMatchObject({ confidence: 'possible' });
      expect(textures.map((finding) => finding.location)).toEqual([
        { kind: 'binding', passId: image, channel: 1 },
        { kind: 'binding', passId: image, channel: 0 },
        { kind: 'binding', passId: image, channel: 2 },
        { kind: 'binding', passId: image, channel: 3 },
      ]);
    }
    // Every slot empty — the default for a new shader — is one warning, not four errors.
    const fresh = await check('studio-webgl2/v1', request(project, Array(4).fill('empty')));
    expect(fresh.findings).toEqual([
      expect.objectContaining({
        severity: 'warning',
        message: expect.stringContaining('0, 1, 2, 3'),
      }),
    ]);
    // Loaded is the only other verdict, and passes.
    const loaded = await check('studio-webgl2/v1', request(project, Array(4).fill('loaded')));
    expect(loaded.findings).toEqual([]);
  });

  it('reports unresolved pass bindings at the binding as warnings, never as fatal errors', async () => {
    let project = feedbackProject();
    const buffer = bufferPasses(project)[0]!.id;
    project = setPassEnabled(project, buffer, false);
    const image = imagePass(project).id;
    const studio = await check('studio-webgl2/v1', request(project));
    const wallpaper = await check('wallpaper-web/v1', request(project));
    for (const report of [studio, wallpaper]) {
      expect(rules(report, 'bindings.buffer')).toEqual([
        expect.objectContaining({
          severity: 'warning',
          location: { kind: 'binding', passId: image, channel: 0 },
          message: expect.stringContaining('disabled'),
        }),
      ]);
      expect(report.findings.some((finding) => finding.severity === 'error')).toBe(false);
      // Structural findings point at bindings; no line is ever made up.
      expect(report.findings.every((finding) => finding.location?.kind !== 'pass')).toBe(true);
    }
    expect(rules(wallpaper, 'bindings.buffer')[0]!.message).toContain('export refuses');
    expect(rules(studio, 'bindings.buffer')[0]!.message).not.toContain('export');
  });

  it('flags every known unsupported feature of a profile that lacks them', async () => {
    // Not a registered profile — the host would refuse it — so the handler is called directly.
    const handle: SandboxHandle = await inProcessStart(doctor.code!)();
    let project = feedbackProject();
    project = {
      ...project,
      passes: project.passes.map((pass) =>
        pass.kind === 'common' ? { ...pass, source: 'float shared() { return 1.0; }' } : pass,
      ),
    };
    const bare: CapabilityProfile = {
      ...CAPABILITY_PROFILES['studio-webgl2/v1'],
      name: 'Bare',
      limits: { ...CAPABILITY_PROFILES['studio-webgl2/v1'].limits, passes: 1, controls: 0 },
      features: { commonPass: false, feedback: false, postProcessing: false, textures: false },
    };
    const input: AnalyzerInput = {
      ...request(project, undefined, VIGNETTE),
      controls: [{ key: 'speed', type: 'number', default: 1, min: 0, max: 2 }],
      profile: bare,
      revision: 'fp1:bare',
    };
    const report = (await handle.call('analyzer:doctor', input)) as AnalyzerReport;
    const errors = report.findings.filter((finding) => finding.severity === 'error');
    expect(errors.map((finding) => finding.ruleId).sort()).toEqual([
      'features.common',
      'features.feedback',
      'features.post-processing',
      'limits.controls',
      'limits.passes',
      'resources.texture',
    ]);
    expect(errors.every((finding) => finding.coverage === 'structural')).toBe(true);
    // Errors first.
    expect(report.findings[0]!.severity).toBe('error');
  });
});

describe('doctorSlotStates', () => {
  const placeholder = { image: { width: 1 } };
  const image = { image: { width: 64 } };
  const project = createProject(IMAGE, DEFAULT_VERTEX); // binds slot n at iChannel n
  const assigned: TextureChannels = [0, 1, 2, 3].map(() => ({
    ...DEFAULT_CHANNELS[0],
    ext: 'png',
  })) as unknown as TextureChannels;

  function engine(
    states: ('empty' | 'loading' | 'failed' | 'ready')[],
    bound: unknown[],
    slots: unknown[] = [{}, {}, {}, {}],
  ): ShaderEngine {
    return {
      // As the engine's TextureManager: a slot it holds nothing for is `empty`.
      textureSlotState: (slot: number) => (slots[slot] == null ? 'empty' : states[slot]),
      isPlaceholderTexture: (texture: unknown) => texture === placeholder,
      passChannelTexture: (_pass: string, index: number) => bound[index] ?? null,
    } as unknown as ShaderEngine;
  }

  it('calls a slot without an image empty, whatever the preview holds', () => {
    expect(doctorSlotStates(DEFAULT_CHANNELS, project, null)).toEqual(Array(4).fill('empty'));
  });

  it('leaves a slot the preview has not observed unknown', () => {
    expect(doctorSlotStates(assigned, project, null)).toEqual(Array(4).fill('unknown'));
    // Not handed to the renderer yet (its URL is still resolving, or failed to).
    const pending = engine(['ready', 'ready', 'ready', 'ready'], [image, image, image, image], []);
    expect(doctorSlotStates(assigned, project, pending)).toEqual(Array(4).fill('unknown'));
  });

  it('reports the preview’s own outcome, and loaded only for a decoded image a pass samples', () => {
    const observed = engine(
      ['loading', 'failed', 'ready', 'ready'],
      [null, null, image, placeholder],
    );
    expect(doctorSlotStates(assigned, project, observed)).toEqual([
      'loading',
      'failed',
      'loaded',
      'unknown', // `ready` but nothing decoded behind any binding: never resolved
    ]);
  });
});

describe('Shader Doctor panel', () => {
  const user = signal<{ id: string } | null>(null);
  const status = signal<'loading' | 'anonymous' | 'authenticated'>('anonymous');
  const selectedId = signal<string | null>('waves');
  const draft = signal<{ project: ShaderProject; render: RenderSettings }>({
    project: feedbackProject(),
    render: DEFAULT_RENDER,
  });
  const controls = signal<ShaderControl[]>([]);
  const params = signal({});
  const record = signal<{ id: string; name: string } | null>({ id: 'waves', name: 'Waves' });
  const channels = signal<TextureChannels>(DEFAULT_CHANNELS);
  const diagnostics = signal([{ message: 'compiler says no', line: 3 }]);
  const notice = signal(null);
  const engine = signal<ShaderEngine | null>(null);
  const navigateByUrl = vi.fn(async () => true);
  let profiles: Map<string, Map<string, StoredPlugin>>;
  let hold: Promise<void> | null;
  let release: () => void;

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
        { provide: AuthService, useValue: { user, status } },
        { provide: DesktopPlatform, useValue: { available: false } },
        {
          provide: I18n,
          useValue: {
            t: (key: string, values?: Record<string, unknown>) =>
              values ? `${key} ${JSON.stringify(values)}` : key,
            languages: signal([]),
            label: () => '',
            select: () => undefined,
          },
        },
        { provide: WorkspaceActions, useValue: {} },
        {
          provide: ShaderStore,
          useValue: {
            selectedId,
            draft,
            controls,
            params,
            record,
            channels,
            diagnostics,
            notice,
          },
        },
        { provide: RendererHandle, useValue: { engine } },
        { provide: AppThemes, useValue: { entries: signal([]), pairs: computed(() => []) } },
        { provide: EffectAdoption, useValue: { adopt: () => ({ ok: true }) } },
        { provide: Router, useValue: { navigate: vi.fn(), navigateByUrl } },
        { provide: PLATFORM_ID, useValue: 'browser' },
        { provide: TOOL_ADAPTERS, useClass: ShaderDoctorAdapter, multi: true },
      ],
    });
    const installations = TestBed.inject(PluginInstallations);
    const sandbox = newRecord();
    vi.spyOn(installations, 'host').mockImplementation((id) => {
      const installed = installations.find(id);
      if (!installed?.active || !installed.plugin) return null;
      const start = recordingStart(installed.plugin, sandbox);
      return new PluginHost(installed.plugin, {
        // A held call answers only once released: a report that arrives late.
        start: async (...args) => {
          const handle = await start(...args);
          return {
            ...handle,
            call: async (...args: Parameters<SandboxHandle['call']>) => {
              if (hold) await hold;
              return handle.call(...args);
            },
          };
        },
      });
    });
    return { tools: TestBed.inject(PluginTools), installations };
  }

  async function settle(fixture?: ComponentFixture<DoctorPanel>): Promise<void> {
    for (let i = 0; i < 4; i++) {
      TestBed.tick();
      for (let j = 0; j < 8; j++) await Promise.resolve();
      await new Promise((done) => setTimeout(done));
    }
    fixture?.detectChanges();
  }

  async function mount() {
    const { tools, installations } = setup();
    await settle();
    const review = installations.review(new TextEncoder().encode(packageText('shader-doctor')));
    if (!review.ok) throw new Error(review.errors.join());
    await installations.install(review);
    await installations.setEnabled(DOCTOR_ID, true);
    await settle();
    const session = tools.openSession(DOCTOR_ID, 'doctor');
    if (!session) throw new Error('Shader Doctor is not offered');
    const fixture = TestBed.createComponent(DoctorPanel);
    fixture.componentRef.setInput('session', session);
    await settle(fixture);
    return { fixture, tools };
  }

  const el = (fixture: ComponentFixture<DoctorPanel>) => fixture.nativeElement as HTMLElement;
  const findings = (fixture: ComponentFixture<DoctorPanel>) =>
    [...el(fixture).querySelectorAll<HTMLElement>('[data-testid="doctor-finding"]')].map(
      (item) => item.dataset['rule'],
    );
  const summary = (fixture: ComponentFixture<DoctorPanel>) =>
    el(fixture).querySelector('[data-testid="doctor-summary"]')?.textContent ?? '';
  const click = (fixture: ComponentFixture<DoctorPanel>, id: string) =>
    el(fixture).querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!.click();
  const target = (fixture: ComponentFixture<DoctorPanel>, value: string) => {
    const select = el(fixture).querySelector<HTMLSelectElement>('[data-testid="doctor-target"]')!;
    select.value = value;
    select.dispatchEvent(new Event('change'));
  };
  const holdCalls = () => (hold = new Promise<void>((done) => (release = done)));

  beforeEach(() => {
    profiles = new Map();
    hold = null;
    selectedId.set('waves');
    record.set({ id: 'waves', name: 'Waves' });
    draft.set({ project: feedbackProject(), render: VIGNETTE });
    channels.set(DEFAULT_CHANNELS);
    engine.set(null);
    navigateByUrl.mockClear();
  });

  afterEach(() => {
    release?.();
    TestBed.resetTestingModule();
  });

  it('checks the draft on the chosen target and retires the old target’s report at once', async () => {
    const { fixture } = await mount();
    click(fixture, 'doctor-run');
    await settle(fixture);
    expect(summary(fixture)).toContain('"target":"doctor.profileStudio (v1)"');
    expect(findings(fixture)).toEqual(['resources.texture']); // slot 0 bound but empty

    holdCalls();
    target(fixture, 'wallpaper-web/v1');
    await settle(fixture);
    // The Studio report is gone while the Wallpaper one is still under way.
    expect(findings(fixture)).toEqual([]);
    expect(el(fixture).querySelector('[data-testid="doctor-running"]')).not.toBeNull();
    release();
    await settle(fixture);
    expect(summary(fixture)).toContain('doctor.profileWallpaper (v1)');
    expect(findings(fixture)).toEqual(['features.post-processing', 'resources.texture']);
  });

  it('drops a delayed report when the draft is edited while it runs', async () => {
    const { fixture } = await mount();
    holdCalls();
    click(fixture, 'doctor-run');
    await settle(fixture);
    draft.update((current) => ({ ...current, render: DEFAULT_RENDER }));
    release();
    await settle(fixture);
    expect(findings(fixture)).toEqual([]);
    expect(el(fixture).querySelector('[data-testid="doctor-summary"]')).toBeNull();
    expect(el(fixture).querySelector('[data-testid="doctor-error"]')).toBeNull();
  });

  it('retires a report when a texture is assigned or its load outcome changes', async () => {
    const { fixture } = await mount();
    click(fixture, 'doctor-run');
    await settle(fixture);
    expect(findings(fixture)).toEqual(['resources.texture']);
    channels.set([{ ...DEFAULT_CHANNELS[0], ext: 'png' }, ...DEFAULT_CHANNELS.slice(1)] as never);
    await settle(fixture);
    expect(findings(fixture)).toEqual([]);
    expect(el(fixture).querySelector('[data-testid="doctor-stale"]')).not.toBeNull();

    // Checked again: never observed loading, so not checked …
    click(fixture, 'doctor-run');
    await settle(fixture);
    const finding = el(fixture).querySelector<HTMLElement>('[data-testid="doctor-finding"]')!;
    expect(finding.dataset['coverage']).toBe('unchecked');
    // … until the preview has the image decoded: the load changes what the report means.
    const image = imagePass(draft().project).id;
    engine.set({
      textureSlotState: () => 'ready',
      isPlaceholderTexture: () => false,
      passChannelTexture: (pass: string, index: number) =>
        pass === image && index === 1 ? { image: { width: 8 } } : null,
    } as unknown as ShaderEngine);
    await new Promise((done) => setTimeout(done, 1100));
    await settle(fixture);
    expect(el(fixture).querySelector('[data-testid="doctor-stale"]')).not.toBeNull();
    click(fixture, 'doctor-run');
    await settle(fixture);
    expect(el(fixture).querySelector('[data-testid="doctor-clean"]')).not.toBeNull();
  });

  it('opens the pass of a binding finding in the editor and leaves compiler diagnostics alone', async () => {
    const { fixture } = await mount();
    const navigation = TestBed.inject(EditorNavigation);
    const before = diagnostics();
    click(fixture, 'doctor-run');
    await settle(fixture);
    click(fixture, 'doctor-show');
    await settle(fixture);
    expect(navigateByUrl).toHaveBeenCalledWith('/');
    expect(navigation.request()).toMatchObject({ docId: imagePass(draft().project).id, line: 0 });
    expect(diagnostics()).toBe(before);
  });

  it('needs an open shader', async () => {
    record.set(null);
    selectedId.set(null);
    const { fixture } = await mount();
    expect(el(fixture).querySelector('[data-testid="doctor-no-shader"]')).not.toBeNull();
    expect(
      el(fixture).querySelector<HTMLButtonElement>('[data-testid="doctor-run"]')!.disabled,
    ).toBe(true);
  });
});
