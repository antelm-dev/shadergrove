import { DOCUMENT } from '@angular/common';
import { PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_CHANNELS,
  DEFAULT_RENDER,
  getBloomEffect,
  toSummary,
  updatePostProcessingEffect,
  type BloomEffect,
  type BloomSettings,
  type ImportResult,
  type Preset,
  type RenderSettings,
  type ShaderControl,
  type ShaderParams,
  type ShaderRecord,
  type ShaderSummary,
} from '@shadergrove/shared/model';
import { imagePass, migrateLegacyProject } from '@shadergrove/shared/project';
import {
  Preferences,
  createDefaultWorkspacePreferences,
  type WorkspacePreferences,
} from '../prefs/preferences';
import { ApiError, type UpdateShaderPatch } from '../api/shader-api';
import { ShaderApi } from '../api/shader-api';
import { RendererHandle } from '../rendering/renderer-handle';
import { documentWith, MemoryStorage } from './lifecycle/testing/lifecycle-harness';
import { ShaderStore } from './shader-store';
import { DraftRecovery } from './draft-recovery';

/**
 * The store is tested against a fake API rather than an HTTP mock: what is
 * worth pinning down here is the state machine — what the draft, the params and
 * the active preset do to each other — not the wire format, which `shader-api`
 * owns and the server specs already cover.
 */

const CONTROLS: ShaderControl[] = [
  { key: 'speed', type: 'number', default: 1, min: 0, max: 10 },
  { key: 'glow', type: 'boolean', default: false },
];

const FRAGMENT = 'void main() { gl_FragColor = vec4(1.0); }';
const VERTEX = 'void main() { gl_Position = vec4(position, 1.0); }';

function makeRecord(overrides: Partial<ShaderRecord> = {}): ShaderRecord {
  return {
    id: 'waves',
    kind: 'shader',
    name: 'Waves',
    description: '',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    revision: 1,
    controls: structuredClone(CONTROLS),
    render: structuredClone(DEFAULT_RENDER),
    channels: structuredClone(DEFAULT_CHANNELS),
    thumbnail: null,
    fragment: FRAGMENT,
    vertex: VERTEX,
    presets: [],
    project: migrateLegacyProject(FRAGMENT, VERTEX),
    ...overrides,
  };
}

function controlsText(controls: readonly ShaderControl[]): string {
  return JSON.stringify(controls, null, 2);
}

/** An in-memory stand-in for the server. Only what the store actually calls. */
class FakeApi implements Partial<ShaderApi> {
  records = new Map<string, ShaderRecord>();

  /** Set to make the next call of that name reject. */
  failures = new Map<string, ApiError>();

  readonly calls: string[] = [];

  constructor(...records: ShaderRecord[]) {
    for (const record of records) this.records.set(record.id, record);
  }

  private track<T>(name: string, produce: () => T): Promise<T> {
    this.calls.push(name);
    const failure = this.failures.get(name);
    if (failure) {
      this.failures.delete(name);
      return Promise.reject(failure);
    }
    return Promise.resolve(produce());
  }

  list(): Promise<ShaderSummary[]> {
    return this.track('list', () => [...this.records.values()].map(toSummary));
  }

  read(id: string): Promise<ShaderRecord> {
    return this.track('read', () => {
      const record = this.records.get(id);
      if (!record) throw new ApiError(`No such shader ${id}`, [], 404);
      return structuredClone(record);
    });
  }

  create(name: string): Promise<ShaderRecord> {
    return this.track('create', () => {
      const created = makeRecord({ id: name.toLowerCase(), name, presets: [] });
      this.records.set(created.id, created);
      return structuredClone(created);
    });
  }

  update(id: string, patch: UpdateShaderPatch): Promise<ShaderRecord> {
    return this.track('update', () => {
      const current = this.records.get(id);
      if (!current) throw new ApiError(`No such shader ${id}`, [], 404);

      // Mirrors the real server: once a `project` is given, it is the source
      // of truth and `fragment`/`vertex` are derived from it.
      const project = patch.project ?? current.project;
      const updated: ShaderRecord = {
        ...current,
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.controls === undefined ? {} : { controls: patch.controls as ShaderControl[] }),
        ...(patch.render === undefined ? {} : { render: patch.render as ShaderRecord['render'] }),
        project,
        fragment:
          patch.project !== undefined
            ? imagePass(project).source
            : (patch.fragment ?? current.fragment),
        vertex: patch.project !== undefined ? project.vertex : (patch.vertex ?? current.vertex),
        updatedAt: '2024-02-02T00:00:00.000Z',
      };
      this.records.set(id, updated);
      return structuredClone(updated);
    });
  }

  duplicate(id: string, name?: string): Promise<ShaderRecord> {
    return this.track('duplicate', () => {
      const source = this.records.get(id);
      if (!source) throw new ApiError(`No such shader ${id}`, [], 404);

      const copy = structuredClone(source);
      copy.id = `${id}-2`;
      copy.name = name ?? `${source.name} copy`;
      this.records.set(copy.id, copy);
      return structuredClone(copy);
    });
  }

  remove(id: string): Promise<void> {
    return this.track('remove', () => {
      this.records.delete(id);
    });
  }

  savePreset(
    _id: string,
    name: string,
    values: ShaderParams,
    render?: RenderSettings,
  ): Promise<Preset> {
    return this.track('savePreset', () => ({
      id: name.toLowerCase(),
      name,
      createdAt: '2024-03-03T00:00:00.000Z',
      values: structuredClone(values),
      ...(render ? { render: structuredClone(render) } : {}),
    }));
  }

  deletePreset(): Promise<void> {
    return this.track('deletePreset', () => undefined);
  }

  importBundle(): Promise<ImportResult> {
    return this.track('importBundle', () => ({
      imported: [{ id: 'waves', name: 'Waves', replaced: true }],
    }));
  }
}

/** Preferences without the browser: a signal and a patch, nothing persisted. */
class FakePreferences implements Partial<Preferences> {
  private readonly state = signal<WorkspacePreferences>(createDefaultWorkspacePreferences());

  readonly value = this.state.asReadonly();

  patch(patch: Partial<WorkspacePreferences>): void {
    this.state.update((current) => ({ ...current, ...patch }));
  }
}

interface Harness {
  store: ShaderStore;
  api: FakeApi;
  preferences: FakePreferences;
}

function setup(...records: ShaderRecord[]): Harness {
  const api = new FakeApi(...records);
  const preferences = new FakePreferences();

  TestBed.configureTestingModule({
    providers: [
      { provide: ShaderApi, useValue: api },
      { provide: Preferences, useValue: preferences },
    ],
  });

  return { store: TestBed.inject(ShaderStore), api, preferences };
}

beforeEach(() => {
  TestBed.resetTestingModule();
  // `report` logs every failure; the failure paths below are deliberate.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

/** `render` with its first Bloom's switch and settings patched. */
function withBloom(
  render: RenderSettings,
  patch: Partial<BloomSettings> & { enabled: boolean },
): RenderSettings {
  const { enabled, ...settings } = patch;
  return updatePostProcessingEffect<BloomEffect>(
    render,
    getBloomEffect(render).instanceId,
    (bloom) => ({ ...bloom, enabled, settings: { ...bloom.settings, ...settings } }),
  );
}

describe('ShaderStore: loading', () => {
  it('opens the first shader and mirrors it into the draft', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();

    const record = store.record();
    expect(record?.id).toBe('waves');

    // A shader with nothing in project storage — every shader, before passes
    // existed — opens as a project with one pass: its fragment is the Image
    // pass, and nothing else about it has changed.
    expect(store.fragment()).toBe(record!.fragment);
    expect(store.vertex()).toBe(record!.vertex);
    expect(store.draft()?.controlsText).toBe(controlsText(record!.controls));
    expect(store.draft()?.render).toEqual(record!.render);

    expect(store.params()).toEqual({ speed: 1, glow: false });
    expect(store.dirty()).toBe(false);
  });

  it('remembers the shader as the last one opened', async () => {
    const { store, preferences } = setup(makeRecord());
    await store.initialize();

    expect(preferences.value().lastShaderId).toBe('waves');
  });

  it('does not reload a shader that is already open', async () => {
    const { store, api } = setup(makeRecord());
    await store.initialize();
    const before = api.calls.filter((call) => call === 'read').length;

    await store.select('waves');
    expect(api.calls.filter((call) => call === 'read')).toHaveLength(before);
  });

  it('reports a failed load as a notice instead of throwing', async () => {
    const { store, api } = setup(makeRecord());
    api.failures.set('read', new ApiError('Cannot reach the server'));

    await store.select('waves');

    expect(store.notice()).toEqual({ text: 'Cannot reach the server', error: true });
    expect(store.record()).toBeNull();
    expect(store.loading()).toBe(false);
  });

  it('honours the remembered shader once the client takes over', async () => {
    const { store, preferences } = setup(
      makeRecord(),
      makeRecord({ id: 'plasma', name: 'Plasma' }),
    );
    preferences.patch({ lastShaderId: 'plasma' });

    await store.initializeClient();

    expect(store.selectedId()).toBe('plasma');
  });

  it('ignores a remembered shader that no longer exists', async () => {
    const { store, preferences } = setup(makeRecord());
    preferences.patch({ lastShaderId: 'deleted' });

    await store.initializeClient();

    expect(store.selectedId()).toBe('waves');
  });
});

describe('ShaderStore: dirty', () => {
  it('tracks each buffer against the record', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();
    const record = store.record()!;

    store.setFragment('void main() {}');
    expect(store.dirty()).toBe(true);

    store.setFragment(record.fragment);
    expect(store.dirty()).toBe(false);

    store.setVertex('void main() {}');
    expect(store.dirty()).toBe(true);

    store.setVertex(record.vertex);
    store.setRender(
      withBloom(record.render, { ...getBloomEffect(record.render).settings, enabled: true }),
    );
    expect(store.dirty()).toBe(true);

    store.setRender(structuredClone(record.render));
    expect(store.dirty()).toBe(false);
  });

  it('does not count a turned knob as an unsaved edit', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();

    store.setParam('speed', 4);

    expect(store.params()['speed']).toBe(4);
    expect(store.dirty()).toBe(false);
  });
});

describe('ShaderStore: config buffer', () => {
  it('keeps the last known-good schema while the text is half-typed', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();

    store.setControlsText('[{"key": "speed", "type": "num');

    expect(store.configValid()).toBe(false);
    expect(store.controls()).toEqual(CONTROLS);
    expect(store.hasErrors()).toBe(true);
    expect(store.diagnostics()[0]).toMatchObject({ source: 'config', severity: 'error', line: 0 });
  });

  it('surfaces a schema that parses but does not validate', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();

    store.setControlsText(
      JSON.stringify([{ key: 'speed', type: 'number', default: 5, min: 10, max: 0 }]),
    );

    expect(store.configValid()).toBe(false);
    expect(store.diagnostics().some((entry) => entry.source === 'config')).toBe(true);
  });

  it('re-projects the live params as soon as the schema parses again', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();
    store.setParam('speed', 7);

    store.setControlsText(
      controlsText([
        { key: 'speed', type: 'number', default: 1, min: 0, max: 10 },
        { key: 'hue', type: 'color', default: '#ff0000' },
      ]),
    );

    // `speed` survives at its live value, `hue` appears at its default, and the
    // dropped `glow` takes its value with it.
    expect(store.params()).toEqual({ speed: 7, hue: '#ff0000' });
    expect(store.configValid()).toBe(true);
    expect(store.diagnostics()).toEqual([]);
  });

  it('clamps a live value that the new schema no longer allows', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();
    store.setParam('speed', 9);

    store.setControlsText(
      controlsText([{ key: 'speed', type: 'number', default: 1, min: 0, max: 2 }]),
    );

    expect(store.params()['speed']).toBe(2);
  });
});

describe('ShaderStore: diagnostics', () => {
  it('replaces compile diagnostics without dropping the config ones', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();
    store.setControlsText('not json');

    store.setCompileDiagnostics([
      { severity: 'error', line: 3, message: 'undeclared identifier', source: 'fragment' },
    ]);
    store.setCompileDiagnostics([
      { severity: 'warning', line: 5, message: 'unused variable', source: 'fragment' },
    ]);

    const sources = store.diagnostics().map((entry) => entry.source);
    expect(sources).toEqual(['config', 'fragment']);
    expect(store.diagnostics().filter((entry) => entry.source === 'fragment')).toHaveLength(1);
  });

  it('has errors only when something is an error', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();

    store.setCompileDiagnostics([
      { severity: 'warning', line: 5, message: 'unused variable', source: 'fragment' },
    ]);
    expect(store.hasErrors()).toBe(false);

    store.setCompileDiagnostics([
      { severity: 'error', line: 5, message: 'syntax error', source: 'fragment' },
    ]);
    expect(store.hasErrors()).toBe(true);
  });
});

describe('ShaderStore: saving', () => {
  it('refuses to save a broken schema and says why', async () => {
    const { store, api } = setup(makeRecord());
    await store.initialize();
    store.setControlsText('not json');

    await store.save();

    expect(api.calls).not.toContain('update');
    expect(store.notice()).toEqual({
      text: 'Fix the configuration schema before saving',
      error: true,
    });
  });

  it('adopts the saved record and comes back clean', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();
    store.setFragment('void main() { gl_FragColor = vec4(0.0); }');

    await store.save();

    expect(store.record()?.fragment).toBe('void main() { gl_FragColor = vec4(0.0); }');
    expect(store.dirty()).toBe(false);
    expect(store.notice()).toEqual({ text: 'Saved “Waves”', error: false });
  });

  it('continues saving a legacy example under its personal id and clears the old draft', async () => {
    const { store, api } = setup(makeRecord({ kind: 'template' }));
    await store.initialize();
    store.setFragment('void main() { gl_FragColor = vec4(0.0); }');
    const recovery = TestBed.inject(DraftRecovery);
    const remove = vi.spyOn(recovery, 'remove');
    const update = vi.spyOn(api, 'update').mockImplementationOnce(async (_id, patch) => {
      const saved = makeRecord({
        id: 'waves-2',
        project: patch.project,
        fragment: imagePass(patch.project!).source,
        revision: 2,
      });
      api.records.set(saved.id, saved);
      return saved;
    });

    expect(await store.save()).toBe(true);
    expect(store.selectedId()).toBe('waves-2');
    expect(store.dirty()).toBe(false);
    expect(remove).toHaveBeenCalledWith('waves');

    store.setFragment(FRAGMENT);
    expect(await store.save()).toBe(true);
    expect(update.mock.calls.map(([id]) => id)).toEqual(['waves', 'waves-2']);
    expect(api.records.size).toBe(2); // The shared original and one personal copy.
  });

  it('keeps the live params and the open preset across a save', async () => {
    const preset: Preset = {
      id: 'calm',
      name: 'Calm',
      createdAt: '2024-01-01T00:00:00.000Z',
      values: { speed: 2, glow: true },
    };
    const { store } = setup(makeRecord({ presets: [preset] }));
    await store.initialize();

    store.applyPreset('calm');
    store.setFragment('void main() {}');
    await store.save();

    expect(store.params()).toEqual({ speed: 2, glow: true });
    expect(store.activePresetId()).toBe('calm');
  });

  it('drops a param the saved schema no longer declares', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();

    store.setControlsText(
      controlsText([{ key: 'speed', type: 'number', default: 1, min: 0, max: 10 }]),
    );
    store.setParam('speed', 6);
    await store.save();

    expect(store.params()).toEqual({ speed: 6 });
  });

  it('ignores a second save while the first is in flight', async () => {
    const { store, api } = setup(makeRecord());
    await store.initialize();
    store.setFragment('void main() {}');

    await Promise.all([store.save(), store.save()]);

    expect(api.calls.filter((call) => call === 'update')).toHaveLength(1);
  });

  it('leaves the draft alone when the save fails', async () => {
    const { store, api } = setup(makeRecord());
    await store.initialize();
    store.setFragment('void main() {}');
    api.failures.set('update', new ApiError('Write failed', ['disk full']));

    await store.save();

    expect(store.fragment()).toBe('void main() {}');
    expect(store.dirty()).toBe(true);
    expect(store.saving()).toBe(false);
    expect(store.notice()).toEqual({ text: 'Write failed: disk full', error: true });
  });

  it('throws the draft away on revert', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();
    const original = store.record()!.fragment;

    store.setFragment('void main() {}');
    store.setParam('speed', 8);
    store.revert();

    expect(store.fragment()).toBe(original);
    expect(store.dirty()).toBe(false);
    // Reverting the source resets the knobs too: `adopt` is a full reset.
    expect(store.params()).toEqual({ speed: 1, glow: false });
  });
});

describe('ShaderStore: presets', () => {
  const preset: Preset = {
    id: 'calm',
    name: 'Calm',
    createdAt: '2024-01-01T00:00:00.000Z',
    values: { speed: 3, glow: true },
  };

  it('applies a preset onto the live params', async () => {
    const { store } = setup(makeRecord({ presets: [preset] }));
    await store.initialize();

    store.applyPreset('calm');

    expect(store.params()).toEqual({ speed: 3, glow: true });
    expect(store.activePresetId()).toBe('calm');
  });

  it('projects an old preset onto the schema being edited now', async () => {
    const { store } = setup(makeRecord({ presets: [preset] }));
    await store.initialize();

    // The draft adds a control and narrows `speed`; neither is saved yet.
    store.setControlsText(
      controlsText([
        { key: 'speed', type: 'number', default: 1, min: 0, max: 2 },
        { key: 'hue', type: 'color', default: '#00ff00' },
      ]),
    );
    store.applyPreset('calm');

    // `speed` clamped into the new range, `hue` defaulted, `glow` dropped.
    expect(store.params()).toEqual({ speed: 2, hue: '#00ff00' });
  });

  it('forgets the preset as soon as a knob moves', async () => {
    const { store } = setup(makeRecord({ presets: [preset] }));
    await store.initialize();

    store.applyPreset('calm');
    store.setParam('speed', 5);

    expect(store.activePresetId()).toBeNull();
  });

  it('resets the knobs to the schema defaults', async () => {
    const { store } = setup(makeRecord({ presets: [preset] }));
    await store.initialize();

    store.applyPreset('calm');
    store.resetParams();

    expect(store.params()).toEqual({ speed: 1, glow: false });
    expect(store.activePresetId()).toBeNull();
  });

  it('ignores a preset that is not there', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();

    store.applyPreset('ghost');

    expect(store.params()).toEqual({ speed: 1, glow: false });
    expect(store.activePresetId()).toBeNull();
  });

  it('replaces a preset saved under an existing name rather than adding a second', async () => {
    const { store } = setup(makeRecord({ presets: [preset] }));
    await store.initialize();

    store.setParam('speed', 9);
    await store.savePreset('Calm');

    expect(store.presets()).toHaveLength(1);
    expect(store.presets()[0].values).toEqual({ speed: 9, glow: false });
    expect(store.activePresetId()).toBe('calm');
  });

  it('deletes a preset and clears it if it was the open one', async () => {
    const { store } = setup(makeRecord({ presets: [preset] }));
    await store.initialize();
    store.applyPreset('calm');

    await store.deletePreset('calm');

    expect(store.presets()).toEqual([]);
    expect(store.activePresetId()).toBeNull();
  });

  it('captures the draft render settings only when asked to', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();

    store.setRender(
      withBloom(DEFAULT_RENDER, { enabled: true, strength: 1, radius: 0.5, threshold: 0.8 }),
    );
    await store.savePreset('Values only');
    await store.savePreset('With bloom', true);

    expect(store.presets()[0].render).toBeUndefined();
    const captured = store.presets()[1].render;
    expect(captured && getBloomEffect(captured).enabled).toBe(true);
  });

  it('restores the render settings a preset captured, leaving the draft dirty', async () => {
    const glow: Preset = {
      id: 'glow',
      name: 'Glow',
      createdAt: '2024-01-01T00:00:00.000Z',
      values: { speed: 2, glow: true },
      render: withBloom(DEFAULT_RENDER, {
        enabled: true,
        strength: 1.2,
        radius: 0.4,
        threshold: 0.7,
      }),
    };
    const { store } = setup(makeRecord({ presets: [glow] }));
    await store.initialize();

    store.applyPreset('glow');

    const draftRender = store.draft()?.render;
    expect(draftRender && getBloomEffect(draftRender)).toEqual({
      type: 'bloom',
      instanceId: 'bloom',
      enabled: true,
      settings: { strength: 1.2, radius: 0.4, threshold: 0.7 },
    });
    // Bloom is part of the saved shader, so restoring it is an unsaved edit —
    // pretending otherwise would drop it on the next load.
    expect(store.dirty()).toBe(true);
  });

  it('leaves the render settings alone for a preset that captured none', async () => {
    const { store } = setup(makeRecord({ presets: [preset] }));
    await store.initialize();
    store.setRender(
      withBloom(DEFAULT_RENDER, { enabled: true, strength: 1, radius: 0.5, threshold: 0.8 }),
    );

    store.applyPreset('calm');

    const draftRender = store.draft()?.render;
    expect(draftRender && getBloomEffect(draftRender).enabled).toBe(true);
  });
});

describe('ShaderStore: collection', () => {
  it('opens a newly created shader', async () => {
    const { store, preferences } = setup(makeRecord());
    await store.initialize();

    await store.create('Plasma');

    expect(store.selectedId()).toBe('plasma');
    expect(store.dirty()).toBe(false);
    expect(preferences.value().lastShaderId).toBe('plasma');
    expect(store.notice()).toEqual({ text: 'Created “Plasma”', error: false });
  });

  it('opens the copy, not the original', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();

    await store.duplicate('waves');

    expect(store.selectedId()).toBe('waves-2');
    expect(store.shaders().map((shader) => shader.id)).toContain('waves-2');
  });

  it('carries the project — buffers, files and wiring — into the copy', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();

    store.addBufferPass();
    store.addSourceFile('lib.glsl');
    await store.save();
    expect(store.buffers()).toHaveLength(1);

    await store.duplicate('waves');

    // The project is now part of the record the server hands back, so a
    // duplicate carries it the same way it carries presets — nothing special
    // to ask for, and nothing left behind in the original's local storage.
    expect(store.selectedId()).toBe('waves-2');
    expect(store.buffers()).toHaveLength(1);
    expect(store.project()?.files.map((file) => file.name)).toContain('lib.glsl');
  });

  it('renames in place without disturbing the draft', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();
    store.setFragment('void main() {}');

    await store.rename('waves', 'Ripples');

    expect(store.record()?.name).toBe('Ripples');
    expect(store.fragment()).toBe('void main() {}');
    expect(store.dirty()).toBe(true);
  });

  it('falls back to the next shader when the open one is deleted', async () => {
    const { store } = setup(makeRecord(), makeRecord({ id: 'plasma', name: 'Plasma' }));
    await store.initialize();

    await store.remove('waves');

    expect(store.selectedId()).toBe('plasma');
    expect(store.draft()).not.toBeNull();
  });

  it('empties the workspace when the last shader is deleted', async () => {
    const { store, preferences } = setup(makeRecord());
    await store.initialize();

    await store.remove('waves');

    expect(store.record()).toBeNull();
    expect(store.draft()).toBeNull();
    expect(store.params()).toEqual({});
    expect(preferences.value().lastShaderId).toBeNull();
  });

  it('keeps the open shader when a different one is deleted', async () => {
    const { store } = setup(makeRecord(), makeRecord({ id: 'plasma', name: 'Plasma' }));
    await store.initialize();

    await store.remove('plasma');

    expect(store.selectedId()).toBe('waves');
    expect(store.shaders().map((shader) => shader.id)).toEqual(['waves']);
  });

  it('reloads the shader an import replaced under it', async () => {
    const { store, api } = setup(makeRecord());
    await store.initialize();
    api.records.set('waves', makeRecord({ fragment: 'void main() { /* imported */ }' }));

    await store.importBundle({}, 'overwrite');

    // Same id as the open one, so a plain `select` would have been a no-op.
    expect(store.record()?.fragment).toBe('void main() { /* imported */ }');
    expect(store.notice()).toEqual({ text: 'Imported 1 shader (1 replaced)', error: false });
  });

  it('reloads the open shader sync replaced, offering the unsaved draft back', async () => {
    // Explicit storage, as the recovery-facade specs use: the environment's
    // own localStorage is not something this outcome may depend on.
    const storage = new MemoryStorage();
    const api = new FakeApi(makeRecord());
    TestBed.configureTestingModule({
      providers: [
        { provide: ShaderApi, useValue: api },
        { provide: Preferences, useValue: new FakePreferences() },
        { provide: PLATFORM_ID, useValue: 'browser' },
        { provide: DOCUMENT, useValue: documentWith(storage) },
      ],
    });
    const store = TestBed.inject(ShaderStore);
    await store.initialize();
    store.setFragment('void main() { /* unsaved */ }');
    expect(store.dirty()).toBe(true);
    api.records.set(
      'waves',
      makeRecord({
        fragment: 'void main() { /* account */ }',
        updatedAt: '2024-02-01T00:00:00.000Z',
        revision: 2,
      }),
    );

    await store.reloadReplaced(['other']);
    expect(store.record()?.revision).toBe(1);
    expect(storage.getItem('shader-studio.recovered-drafts')).toBeNull();

    await store.reloadReplaced(['waves']);
    const saved = JSON.parse(storage.getItem('shader-studio.recovered-drafts') ?? '{}') as {
      drafts?: Record<string, { baselineUpdatedAt: string }>;
    };
    expect(saved.drafts?.['waves']?.baselineUpdatedAt).toBe('2024-01-01T00:00:00.000Z');
    expect(store.record()?.fragment).toBe('void main() { /* account */ }');
    expect(store.record()?.revision).toBe(2);
    expect(store.staleRecovery()?.shaderId).toBe('waves');
  });

  it('reports an import the server rejected', async () => {
    const { store, api } = setup(makeRecord());
    await store.initialize();
    api.failures.set('importBundle', new ApiError('Invalid bundle', ['unsupported format']));

    await store.importBundle({});

    expect(store.notice()).toEqual({ text: 'Invalid bundle: unsupported format', error: true });
    expect(store.selectedId()).toBe('waves');
  });
});

/**
 * The revision and compile-completion machinery the MCP tools depend on.
 * `waitForCompile`/`compileNow` are tested by simulating what `shader-canvas`
 * does after a real compile — calling `recordCompileResult` — since these are
 * store-level unit tests with no WebGL context to actually compile against.
 */
describe('ShaderStore: revisions and compile completion', () => {
  it('bumps the revision on every draft mutation', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();
    const initial = store.draftRevision();

    store.setFragment('void main() { gl_FragColor = vec4(0.5); }');
    expect(store.draftRevision()).toBe(initial + 1);

    store.setRender(
      withBloom(DEFAULT_RENDER, { enabled: true, strength: 1, radius: 1, threshold: 1 }),
    );
    expect(store.draftRevision()).toBe(initial + 2);
  });

  it('resets the revision when a different shader is opened', async () => {
    const { store } = setup(makeRecord(), makeRecord({ id: 'plasma', name: 'Plasma' }));
    await store.initialize();
    store.setFragment('void main() {}');
    expect(store.draftRevision()).toBeGreaterThan(0);

    await store.select('plasma');
    expect(store.draftRevision()).toBe(0);
  });

  it("forgets the previous shader's effect errors when another shader opens", async () => {
    const { store } = setup(makeRecord(), makeRecord({ id: 'plasma', name: 'Plasma' }));
    await store.initialize();
    store.setEffectDiagnostics([
      { severity: 'error', line: 1, message: 'broken', source: 'fragment', docId: '@effect/c' },
    ]);
    expect(store.hasErrors()).toBe(true);

    await store.select('plasma');

    expect(store.allDiagnostics()).toEqual([]);
    expect(store.hasErrors()).toBe(false);
  });

  it('waitForCompile resolves once recordCompileResult reports that revision', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();
    const revision = store.draftRevision();

    const waiting = store.waitForCompile(revision, 1000);
    store.recordCompileResult(revision, []);

    await expect(waiting).resolves.toMatchObject({ revision });
  });

  it('a waiter for an older revision is satisfied by a newer compile', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();
    const revision = store.draftRevision();

    const waiting = store.waitForCompile(revision, 1000);
    store.recordCompileResult(revision + 1, []);

    await expect(waiting).resolves.toMatchObject({ revision: revision + 1 });
  });

  it('rejects a waiter that times out before any compile lands', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();

    await expect(store.waitForCompile(store.draftRevision() + 1, 20)).rejects.toThrow(/Timed out/);
  });

  it('compileNow resolves once the revision it asked for has actually compiled', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();

    const pending = store.compileNow();
    store.recordCompileResult(store.draftRevision(), []);

    await expect(pending).resolves.toMatchObject({ revision: store.draftRevision() });
  });
});

describe('ShaderStore: applyPatch', () => {
  function imageDocId(store: ShaderStore): string {
    const doc = store.documents().find((entry) => entry.passKind === 'image');
    if (!doc) throw new Error('The fixture has no Image pass.');
    return doc.id;
  }

  it('rejects a stale base revision without changing any state', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();
    const docId = imageDocId(store);
    const before = store.fragment();

    const result = await store.applyPatch(store.draftRevision() - 1, [
      { documentId: docId, start: 0, end: 0, text: '// x' },
    ]);

    expect(result).toMatchObject({
      ok: false,
      code: 'STALE_REVISION',
      currentRevision: store.draftRevision(),
    });
    expect(store.fragment()).toBe(before);
  });

  it('applies edits to multiple documents atomically, in a single revision bump', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();
    const docId = imageDocId(store);
    const baseRevision = store.draftRevision();

    const pending = store.applyPatch(baseRevision, [
      { documentId: docId, start: 0, end: 0, text: '// image\n' },
      { documentId: '@vertex', start: 0, end: 0, text: '// vertex\n' },
    ]);
    store.recordCompileResult(store.draftRevision(), []);
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(store.draftRevision()).toBe(baseRevision + 1);
    expect(store.fragment()).toContain('// image');
    expect(store.vertex()).toContain('// vertex');
  });

  it('rejects the whole patch when one edit is invalid, applying none of it', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();
    const docId = imageDocId(store);
    const before = store.fragment();
    const baseRevision = store.draftRevision();

    const result = await store.applyPatch(baseRevision, [
      { documentId: docId, start: 0, end: 0, text: '// ok\n' },
      { documentId: docId, start: 10_000, end: 10_001, text: 'x' },
    ]);

    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    expect(store.fragment()).toBe(before);
    expect(store.draftRevision()).toBe(baseRevision);
  });

  it('rejects an edit to a document that does not exist', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();

    const result = await store.applyPatch(store.draftRevision(), [
      { documentId: 'not-a-real-document', start: 0, end: 0, text: 'x' },
    ]);

    expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('never saves — the record is untouched after a patch', async () => {
    const { store, api } = setup(makeRecord());
    await store.initialize();
    const docId = imageDocId(store);
    const calls = api.calls.length;

    const pending = store.applyPatch(store.draftRevision(), [
      { documentId: docId, start: 0, end: 0, text: '// x\n' },
    ]);
    store.recordCompileResult(store.draftRevision(), []);
    await pending;

    expect(api.calls.length).toBe(calls);
    expect(store.dirty()).toBe(true);
  });
});

describe('ShaderStore: setParamsValidated', () => {
  it('applies valid values and reports an error per invalid or unknown key', async () => {
    const controls: ShaderControl[] = [
      { key: 'speed', type: 'number', default: 1, min: 0, max: 10 },
      { key: 'glow', type: 'boolean', default: false },
    ];
    const { store } = setup(makeRecord({ controls }));
    await store.initialize();

    const result = store.setParamsValidated({ speed: 5, glow: 'not-a-boolean', unknown: 1 });

    expect(result.applied).toEqual(['speed']);
    expect(result.errors['glow']).toBeDefined();
    expect(result.errors['unknown']).toBeDefined();
    expect(store.params()['speed']).toBe(5);
  });
});

describe('ShaderStore: captureMissingPreview', () => {
  const PREVIEW = { ext: 'webp', updatedAt: '2024-02-02T00:00:00.000Z' };

  /** The store with a renderer that has a frame to give and an API that stores it. */
  function setupWithRenderer(record: ShaderRecord) {
    const api = new FakeApi(record);
    const setThumbnail = vi.fn((id: string) =>
      Promise.resolve({ ...api.records.get(id)!, thumbnail: PREVIEW }),
    );
    Object.assign(api, { setThumbnail });
    const captureThumbnail = vi.fn(() =>
      Promise.resolve({ ext: 'webp', bytes: new Uint8Array([1]) }),
    );

    TestBed.configureTestingModule({
      providers: [
        { provide: ShaderApi, useValue: api },
        { provide: Preferences, useValue: new FakePreferences() },
        { provide: RendererHandle, useValue: { captureThumbnail } },
      ],
    });

    return { store: TestBed.inject(ShaderStore), setThumbnail };
  }

  it('photographs an open shader that has no preview, once', async () => {
    const { store, setThumbnail } = setupWithRenderer(makeRecord());
    await store.initialize();

    store.captureMissingPreview('waves');
    await vi.waitFor(() => expect(store.record()?.thumbnail).toEqual(PREVIEW));
    expect(store.shaders()[0].thumbnail).toEqual(PREVIEW);

    store.captureMissingPreview('waves');
    expect(setThumbnail).toHaveBeenCalledOnce();
  });

  it('leaves alone a shader that has a preview, is not the open one, or is being edited', async () => {
    const { store, setThumbnail } = setupWithRenderer(makeRecord({ thumbnail: PREVIEW }));
    await store.initialize();

    store.captureMissingPreview('waves');
    store.captureMissingPreview('another');
    expect(setThumbnail).not.toHaveBeenCalled();
  });

  it('does not photograph an unsaved draft', async () => {
    const { store, setThumbnail } = setupWithRenderer(makeRecord());
    await store.initialize();

    store.setFragment('void main() { gl_FragColor = vec4(0.5); }');
    expect(store.dirty()).toBe(true);

    store.captureMissingPreview('waves');
    expect(setThumbnail).not.toHaveBeenCalled();
  });
});
