import { computed, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  parsePluginPackage,
  validatePalette,
  type AssetToolOutput,
  type AssetToolRequest,
  type GradientInterpolation,
  type GradientStop,
  type PaletteData,
} from '@shadergrove/shared/plugin';
import { LIMITS } from '@shadergrove/shared/validate';

import { AuthService } from '../../auth/auth.service';
import { DesktopPlatform } from '../../desktop/desktop-platform';
import { I18n } from '../../i18n/i18n';
import { RendererHandle } from '../../rendering/renderer-handle';
import { ShaderStore } from '../../workspace/shader-store';
import { EffectAdoption } from '../effect-adoption';
import { PluginHost } from '../plugin-host';
import { PLUGIN_STORE, PluginInstallations } from '../plugin-installations';
import type { StoredPlugin } from '../plugin-store';
import { PluginTools, provideToolAdapters, type ToolSession } from '../plugin-tools';
import { PluginToolsOutlet } from '../plugin-tools-outlet';
import { inProcessStart } from '../testing/in-process-sandbox';
import { newRecord, recordingStart, type SandboxRecord } from '../testing/tool-fixtures';
import {
  DEFAULT_PALETTE,
  PALETTE_FILE_BYTES,
  addStop,
  applyPaletteEffect,
  effectRequest,
  evenStops,
  extractRequest,
  gradientCss,
  gradientSamples,
  moveStop,
  paletteJson,
  parsePaletteJson,
  removeStop,
  setStopPosition,
  sortStops,
  validatePaletteSettings,
  visiblePixels,
} from './palette';
import { PaletteStudioAdapter, PaletteTool } from './palette-adapter';
import { alphaPlane, fixturePlane, solidPlane } from './textures-fixtures';

/**
 * AC-PALETTE and AC-LIFECYCLE for Palette Studio: the shipped Worker bundle run
 * through the real `PluginHost` (in-process: jsdom has no Worker) with the real
 * input/output validators, the host's editor and JSON rules, and the sessions
 * behind the real installations.
 */
const ID = 'dev.shadergrove.palette-studio';
const FILE = `${ID}-1.0.0.sgplugin.json`;

/** The official package text, as `pnpm gen:plugins` writes it. */
function paletteStudioText(): string {
  for (let dir = import.meta.dirname; dir !== dirname(dir); dir = dirname(dir)) {
    const file = resolve(dir, 'src/plugins', FILE);
    if (existsSync(file)) return readFileSync(file, 'utf8');
  }
  throw new Error(`No generated ${FILE} above ${import.meta.dirname}`);
}

const parsed = parsePluginPackage(paletteStudioText());
if (!parsed.ok) throw new Error(parsed.errors.join('; '));
const plugin = parsed.value;
const host = () => new PluginHost(plugin, { start: inProcessStart(plugin.code!) });
const run = (request: AssetToolRequest): Promise<AssetToolOutput> =>
  host().runAssetTool('palette-studio', request);

async function extract(plane: Parameters<typeof extractRequest>[0], count = 8, threshold = 128) {
  const output = await run(extractRequest(plane, { count, alphaThreshold: threshold }));
  if (output.kind !== 'palette') throw new Error('expected a palette');
  return output;
}

const gradient = (
  interpolation: GradientInterpolation,
  stops: GradientStop[],
  name = 'Test',
): PaletteData => ({
  format: 'shadergrove-palette/v1',
  name,
  colors: [],
  gradient: { interpolation, stops },
});
const BLACK_WHITE: GradientStop[] = [
  { position: 0, color: '#000000' },
  { position: 1, color: '#ffffff' },
];

async function effectOf(palette: PaletteData, adjustments: ('contrast' | 'shift')[] = []) {
  const output = await run(effectRequest(palette, { strength: 1, adjustments }));
  if (output.kind !== 'effect') throw new Error('expected an effect');
  return output;
}

/** A deterministic, noisy colour image with some transparency. */
const noisy = () => {
  let seed = 12345;
  const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 24;
  return fixturePlane(64, 64, () => [next(), next(), next(), next() < 32 ? 0 : 255], {
    usage: 'color',
  });
};

describe('palette extraction (Worker)', () => {
  it('returns the distinct colours, heaviest first, and a lightness-ordered gradient suggestion', async () => {
    // Red covers two texels, green, blue and white one each.
    const plane = fixturePlane(
      5,
      1,
      (x) =>
        (
          [
            [255, 0, 0, 255],
            [0, 255, 0, 255],
            [255, 0, 0, 255],
            [0, 0, 255, 255],
            [255, 255, 255, 255],
          ] as const
        )[x]!,
    );
    const { palette, metadata } = await extract(plane, 4);
    // Equal weights list darker first.
    expect(palette.colors).toEqual(['#ff0000', '#0000ff', '#00ff00', '#ffffff']);
    expect(metadata['weights']).toEqual([0.4, 0.2, 0.2, 0.2]);
    // Oklab L: blue 0.45 < red 0.63 < green 0.87 < white 1.
    expect(palette.gradient).toEqual({
      interpolation: 'oklab',
      stops: [
        { position: 0, color: '#0000ff' },
        { position: 0.3333, color: '#ff0000' },
        { position: 0.6667, color: '#00ff00' },
        { position: 1, color: '#ffffff' },
      ],
    });
  });

  it('ignores pixels under the alpha threshold and weighs the rest by alpha', async () => {
    const strict = await extract(alphaPlane(), 8, 128);
    // The four opaque colours weigh 1 each; the 128-alpha brown 0.502; alpha 64/1/0 are ignored.
    expect(strict.palette.colors).toEqual(['#0000ff', '#ff0000', '#00ff00', '#ffffff', '#c86432']);
    expect(strict.metadata).toMatchObject({ visiblePixels: 5, ignoredPixels: 3 });
    const loose = await extract(alphaPlane(), 8, 1);
    expect(loose.palette.colors).toHaveLength(7);
    expect(loose.palette.colors).not.toContain('#4d5863');
    expect(loose.metadata).toMatchObject({ visiblePixels: 7, ignoredPixels: 1 });

    // Three half-transparent texels outweigh one opaque one.
    const heavy = fixturePlane(4, 1, (x) => (x === 0 ? [0, 0, 0, 255] : [255, 255, 255, 128]));
    expect((await extract(heavy, 4, 1)).palette.colors).toEqual(['#ffffff', '#000000']);
  });

  it('is reproducible and bounded: the same image gives the same 4–8 colours every time', async () => {
    const first = await extract(noisy(), 6, 128);
    const second = await extract(noisy(), 6, 128);
    expect(second).toEqual(first);
    expect(first.palette.colors).toHaveLength(6);
    expect(first.palette.gradient!.stops).toHaveLength(6);
    expect(first.metadata['iterations']).toBeLessThanOrEqual(32);
    const four = await extract(noisy(), 4, 128);
    expect(four.palette.colors).toHaveLength(4);
    expect(validatePalette(four.palette).ok).toBe(true);
  });

  it('gives one colour twice as the gradient of a single-colour image', async () => {
    const { palette } = await extract(solidPlane(3, 3, [12, 34, 56, 255]), 4);
    expect(palette.colors).toEqual(['#0c2238']);
    expect(palette.gradient!.stops).toEqual([
      { position: 0, color: '#0c2238' },
      { position: 1, color: '#0c2238' },
    ]);
  });

  it('refuses a fully transparent image (the host says so first, before any Worker)', async () => {
    const clear = solidPlane(4, 4, [255, 0, 0, 0]);
    expect(visiblePixels(clear, 1)).toBe(0);
    expect(visiblePixels(alphaPlane(), 64)).toBe(6);
    await expect(run(extractRequest(clear, { count: 4, alphaThreshold: 1 }))).rejects.toThrow(
      /No visible pixels/,
    );
  });
});

describe('palette conversions and the generated effect (Worker)', () => {
  it('converts sRGB to Oklab by the reference vectors', async () => {
    const { metadata } = await effectOf(
      gradient('oklab', [
        { position: 0, color: '#ff0000' },
        { position: 0.5, color: '#00ff00' },
        { position: 1, color: '#0000ff' },
      ]),
    );
    const values = (metadata['stops'] as { value: number[] }[]).map((stop) => stop.value);
    const expected = [
      [0.627955, 0.224863, 0.125846],
      [0.86644, -0.233888, 0.179498],
      [0.452014, -0.032457, -0.311528],
    ];
    values.forEach((value, index) =>
      value.forEach((component, axis) => expect(component).toBeCloseTo(expected[index]![axis]!, 5)),
    );
  });

  it.each([
    ['srgb', '#808080'],
    ['linear', '#bcbcbc'],
    ['oklab', '#636363'],
  ] as const)('interpolates black to white in %s: ends exact, middle %s', async (space, middle) => {
    const samples = gradientSamples(await effectOf(gradient(space, BLACK_WHITE)))!;
    expect(samples).toHaveLength(33);
    expect(samples[0]).toBe('#000000');
    expect(samples[16]).toBe(middle);
    expect(samples[32]).toBe('#ffffff');
  });

  it('keeps the colours exact at stops and outside them, and clips to the sRGB gamut', async () => {
    const samples = gradientSamples(
      await effectOf(
        gradient('oklab', [
          { position: 0.25, color: '#123456' },
          { position: 0.75, color: '#fedcba' },
        ]),
      ),
    )!;
    expect(samples.slice(0, 9)).toEqual(Array(9).fill('#123456'));
    expect(samples.slice(24)).toEqual(Array(9).fill('#fedcba'));
    // Blue to yellow through Oklab leaves the cube; every sample is still a valid sRGB byte triple.
    const wide = gradientSamples(
      await effectOf(
        gradient('oklab', [
          { position: 0, color: '#0000ff' },
          { position: 1, color: '#ffff00' },
        ]),
      ),
    )!;
    expect(wide.every((sample) => /^#[0-9a-f]{6}$/.test(sample))).toBe(true);
  });

  it('makes a hard edge at equal positions: the stop listed first ends the part below', async () => {
    const samples = gradientSamples(
      await effectOf(
        gradient('srgb', [
          { position: 0, color: '#000000' },
          { position: 0.5, color: '#ff0000' },
          { position: 0.5, color: '#0000ff' },
          { position: 1, color: '#0000ff' },
        ]),
      ),
    )!;
    expect(samples[15]).not.toBe('#0000ff');
    expect(samples[16]).toBe('#ff0000');
    expect(samples[17]).toBe('#0000ff');
  });

  it('embeds the stops and the palette JSON in self-contained GLSL with only its own controls', async () => {
    const palette = gradient('linear', BLACK_WHITE, 'Café grade');
    const plain = (await effectOf(palette)).effect;
    expect(plain.name).toBe('Café grade');
    expect(plain.source).toContain('vec4 effect(vec4 color, vec2 uv)');
    expect(plain.source).not.toMatch(/sampler|texture|u_contrast|u_shift/);
    expect(plain.controls.map((control) => control.key)).toEqual(['strength']);
    expect(plain.values).toEqual({ strength: 1 });
    // ASCII only; the second line is the palette it was made from.
    expect(plain.source).toMatch(/^[\t\n -~]*$/);
    const authored = validatePalette(JSON.parse(plain.source.split('\n')[1]!.slice(3)));
    expect(authored).toEqual({ ok: true, value: palette });

    const adjusted = (await effectOf(palette, ['contrast', 'shift'])).effect;
    expect(adjusted.source).toContain('u_contrast');
    expect(adjusted.source).toContain('u_shift');
    expect(adjusted.values).toEqual({ strength: 1, contrast: 1, shift: 0 });
  });

  it('stays within the custom-effect source and control limits at the largest palette', async () => {
    const stops = Array.from({ length: 8 }, (_, index) => ({
      position: index / 7,
      color: `#${(index * 30).toString(16).padStart(2, '0')}80ff`,
    }));
    const { effect } = await effectOf(gradient('oklab', stops, 'x'.repeat(64)), [
      'contrast',
      'shift',
    ]);
    expect(effect.source.length).toBeLessThan(LIMITS.customEffectSourceLength);
    expect(effect.controls.length).toBeLessThanOrEqual(LIMITS.customEffectControlCount);
  });

  it('refuses an effect from a palette without a gradient', async () => {
    const colorsOnly: PaletteData = { ...gradient('srgb', BLACK_WHITE), gradient: undefined };
    delete colorsOnly.gradient;
    colorsOnly.colors = ['#000000'];
    await expect(run(effectRequest(colorsOnly, { strength: 1, adjustments: [] }))).rejects.toThrow(
      /needs a palette with a gradient/,
    );
  });
});

describe('palette settings, editor and JSON (host)', () => {
  it('validates both operations strictly and returns fresh copies', () => {
    expect(validatePaletteSettings('extract', { count: 4, alphaThreshold: 1 })).toEqual({
      ok: true,
      value: { count: 4, alphaThreshold: 1 },
    });
    const adjustments = ['shift'];
    const effect = validatePaletteSettings('effect', { name: ' P ', strength: 0.5, adjustments });
    expect(effect).toEqual({ ok: true, value: { name: 'P', strength: 0.5, adjustments } });
    expect(effect.ok && effect.value['adjustments']).not.toBe(adjustments);
    for (const [operation, settings] of [
      ['blur', {}],
      ['extract', { count: 3, alphaThreshold: 1 }],
      ['extract', { count: 9, alphaThreshold: 1 }],
      ['extract', { count: 4, alphaThreshold: 0 }],
      ['extract', { count: 4, alphaThreshold: 1, gamma: 2 }],
      ['effect', { name: 'P', strength: 1.5, adjustments: [] }],
      ['effect', { name: '', strength: 1, adjustments: [] }],
      ['effect', { name: 'P', strength: 1, adjustments: ['blur'] }],
      ['effect', { name: 'P', strength: 1, adjustments: ['shift', 'shift'] }],
    ] as const) {
      expect(validatePaletteSettings(operation, settings).ok).toBe(false);
    }
  });

  it('keeps stops in position order, stably, so equal positions keep their listed order', () => {
    const stops = [
      { position: 0.5, color: '#000001' },
      { position: 0.2, color: '#000002' },
      { position: 0.5, color: '#000003' },
    ];
    expect(sortStops(stops).map((stop) => stop.color)).toEqual(['#000002', '#000001', '#000003']);
    // A stop moved onto another's position stays on the side it came from.
    const sorted = sortStops(stops);
    expect(setStopPosition(sorted, 0, 0.5).map((stop) => stop.color)).toEqual([
      '#000002',
      '#000001',
      '#000003',
    ]);
    expect(setStopPosition(sorted, 2, 0.1).map((stop) => stop.color)).toEqual([
      '#000003',
      '#000002',
      '#000001',
    ]);
    expect(setStopPosition(sorted, 0, 7)[2]).toEqual({ position: 1, color: '#000002' });
  });

  it('reorders by swapping colours, keeps at least two stops and at most eight', () => {
    const stops = evenStops(['#000000', '#808080', '#ffffff']);
    expect(stops).toEqual([
      { position: 0, color: '#000000' },
      { position: 0.5, color: '#808080' },
      { position: 1, color: '#ffffff' },
    ]);
    expect(moveStop(stops, 2, -1)).toEqual([
      { position: 0, color: '#000000' },
      { position: 0.5, color: '#ffffff' },
      { position: 1, color: '#808080' },
    ]);
    expect(moveStop(stops, 0, -1)).toEqual(stops);
    expect(removeStop(removeStop(stops, 1), 0)).toHaveLength(2);
    expect(addStop(stops)).toEqual([
      { position: 0, color: '#000000' },
      { position: 0.25, color: '#000000' },
      { position: 0.5, color: '#808080' },
      { position: 1, color: '#ffffff' },
    ]);
    let full = stops;
    for (let i = 0; i < 10; i++) full = addStop(full);
    expect(full).toHaveLength(8);
    expect(evenStops(['#123456'])).toHaveLength(2);
  });

  it('round-trips palette JSON exactly, and fills in a gradient for a colours-only file', () => {
    const palette = gradient('oklab', [
      { position: 0, color: '#0000ff' },
      { position: 0.4, color: '#ff0000' },
      { position: 0.4, color: '#00ff00' },
      { position: 1, color: '#ffffff' },
    ]);
    palette.colors = ['#ff0000', '#00ff00', '#0000ff', '#ffffff'];
    const text = paletteJson(palette);
    expect(text.ok).toBe(true);
    expect(parsePaletteJson(text.ok ? text.value : '')).toEqual({ ok: true, value: palette });

    const colorsOnly = parsePaletteJson(
      JSON.stringify({
        format: 'shadergrove-palette/v1',
        name: 'C',
        colors: ['#AA0000', '#00aa00'],
      }),
    );
    expect(colorsOnly.ok && colorsOnly.value.gradient).toEqual({
      interpolation: 'oklab',
      stops: [
        { position: 0, color: '#aa0000' },
        { position: 1, color: '#00aa00' },
      ],
    });
  });

  it.each([
    ['not JSON', '{'],
    ['another format', JSON.stringify({ ...DEFAULT_PALETTE, format: 'other/v1' })],
    ['an unknown field', JSON.stringify({ ...DEFAULT_PALETTE, extra: 1 })],
    ['nine colours', JSON.stringify({ ...DEFAULT_PALETTE, colors: Array(9).fill('#000000') })],
    [
      'decreasing stops',
      JSON.stringify({
        ...DEFAULT_PALETTE,
        gradient: { interpolation: 'srgb', stops: [...BLACK_WHITE].reverse() },
      }),
    ],
    ['an oversize file', ' '.repeat(PALETTE_FILE_BYTES + 1)],
  ])('refuses %s', (_label, text) => {
    expect(parsePaletteJson(text).ok).toBe(false);
  });

  it('draws the gradient in the space the effect uses, and reads only valid samples', () => {
    expect(gradientCss(gradient('linear', BLACK_WHITE).gradient!)).toBe(
      'linear-gradient(in srgb-linear to right, #000000 0%, #ffffff 100%)',
    );
    const effect = (samples: unknown): AssetToolOutput => ({
      kind: 'effect',
      effect: { name: 'e', source: 's', controls: [], values: {} },
      metadata: { samples },
    });
    expect(gradientSamples(effect(['#000000', '#ffffff']))).toEqual(['#000000', '#ffffff']);
    expect(gradientSamples(effect(['#000000', 'red']))).toBeNull();
    expect(gradientSamples(effect('#000000'))).toBeNull();
  });
});

describe('palette studio lifecycle', () => {
  const draft = signal<object | null>(null);
  const adopt = vi.fn(() => ({ ok: true }) as const);
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
            record: signal(null),
            selectedId: computed(() => null),
            draft,
            controls: signal([]),
            params: signal({}),
          },
        },
        { provide: RendererHandle, useValue: { engine: signal(null) } },
        { provide: EffectAdoption, useValue: { adopt } },
        provideToolAdapters([PaletteStudioAdapter]),
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

  async function install(installations: PluginInstallations) {
    await settle();
    const review = installations.review(new TextEncoder().encode(paletteStudioText()));
    if (!review.ok) throw new Error(review.errors.join());
    await installations.install(review);
    await installations.setEnabled(ID, true);
    await settle();
  }

  const palette = signal(gradient('oklab', BLACK_WHITE));
  const source = computed(() => ({
    shaderId: 'palette-studio',
    fingerprint: JSON.stringify(palette()),
  }));
  const open = (tools: PluginTools): ToolSession => {
    const session = tools.openSession(ID, 'palette-studio', { source });
    if (!session) throw new Error('not offered');
    return session;
  };
  const request = () => effectRequest(palette(), { strength: 0.5, adjustments: [] });

  beforeEach(() => {
    profiles = new Map();
    sandbox = newRecord();
    adopt.mockClear();
    draft.set(null);
    palette.set(gradient('oklab', BLACK_WHITE));
  });

  afterEach(() => TestBed.resetTestingModule());

  it('offers the official package through the registered adapter, with no project needed', async () => {
    const { tools, installations } = setup();
    await install(installations);
    const [tool] = tools.toolsOf(ID);
    expect(tool?.adapter).toMatchObject({
      kind: 'assetTool',
      workflow: 'palette-studio/v1',
      panel: PaletteTool,
      needsProject: false,
      command: { label: 'palette.command', icon: 'palette' },
    });
    await installations.setEnabled(ID, false);
    expect(tools.toolsOf(ID)).toEqual([]);
  });

  it('refuses settings outside the schema before any Worker starts', async () => {
    const { tools, installations } = setup();
    await install(installations);
    const outcome = await open(tools).runAsset({ ...request(), settings: { strength: 2 } });
    expect(outcome.status).toBe('failed');
    expect(sandbox.starts).toBe(0);
  });

  it('applies an effect only while the palette it was made from holds, once per Apply', async () => {
    const { tools, installations } = setup();
    await install(installations);
    const session = open(tools);
    expect((await session.runAsset(request())).status).toBe('ok');

    const first = await applyPaletteEffect(session, adopt);
    const second = await applyPaletteEffect(session, adopt);
    expect(first).toEqual({ status: 'delivered', value: { result: { ok: true }, name: 'Test' } });
    expect(second.status).toBe('delivered');
    expect(adopt).toHaveBeenCalledTimes(2);
    const candidate = (adopt.mock.calls[0] as unknown[])[0] as { values: object; source: string };
    expect(candidate.values).toEqual({ strength: 0.5 });
    expect(candidate.source).toContain('pgGradient');

    // An edited palette makes the effect out of date: nothing is applied.
    palette.update((current) => ({ ...current, name: 'Edited' }));
    expect(session.result()).toBeNull();
    expect(session.stale()).toBe(true);
    expect(await applyPaletteEffect(session, adopt)).toEqual({ status: 'stale' });
    expect(adopt).toHaveBeenCalledTimes(2);
  });

  it('coalesces previews: an older palette never lands after a newer one', async () => {
    const { tools, installations } = setup();
    await install(installations);
    const session = open(tools);
    const older = session.runAsset(request());
    palette.set(gradient('srgb', BLACK_WHITE, 'Newer'));
    const newer = session.runAsset(request());
    expect((await older).status).toBe('superseded');
    expect((await newer).status).toBe('ok');
    const value = session.result()!.value as AssetToolOutput & { kind: 'effect' };
    expect(value.effect.name).toBe('Newer');
  });

  it.each([
    ['switched off', (installations: PluginInstallations) => installations.setEnabled(ID, false)],
    ['removed', (installations: PluginInstallations) => installations.remove(ID)],
  ])('drops an effect and refuses Apply once the package is %s', async (_label, change) => {
    const { tools, installations } = setup();
    await install(installations);
    const session = open(tools);
    await session.runAsset(request());
    await change(installations);
    await settle();
    expect(session.result()).toBeNull();
    expect(await applyPaletteEffect(session, adopt)).toEqual({ status: 'stale' });
    expect(adopt).not.toHaveBeenCalled();
  });

  it('draws the panel only while the package is on: editor and JSON without a shader, no effect preview', async () => {
    const { installations } = setup();
    await install(installations);
    const fixture = TestBed.createComponent(PluginToolsOutlet);
    fixture.componentRef.setInput('packageId', ID);
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelector('app-palette-panel')).not.toBeNull();
    expect(element.querySelectorAll('[data-testid^="palette-stop-color-"]')).toHaveLength(2);
    expect(element.querySelector('[data-testid="palette-export"]')).not.toBeNull();
    expect(element.querySelector('[data-testid="palette-needs-shader"]')).not.toBeNull();
    expect(element.querySelector('[data-testid="palette-apply"]')).toBeNull();
    await new Promise((done) => setTimeout(done, 200));
    expect(sandbox.starts).toBe(0);

    await installations.setEnabled(ID, false);
    await settle();
    await fixture.whenStable();
    expect(element.querySelector('app-palette-panel')).toBeNull();
    fixture.destroy();
  });
  it('commits a typed stop position when the field is left, never a partial value per keystroke', async () => {
    const { installations } = setup();
    await install(installations);
    const fixture = TestBed.createComponent(PluginToolsOutlet);
    fixture.componentRef.setInput('packageId', ID);
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    element.querySelector<HTMLButtonElement>('[data-testid="palette-add-stop"]')!.click();
    await fixture.whenStable();
    const field = (i: number) =>
      element.querySelector<HTMLInputElement>(`[data-testid="palette-stop-position-${i}"]`)!;
    const colors = () =>
      [0, 1, 2].map(
        (i) =>
          element.querySelector<HTMLInputElement>(`[data-testid="palette-stop-color-${i}"]`)!.value,
      );
    expect([0, 1, 2].map((i) => field(i).value)).toEqual(['0', '0.5', '1']);
    expect(colors()).toEqual(['#000000', '#000000', '#ffffff']);

    // Typing "0.25" into the last stop: the keystrokes on their own move nothing.
    for (const partial of ['', '0', '0.', '0.2', '0.25']) {
      field(2).value = partial;
      field(2).dispatchEvent(new Event('input'));
      await fixture.whenStable();
      expect(colors()).toEqual(['#000000', '#000000', '#ffffff']);
    }
    // Leaving the field commits it: the white stop moves into position order.
    field(2).dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect([0, 1, 2].map((i) => field(i).value)).toEqual(['0', '0.25', '0.5']);
    expect(colors()).toEqual(['#000000', '#ffffff', '#000000']);

    // An emptied field is refused and shows the stop's position again.
    field(1).value = '';
    field(1).dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(field(1).value).toBe('0.25');
    expect(colors()).toEqual(['#000000', '#ffffff', '#000000']);
    fixture.destroy();
  });
});
