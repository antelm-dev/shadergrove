import { PLATFORM_ID, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_RENDER,
  effectContributionCandidate,
  type CustomEffect,
  type EffectContribution,
  type RenderSettings,
} from '@shadergrove/shared';
import {
  DEFAULT_PACKAGES_VERSION,
  DEFAULT_PACKAGE_IDS,
  emptyBootstrapState,
  type CatalogueEntry,
  type PluginBootstrapState,
} from '@shadergrove/shared/plugin';
import { AuthService } from '../auth/auth.service';
import { RendererHandle } from '../rendering/renderer-handle';
import { ShaderStore } from '../workspace/shader-store';
import { EffectAdoption } from './effect-adoption';
import { PluginCatalogueService } from './plugin-catalogue';
import { PLUGIN_STORE, PluginInstallations, type PluginReview } from './plugin-installations';
import { NoPluginStore, type PluginStore, type StoredPlugin } from './plugin-store';

/** One map per profile, standing in for one IndexedDB database each, and outliving the service. */
class MemoryStores {
  readonly byProfile = new Map<string, Map<string, StoredPlugin>>();

  for(profile: string): PluginStore {
    const records = this.byProfile.get(profile) ?? new Map<string, StoredPlugin>();
    this.byProfile.set(profile, records);
    return {
      list: async () => [...records.values()],
      put: async (record) => void records.set(record.id, record),
      add: async (record) => {
        if (records.has(record.id)) return false;
        records.set(record.id, record);
        return true;
      },
      replace: async (record) => {
        if (records.get(record.id)?.installedAt !== record.installedAt) return false;
        records.set(record.id, record);
        return true;
      },
      remove: async (id) => void records.delete(id),
      readBootstrap: async () => null,
      writeBootstrap: async () => undefined,
    };
  }
}

function packageText(overrides: { id?: string; version?: string; range?: string } = {}): string {
  return JSON.stringify({
    manifest: {
      id: overrides.id ?? 'dev.example.tint',
      version: overrides.version ?? '1.0.0',
      protocolVersion: 1,
      appVersionRange: overrides.range ?? '>=1.0.0',
      name: 'Tint',
      publisher: 'Example',
      license: 'MIT',
      contributions: [
        {
          kind: 'effect',
          id: 'tint',
          name: 'Red tint',
          controls: [{ key: 'amount', type: 'number', default: 0.5, min: 0, max: 1 }],
        },
      ],
    },
    glsl: {
      tint: 'vec4 effect(vec4 c, vec2 uv) { return c * vec4(1.0, u_amount, u_amount, 1.0); }',
    },
  });
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe('PluginInstallations', () => {
  let stores: MemoryStores;
  const user = signal<{ id: string } | null>(null);
  const status = signal<'loading' | 'anonymous' | 'authenticated'>('anonymous');
  const draft = signal<{ render: RenderSettings } | null>(null);
  const probe = vi.fn(() => [] as unknown[]);

  function setup(): PluginInstallations {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: PLUGIN_STORE, useValue: (profile: string) => stores.for(profile) },
        { provide: AuthService, useValue: { user, status } },
        {
          provide: ShaderStore,
          useValue: {
            draft,
            setRender: (render: RenderSettings) => draft.set({ render }),
          },
        },
        {
          provide: RendererHandle,
          useValue: { engine: () => ({ probeCustomEffect: probe }) },
        },
      ],
    });
    return TestBed.inject(PluginInstallations);
  }

  /** Lets the profile effect run and the store's promises settle. */
  async function settle(): Promise<void> {
    TestBed.tick();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  function okReview(installations: PluginInstallations, text = packageText()) {
    const review = installations.review(bytes(text));
    if (!review.ok) throw new Error(review.errors.join());
    return review;
  }

  beforeEach(() => {
    stores = new MemoryStores();
    user.set(null);
    status.set('anonymous');
    draft.set({ render: structuredClone(DEFAULT_RENDER) });
    probe.mockReset().mockReturnValue([]);
  });

  afterEach(() => TestBed.resetTestingModule());

  it('reviews a package without installing it, and installs it switched off', async () => {
    const installations = setup();
    await settle();

    const review = okReview(installations);
    expect(review.compatible).toBe(true);
    expect(installations.plugins()).toEqual([]);

    await installations.install(review);
    expect(installations.plugins()).toEqual([
      expect.objectContaining({ id: 'dev.example.tint', active: false, problem: null }),
    ]);

    await installations.setEnabled('dev.example.tint', true);
    expect(installations.find('dev.example.tint')?.active).toBe(true);
  });

  it('installs a reviewed package only into the profile it was reviewed for', async () => {
    const installations = setup();
    await settle();
    const review = okReview(installations);

    user.set({ id: 'bob' });
    status.set('authenticated');
    await settle();

    await expect(installations.install(review)).rejects.toThrow(/account changed/);
    expect(stores.byProfile.get('bob')?.size).toBe(0);
    expect(stores.byProfile.get('anonymous')?.size).toBe(0);
  });

  it('refuses an invalid file at review and an incompatible package at install', async () => {
    const installations = setup();
    await settle();

    const invalid = installations.review(bytes('{"manifest":{"id":"x"}}')) as PluginReview;
    expect(invalid.ok).toBe(false);
    expect(installations.review(new Uint8Array([0xff, 0xfe])).ok).toBe(false);

    const future = okReview(installations, packageText({ range: '>=99.0.0' }));
    expect(future.compatible).toBe(false);
    await expect(installations.install(future)).rejects.toThrow(/not made for this version/);
    expect(installations.plugins()).toEqual([]);
  });

  it('comes back after a restart from what was stored, with no network at all', async () => {
    let installations = setup();
    await settle();
    await installations.install(okReview(installations));
    await installations.setEnabled('dev.example.tint', true);

    // A new app session over the same store: nothing is fetched, everything is reread.
    TestBed.resetTestingModule();
    installations = setup();
    await settle();

    expect(installations.find('dev.example.tint')?.active).toBe(true);
  });

  it("keeps each account to its own plugins, never reusing another profile's packages", async () => {
    const installations = setup();
    await settle();
    await installations.install(okReview(installations));
    expect(installations.plugins()).toHaveLength(1);

    user.set({ id: 'alice' });
    await settle();
    expect(installations.plugins()).toEqual([]);
    expect(installations.host('dev.example.tint')).toBeNull();

    user.set(null);
    await settle();
    expect(installations.plugins()).toHaveLength(1);
  });

  it('loads nothing until the session is known, so a signed-in user never sees the anonymous profile', async () => {
    await stores.for('anonymous').put({
      id: 'dev.example.tint',
      text: packageText(),
      enabled: true,
      installedAt: '2026-01-01T00:00:00.000Z',
    });
    status.set('loading');
    const installations = setup();
    await settle();
    expect(installations.plugins()).toEqual([]);
    expect(installations.loading()).toBe(true);
    expect(installations.host('dev.example.tint')).toBeNull();

    user.set({ id: 'alice' });
    status.set('authenticated');
    await settle();
    expect(installations.plugins()).toEqual([]);
    expect(installations.loading()).toBe(false);
    expect([...stores.byProfile.keys()]).toEqual(['anonymous', 'alice']);
  });

  it('revalidates what it reads: a corrupted or outdated record comes back off, and can still be removed', async () => {
    stores.for('anonymous').put({
      id: 'dev.example.broken',
      text: '{ corrupted',
      enabled: true,
      installedAt: '2026-01-01T00:00:00.000Z',
    });
    stores.for('anonymous').put({
      id: 'dev.example.old',
      text: packageText({ id: 'dev.example.old', range: '<1.0.0' }),
      enabled: true,
      installedAt: '2026-01-01T00:00:00.000Z',
    });
    const installations = setup();
    await settle();

    const broken = installations.find('dev.example.broken')!;
    expect(broken.active).toBe(false);
    expect(broken.problem).toMatch(/valid package/);
    expect(installations.find('dev.example.old')!.active).toBe(false);
    await expect(installations.setEnabled('dev.example.old', true)).rejects.toThrow(/app versions/);

    await installations.remove('dev.example.broken');
    expect(installations.find('dev.example.broken')).toBeUndefined();
  });

  it('updates in place from a newer file of the same id, switched off again', async () => {
    const installations = setup();
    await settle();
    await installations.install(okReview(installations));
    await installations.setEnabled('dev.example.tint', true);

    const update = okReview(installations, packageText({ version: '1.1.0' }));
    expect(update.replaces).toBe('1.0.0');
    await installations.install(update);

    const installed = installations.find('dev.example.tint')!;
    expect(installed.plugin?.manifest.version).toBe('1.1.0');
    expect(installed.active).toBe(false);
  });

  it('adds a declarative effect twice, and both copies outlive the package', async () => {
    const installations = setup();
    await settle();
    await installations.install(okReview(installations));
    await installations.setEnabled('dev.example.tint', true);
    const installed = installations.find('dev.example.tint')!;
    const contribution = installed.plugin!.manifest.contributions[0] as EffectContribution;
    const adoption = TestBed.inject(EffectAdoption);

    const candidate = effectContributionCandidate(installed.plugin!, contribution);
    expect(adoption.adopt(candidate)).toEqual({ ok: true });
    expect(adoption.adopt(candidate)).toEqual({ ok: true });
    expect(probe).toHaveBeenCalledTimes(2);

    await installations.remove('dev.example.tint');

    const customs = draft()!.render.postProcessing.effects.filter(
      (effect): effect is CustomEffect => effect.type === 'custom',
    );
    expect(customs).toHaveLength(2);
    expect(customs[0]!.instanceId).not.toBe(customs[1]!.instanceId);
    expect(customs[0]!.definition).toMatchObject({ name: 'Red tint', source: candidate.source });
    expect(customs[0]!.values).toEqual({ amount: 0.5 });
  });

  it('adopts nothing the driver rejects, and nothing without an open shader', async () => {
    setup();
    const adoption = TestBed.inject(EffectAdoption);
    const candidate = { name: 'Bad', source: 'nope', controls: [], values: {} };
    const before = structuredClone(draft()!.render);

    probe.mockReturnValue([
      { severity: 'error', line: 1, message: 'syntax error', source: 'fragment' },
    ]);
    expect(adoption.adopt(candidate)).toMatchObject({ ok: false, reason: 'compile' });
    expect(draft()!.render).toEqual(before);

    draft.set(null);
    expect(adoption.adopt(candidate)).toEqual({ ok: false, reason: 'no-shader' });
  });
  it('gives operations a context that goes stale on disable, update, removal or sign-in', async () => {
    const installations = setup();
    await settle();
    await installations.install(okReview(installations));
    expect(installations.context('dev.example.tint')).toBeNull();
    await installations.setEnabled('dev.example.tint', true);

    const context = installations.context('dev.example.tint')!;
    expect(context).toMatchObject({ profile: 'anonymous', version: '1.0.0' });
    expect(installations.isCurrent(context)).toBe(true);

    const work = installations.begin('dev.example.tint');
    await installations.setEnabled('dev.example.tint', false);
    expect(work.signal.aborted).toBe(true);
    expect(installations.isCurrent(context)).toBe(false);

    await installations.setEnabled('dev.example.tint', true);
    const again = installations.context('dev.example.tint')!;
    const update = installations.begin('dev.example.tint');
    await installations.installReviewedUpdate(
      okReview(installations, packageText({ version: '1.1.0' })),
    );
    expect(update.signal.aborted).toBe(true);
    expect(installations.isCurrent(again)).toBe(false);
    expect(installations.find('dev.example.tint')?.active).toBe(false);

    await installations.setEnabled('dev.example.tint', true);
    const signedIn = installations.context('dev.example.tint')!;
    const pending = installations.begin('dev.example.tint');
    user.set({ id: 'bob' });
    status.set('authenticated');
    await settle();
    expect(pending.signal.aborted).toBe(true);
    expect(installations.isCurrent(signedIn)).toBe(false);
  });

  it('never installs a catalogue version over itself, and keeps the old one when an update fails', async () => {
    const installations = setup();
    await settle();
    await installations.install(okReview(installations));
    await expect(installations.installReviewedUpdate(okReview(installations))).rejects.toThrow(
      /already installed/,
    );

    const failing = installations.review(bytes(packageText({ version: '2.0.0' })));
    if (!failing.ok) throw new Error();
    stores.byProfile.get('anonymous')!.set = () => {
      throw new Error('disk full');
    };
    await expect(installations.installReviewedUpdate(failing)).rejects.toThrow(/disk full/);
    expect(installations.find('dev.example.tint')?.plugin?.manifest.version).toBe('1.0.0');
  });
});
/** A default's package as the catalogue would hand it over: data only. */
function defaultText(id: string, version = '1.0.0'): string {
  return JSON.stringify({
    manifest: {
      id,
      version,
      protocolVersion: 3,
      appVersionRange: '>=1.0.0',
      name: id,
      publisher: 'Shadergrove',
      license: 'Apache-2.0',
      contributions: [
        {
          kind: 'language',
          id: 'words',
          name: 'Words',
          schemaVersion: 1,
          locale: 'en',
          nativeName: 'English',
          direction: 'ltr',
          messages: { 'menu.file': 'File' },
        },
      ],
    },
  });
}

/** Stores that also keep the bootstrap state, as the web's and the desktop's do. */
class SeedingStores {
  readonly records = new Map<string, Map<string, StoredPlugin>>();
  readonly states = new Map<string, PluginBootstrapState>();
  readonly writes: string[] = [];
  /** Runs before a write lands, as another window would between a check and the write. */
  beforePut: ((profile: string, record: StoredPlugin) => Promise<void>) | null = null;
  /** Runs right after a seed's write lands, as another window would. */
  afterAdd: ((profile: string, record: StoredPlugin) => Promise<void>) | null = null;

  for(profile: string): PluginStore {
    const records = this.records.get(profile) ?? new Map<string, StoredPlugin>();
    this.records.set(profile, records);
    return {
      list: async () => [...records.values()],
      put: async (record) => {
        const before = this.beforePut;
        this.beforePut = null;
        await before?.(profile, record);
        this.writes.push(`${profile}:put:${record.id}`);
        records.set(record.id, record);
      },
      add: async (record) => {
        const before = this.beforePut;
        this.beforePut = null;
        await before?.(profile, record);
        if (records.has(record.id)) return false;
        this.writes.push(`${profile}:put:${record.id}`);
        records.set(record.id, record);
        const after = this.afterAdd;
        this.afterAdd = null;
        await after?.(profile, record);
        return true;
      },
      replace: async (record) => {
        if (records.get(record.id)?.installedAt !== record.installedAt) return false;
        this.writes.push(`${profile}:put:${record.id}`);
        records.set(record.id, record);
        return true;
      },
      remove: async (id) => {
        this.writes.push(`${profile}:remove:${id}`);
        records.delete(id);
      },
      readBootstrap: async () => structuredClone(this.states.get(profile) ?? emptyBootstrapState()),
      writeBootstrap: async (state) => {
        this.writes.push(`${profile}:bootstrap`);
        this.states.set(profile, structuredClone(state));
      },
    };
  }
}

class FakeCatalogue {
  readonly fetched: string[] = [];
  readonly failing = new Set<string>();
  texts = new Map(DEFAULT_PACKAGE_IDS.map((id) => [id, defaultText(id)]));
  /** Holds every fetch until opened. */
  gate: Promise<void> = Promise.resolve();
  /** Held one by one, in fetch order, before `gate`. */
  readonly gates: Promise<void>[] = [];

  async entry(id: string): Promise<CatalogueEntry | null> {
    return this.texts.has(id) ? ({ id } as CatalogueEntry) : null;
  }

  async fetchPackage(entry: CatalogueEntry): Promise<Uint8Array> {
    this.fetched.push(entry.id);
    await this.gates.shift();
    await this.gate;
    if (this.failing.has(entry.id)) throw new Error('offline');
    return bytes(this.texts.get(entry.id)!);
  }
}

/** A one-at-a-time lock shared by every "tab" of a test, as `navigator.locks` is. */
function installLocks(): () => void {
  const queues = new Map<string, Promise<unknown>>();
  const locks = {
    request: (name: string, work: () => Promise<unknown>) => {
      const run = (queues.get(name) ?? Promise.resolve()).then(work, work);
      queues.set(
        name,
        run.catch(() => undefined),
      );
      return run;
    },
  };
  const original = Object.getOwnPropertyDescriptor(navigator, 'locks');
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
  return () => {
    if (original) Object.defineProperty(navigator, 'locks', original);
    else delete (navigator as { locks?: unknown }).locks;
  };
}

describe('PluginInstallations — default packages', () => {
  let stores: SeedingStores;
  let catalogue: FakeCatalogue;
  let restoreLocks: () => void;
  const user = signal<{ id: string } | null>(null);
  const status = signal<'loading' | 'anonymous' | 'authenticated'>('anonymous');

  function providers() {
    return [
      provideZonelessChangeDetection(),
      { provide: PLUGIN_STORE, useValue: (profile: string) => stores.for(profile) },
      { provide: AuthService, useValue: { user, status } },
      { provide: PluginCatalogueService, useValue: catalogue },
    ];
  }

  function setup(): PluginInstallations {
    TestBed.configureTestingModule({ providers: providers() });
    return TestBed.inject(PluginInstallations);
  }

  /** A fresh app session over the same stores. */
  function restart(): PluginInstallations {
    TestBed.resetTestingModule();
    return setup();
  }

  async function settled(installations: PluginInstallations): Promise<void> {
    TestBed.tick();
    await vi.waitFor(() => {
      if (!installations.defaultsSettled()) throw new Error('not settled');
    });
  }

  const ids = (installations: PluginInstallations) =>
    installations.plugins().map((installed) => [installed.id, installed.active]);

  /** For the rest of a test: a browser without Web Locks, each window serializing only itself. */
  function withoutWebLocks(): void {
    restoreLocks();
    Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
    restoreLocks = () => delete (navigator as { locks?: unknown }).locks;
  }

  beforeEach(() => {
    stores = new SeedingStores();
    catalogue = new FakeCatalogue();
    user.set(null);
    status.set('anonymous');
    restoreLocks = installLocks();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    restoreLocks();
  });

  it('installs every default switched on, once, and leaves ordinary installs off', async () => {
    let installations = setup();
    await settled(installations);
    expect(ids(installations)).toEqual(DEFAULT_PACKAGE_IDS.map((id) => [id, true]).sort());
    expect(stores.states.get('anonymous')).toEqual({
      version: DEFAULT_PACKAGES_VERSION,
      packages: Object.fromEntries(DEFAULT_PACKAGE_IDS.map((id) => [id, 'seeded'])),
    });

    installations = restart();
    await settled(installations);
    expect(catalogue.fetched).toHaveLength(DEFAULT_PACKAGE_IDS.length);

    const review = installations.review(bytes(packageText()));
    if (!review.ok) throw new Error();
    await installations.install(review);
    expect(installations.find('dev.example.tint')?.active).toBe(false);
  });

  it('keeps a default switched off, and a removed one removed, across restarts and reinstalls', async () => {
    const [themes, english] = DEFAULT_PACKAGE_IDS as [string, string];
    let installations = setup();
    await settled(installations);
    await installations.setEnabled(themes, false);
    await installations.remove(english);
    // The removal is on record before the record is gone.
    expect(stores.writes.slice(-2)).toEqual(['anonymous:bootstrap', `anonymous:remove:${english}`]);
    expect(stores.states.get('anonymous')?.packages[english]).toBe('removed');

    installations = restart();
    await settled(installations);
    expect(installations.find(themes)?.active).toBe(false);
    expect(installations.find(english)).toBeUndefined();

    // Reinstalling is the user's, explicitly, and follows the ordinary rule: off.
    const review = installations.review(bytes(defaultText(english)));
    if (!review.ok) throw new Error();
    await installations.install(review);
    installations = restart();
    await settled(installations);
    expect(installations.find(english)?.active).toBe(false);
  });

  it('never replaces a default the profile already has, whatever its version or switch', async () => {
    const [themes] = DEFAULT_PACKAGE_IDS as [string];
    const mine = {
      id: themes,
      text: defaultText(themes, '0.9.0'),
      enabled: false,
      installedAt: '2026-01-01T00:00:00.000Z',
    };
    await stores.for('anonymous').put(mine);
    const installations = setup();
    await settled(installations);
    expect(installations.find(themes)?.stored).toEqual(mine);
    expect(catalogue.fetched).not.toContain(themes);
    expect(stores.states.get('anonymous')?.packages[themes]).toBe('seeded');
  });

  it('keeps what succeeded when one default fails, and tries only that one again', async () => {
    const [, english, french] = DEFAULT_PACKAGE_IDS as [string, string, string];
    catalogue.failing.add(french);
    let installations = setup();
    await settled(installations);
    expect(installations.find(english)?.active).toBe(true);
    expect(installations.find(french)).toBeUndefined();
    expect(stores.states.get('anonymous')?.packages[french]).toBeUndefined();

    catalogue.failing.clear();
    catalogue.fetched.length = 0;
    installations = restart();
    await settled(installations);
    expect(catalogue.fetched).toEqual([french]);
    expect(installations.find(french)?.active).toBe(true);
  });

  it('records a default an interrupted seed already wrote, without fetching it again', async () => {
    const [themes] = DEFAULT_PACKAGE_IDS as [string];
    // Written, then the app stopped before recording it.
    await stores.for('anonymous').put({
      id: themes,
      text: defaultText(themes),
      enabled: true,
      installedAt: '2026-01-01T00:00:00.000Z',
    });
    const installations = setup();
    await settled(installations);
    expect(catalogue.fetched).not.toContain(themes);
    expect(stores.states.get('anonymous')?.packages[themes]).toBe('seeded');
  });

  it("stops seeding when the profile changes, and never writes one profile's defaults into another", async () => {
    let open!: () => void;
    catalogue.gate = new Promise((resolve) => (open = resolve));
    const installations = setup();
    TestBed.tick();
    await vi.waitFor(() => expect(catalogue.fetched.length).toBeGreaterThan(0));

    user.set({ id: 'alice' });
    status.set('authenticated');
    TestBed.tick();
    open();
    await settled(installations);

    expect(stores.records.get('anonymous')?.size ?? 0).toBe(0);
    expect(stores.states.get('anonymous')).toBeUndefined();
    expect(ids(installations)).toEqual(DEFAULT_PACKAGE_IDS.map((id) => [id, true]).sort());
    expect(stores.writes.every((write) => write.startsWith('alice:'))).toBe(true);
  });

  it('seeds once when two windows start together on the same profile', async () => {
    const first = setup();
    const second = TestBed.runInInjectionContext(() => new PluginInstallations());
    await settled(first);
    await settled(second);
    expect(stores.writes.filter((write) => write.includes(':put:'))).toHaveLength(
      DEFAULT_PACKAGE_IDS.length,
    );
    // The window that found them seeded by the other one loads them too.
    expect(ids(second)).toEqual(ids(first));
    expect(ids(second)).toEqual(DEFAULT_PACKAGE_IDS.map((id) => [id, true]).sort());
  });

  it('opens its channel in the browser only, and closes it with the app', async () => {
    const channels: { close: ReturnType<typeof vi.fn> }[] = [];
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        readonly close = vi.fn();
        constructor() {
          channels.push(this);
        }
        addEventListener(): void {}
        postMessage(): void {}
      },
    );
    try {
      TestBed.configureTestingModule({
        providers: [...providers(), { provide: PLATFORM_ID, useValue: 'server' }],
      });
      TestBed.inject(PluginInstallations);
      expect(channels).toHaveLength(0);

      TestBed.resetTestingModule();
      setup();
      expect(channels).toHaveLength(1);
      TestBed.resetTestingModule();
      expect(channels[0]!.close).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not bring back a package another window removed when a stale list switches it', async () => {
    const [themes] = DEFAULT_PACKAGE_IDS as [string];
    const first = setup();
    await settled(first);
    const second = TestBed.runInInjectionContext(() => new PluginInstallations());
    await settled(second);
    expect(second.find(themes)).toBeDefined();

    await first.remove(themes);
    // Before the second window has heard of it, it still lists the pack and switches it.
    await second.setEnabled(themes, false);
    expect(stores.records.get('anonymous')!.has(themes)).toBe(false);
    await vi.waitFor(() => expect(second.find(themes)).toBeUndefined());
  });

  it('does not write an old version over an update another window made', async () => {
    const first = setup();
    await settled(first);
    const second = TestBed.runInInjectionContext(() => new PluginInstallations());
    await settled(second);
    const v1 = first.review(bytes(packageText()));
    if (!v1.ok) throw new Error(v1.errors.join());
    await first.install(v1);
    await vi.waitFor(() => expect(second.find('dev.example.tint')).toBeDefined());

    // Installs are told apart by their install time: let the clock move on.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const v2 = first.review(bytes(packageText({ version: '2.0.0' })));
    if (!v2.ok) throw new Error(v2.errors.join());
    await first.install(v2);
    // The second window still lists version 1 when it is switched there.
    await second.setEnabled('dev.example.tint', true);
    const stored = stores.records.get('anonymous')!.get('dev.example.tint')!;
    expect(JSON.parse(stored.text).manifest.version).toBe('2.0.0');
    expect(stored.enabled).toBe(false);
    await vi.waitFor(() =>
      expect(second.find('dev.example.tint')?.plugin?.manifest.version).toBe('2.0.0'),
    );
  });

  it("shows another window's changes at once, the output window's included", async () => {
    const [themes] = DEFAULT_PACKAGE_IDS as [string];
    const main = setup();
    await settled(main);
    const output = TestBed.runInInjectionContext(() => new PluginInstallations());
    await settled(output);
    expect(output.find(themes)?.active).toBe(true);

    await main.setEnabled(themes, false);
    await vi.waitFor(() => expect(output.find(themes)?.active).toBe(false));
    await main.remove(themes);
    await vi.waitFor(() => expect(output.find(themes)).toBeUndefined());
    const review = main.review(bytes(packageText()));
    if (!review.ok) throw new Error(review.errors.join());
    await main.install(review);
    await vi.waitFor(() => expect(output.find('dev.example.tint')).toBeDefined());
  });

  it('lets an install of a default made during a slow seed win, switched off', async () => {
    const [themes] = DEFAULT_PACKAGE_IDS as [string];
    let open!: () => void;
    catalogue.gate = new Promise((resolve) => (open = resolve));
    const installations = setup();
    TestBed.tick();
    await vi.waitFor(() => expect(catalogue.fetched).toContain(themes));

    const review = installations.review(bytes(defaultText(themes, '2.0.0')));
    if (!review.ok) throw new Error(review.errors.join());
    const install = installations.install(review);
    open();
    await install;
    await settled(installations);

    const stored = stores.records.get('anonymous')!.get(themes)!;
    expect(JSON.parse(stored.text).manifest.version).toBe('2.0.0');
    expect(stored.enabled).toBe(false);
    expect(installations.find(themes)?.active).toBe(false);
  });

  it('undoes its own write when a removal lands between its last check and the write', async () => {
    withoutWebLocks();
    const [themes] = DEFAULT_PACKAGE_IDS as [string];
    // Another window removes it — recorded, then deleted — just before this one's write lands.
    stores.beforePut = async (profile, record) => {
      expect(record.id).toBe(themes);
      const state = stores.states.get(profile) ?? emptyBootstrapState();
      stores.states.set(profile, {
        ...state,
        packages: { ...state.packages, [themes]: 'removed' },
      });
      stores.records.get(profile)?.delete(themes);
    };
    const installations = setup();
    await settled(installations);
    expect(stores.records.get('anonymous')!.has(themes)).toBe(false);
    expect(stores.states.get('anonymous')?.packages[themes]).toBe('removed');
    expect(installations.find(themes)).toBeUndefined();
  });

  it('without Web Locks, keeps an install another window made while the seed was fetching', async () => {
    withoutWebLocks();
    const [themes] = DEFAULT_PACKAGE_IDS as [string];
    let open!: () => void;
    catalogue.gates.push(new Promise((resolve) => (open = resolve)));
    const seeding = setup();
    TestBed.tick();
    await vi.waitFor(() => expect(catalogue.fetched).toEqual([themes]));
    // Another window installs it from a file — switched off — right before the seed's write.
    stores.beforePut = async (profile) => {
      stores.records.get(profile)!.set(themes, {
        id: themes,
        text: defaultText(themes, '2.0.0'),
        enabled: false,
        installedAt: '2026-01-01T00:00:00.000Z',
      });
    };
    open();
    await settled(seeding);
    const stored = stores.records.get('anonymous')!.get(themes)!;
    expect(JSON.parse(stored.text).manifest.version).toBe('2.0.0');
    expect(stored.enabled).toBe(false);
  });

  it('undoes only its own write: an install made after a removal is kept', async () => {
    withoutWebLocks();
    const [themes] = DEFAULT_PACKAGE_IDS as [string];
    const reinstalled = {
      id: themes,
      text: defaultText(themes, '2.0.0'),
      enabled: false,
      installedAt: '2026-01-01T00:00:00.000Z',
    };
    // Right after the seed's write, another window removes it, then installs it again.
    stores.afterAdd = async (profile) => {
      const state = stores.states.get(profile) ?? emptyBootstrapState();
      stores.states.set(profile, {
        ...state,
        packages: { ...state.packages, [themes]: 'removed' },
      });
      stores.records.get(profile)!.set(themes, reinstalled);
    };
    const installations = setup();
    await settled(installations);
    expect(stores.records.get('anonymous')!.get(themes)).toEqual(reinstalled);
    expect(stores.states.get('anonymous')?.packages[themes]).toBe('removed');
  });

  it('refuses an install that waited for a seed while the account changed', async () => {
    const [themes] = DEFAULT_PACKAGE_IDS as [string];
    let open!: () => void;
    catalogue.gate = new Promise((resolve) => (open = resolve));
    const installations = setup();
    TestBed.tick();
    await vi.waitFor(() => expect(catalogue.fetched).toContain(themes));
    const review = installations.review(bytes(defaultText(themes, '2.0.0')));
    if (!review.ok) throw new Error(review.errors.join());
    const install = installations.install(review);

    user.set({ id: 'alice' });
    status.set('authenticated');
    TestBed.tick();
    open();
    await expect(install).rejects.toThrow(/account changed/);
    await settled(installations);
    const anonymous = [...(stores.records.get('anonymous')?.values() ?? [])];
    expect(anonymous.some((record) => record.text.includes('"2.0.0"'))).toBe(false);
    expect(stores.records.get('alice')?.get(themes)?.enabled).toBe(true);
  });

  it('without Web Locks, a removal made while another window is still fetching stays removed', async () => {
    withoutWebLocks();
    const [themes] = DEFAULT_PACKAGE_IDS as [string];
    // The slow window's first fetch is held; everything else goes through.
    let open!: () => void;
    catalogue.gates.push(new Promise((resolve) => (open = resolve)));
    const slow = setup();
    TestBed.tick();
    await vi.waitFor(() => expect(catalogue.fetched).toEqual([themes]));

    const fast = TestBed.runInInjectionContext(() => new PluginInstallations());
    await settled(fast);
    expect(fast.find(themes)?.active).toBe(true);
    await fast.remove(themes);

    open();
    await settled(slow);
    expect(stores.records.get('anonymous')!.has(themes)).toBe(false);
    expect(stores.states.get('anonymous')?.packages[themes]).toBe('removed');
    expect(slow.find(themes)).toBeUndefined();
  });

  it('a removal during seeding waits for it, then stays removed', async () => {
    const [themes] = DEFAULT_PACKAGE_IDS as [string];
    await stores.for('anonymous').put({
      id: themes,
      text: defaultText(themes),
      enabled: true,
      installedAt: '2026-01-01T00:00:00.000Z',
    });
    let open!: () => void;
    catalogue.gate = new Promise((resolve) => (open = resolve));
    let installations = setup();
    TestBed.tick();
    await vi.waitFor(() => expect(installations.find(themes)).toBeDefined());
    const removal = installations.remove(themes);
    open();
    await removal;
    await settled(installations);
    expect(installations.find(themes)).toBeUndefined();

    installations = restart();
    await settled(installations);
    expect(installations.find(themes)).toBeUndefined();
  });

  it('installs nothing where defaults are not kept, and nothing but data', async () => {
    const [themes] = DEFAULT_PACKAGE_IDS as [string];
    catalogue.texts.set(themes, packageText({ id: themes }));
    let installations = setup();
    await settled(installations);
    expect(installations.find(themes)).toBeUndefined();

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [...providers(), { provide: PLUGIN_STORE, useValue: () => new NoPluginStore() }],
    });
    catalogue.fetched.length = 0;
    installations = TestBed.inject(PluginInstallations);
    await settled(installations);
    expect(catalogue.fetched).toEqual([]);
    expect(installations.plugins()).toEqual([]);
  });

  it('settles with nothing loaded where the store cannot be read', async () => {
    TestBed.configureTestingModule({
      providers: [
        ...providers(),
        {
          provide: PLUGIN_STORE,
          useValue: () => ({
            ...stores.for('anonymous'),
            list: () => Promise.reject(new Error('Plugins are managed from the main window only')),
          }),
        },
      ],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const installations = TestBed.inject(PluginInstallations);
    await settled(installations);
    expect(installations.plugins()).toEqual([]);
    expect(catalogue.fetched).toEqual([]);
    warn.mockRestore();
  });
});
