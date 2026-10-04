import { isPlatformBrowser } from '@angular/common';
import {
  DestroyRef,
  Injectable,
  InjectionToken,
  computed,
  effect,
  PLATFORM_ID,
  inject,
  signal,
  untracked,
} from '@angular/core';

import {
  DEFAULT_PACKAGES_VERSION,
  DEFAULT_PACKAGE_IDS,
  isDataOnlyPackage,
  isDefaultPackageId,
  isPluginCompatible,
  parsePluginPackage,
  type PluginPackage,
} from '@shadergrove/shared/plugin';
import { APP_VERSION } from '@shadergrove/shared/version';
import { AuthService } from '../auth/auth.service';
import { DesktopPlatform } from '../desktop/desktop-platform';
import { isOutputWindow } from '../output-mode';
import { PluginCatalogueService } from './plugin-catalogue';
import { PluginHost } from './plugin-host';
import {
  DesktopPluginStore,
  IndexedDbPluginStore,
  NoPluginStore,
  type PluginStore,
  type StoredPlugin,
} from './plugin-store';

/**
 * The store for one profile. Replaced in tests. On the desktop every window
 * reads the one store, but only the main window manages it: the main process
 * shows the output and satellite windows the data-only packages (themes and
 * languages) and nothing to seed. On the web, the output view gets none.
 */
export const PLUGIN_STORE = new InjectionToken<(profile: string) => PluginStore>('PLUGIN_STORE', {
  providedIn: 'root',
  factory: () => {
    const desktop = inject(DesktopPlatform);
    return (profile: string) => {
      if (desktop.available) return new DesktopPluginStore();
      if (isOutputWindow()) return new NoPluginStore();
      if (typeof indexedDB === 'undefined') return new NoPluginStore();
      return new IndexedDbPluginStore(`shadergrove-plugins:${profile}`);
    };
  },
});

/** What a package file holds, before anything is installed. */
export type PluginReview =
  | {
      ok: true;
      plugin: PluginPackage;
      text: string;
      compatible: boolean;
      replaces: string | null;
      /** The profile it was read for: it installs there or nowhere. */
      profile: string | null;
    }
  | { ok: false; errors: string[] };

/**
 * Who an operation started for. A plugin call is asynchronous; its result is
 * only adopted (or written) if this still describes the current state — the
 * same profile, and the same package version, installed at the same moment,
 * still switched on.
 */
export interface PluginOperationContext {
  profile: string;
  id: string;
  version: string;
  installedAt: string;
}

export interface InstalledPlugin {
  id: string;
  stored: StoredPlugin;
  /** `null` when the stored text no longer validates. */
  plugin: PluginPackage | null;
  /** Why it cannot run, if it cannot: invalid on disk, or not for this app version. */
  problem: string | null;
  /** Switched on, and nothing stops it running. */
  active: boolean;
}

/**
 * The locally installed plugins of the current profile.
 *
 * Installing is explicit and leaves the package off; the user switches it on.
 * Every load revalidates what was stored — a file corrupted on disk, or a
 * package for another app version, comes back inactive with the reason — and a
 * profile change (signing in or out on the web) reloads from that profile's own
 * store, so nothing installed under one account runs under another.
 *
 * Removing a package never touches a shader: an effect taken from it was copied.
 *
 * The default packages (`DEFAULT_PACKAGE_IDS`, the app's own list) are the one
 * exception to installing switched off: once a profile has loaded, each default
 * it never had is installed from this release's catalogue, switched on, and
 * remembered as seeded, so it is never installed again — not after it is
 * switched off, removed, or the app is upgraded. Removing one is remembered
 * before it is deleted. Seeding is serialized across tabs and windows, writes
 * only to the profile it started for, and a default that could not be
 * installed is simply tried again next time; the app works without it.
 */
@Injectable({ providedIn: 'root' })
export class PluginInstallations {
  private readonly storeFor = inject(PLUGIN_STORE);
  private readonly auth = inject(AuthService);

  /**
   * The web's partition key, or `null` while the session is still being
   * resolved: until then nothing is loaded, rather than show — and offer to run —
   * the anonymous profile's plugins to someone about to turn out signed in. The
   * desktop app has one profile, its user data.
   */
  readonly profile = computed(() =>
    this.auth.status() === 'loading' ? null : (this.auth.user()?.id ?? 'anonymous'),
  );

  private readonly pluginsSignal = signal<InstalledPlugin[]>([]);
  readonly plugins = this.pluginsSignal.asReadonly();
  readonly loading = signal(true);
  /**
   * Whether the current profile's defaults are settled: seeded, found seeded,
   * failed for now, or never seeded here. Until then a missing default may be
   * on its way, so whatever would migrate a preference onto one waits for this.
   */
  readonly defaultsSettled = signal(false);

  private readonly catalogue = inject(PluginCatalogueService);
  private store: PluginStore = new NoPluginStore();
  private loads = 0;
  /** Bumped on every profile switch: work started under an older one stops writing. */
  private generation = 0;
  private queue: Promise<unknown> = Promise.resolve();
  /**
   * Tells the other windows and tabs of this origin that a profile's packages
   * changed, so the one still showing it reloads — the output window included.
   */
  private readonly channel =
    isPlatformBrowser(inject(PLATFORM_ID)) && typeof BroadcastChannel !== 'undefined'
      ? new BroadcastChannel('shadergrove-plugins')
      : null;
  /** Work under way per package; aborted when the package is switched off, replaced or removed. */
  private readonly pending = new Map<string, Set<AbortController>>();

  constructor() {
    effect(() => {
      const profile = this.profile();
      untracked(() => void this.switchTo(profile));
    });
    inject(DestroyRef).onDestroy(() => this.channel?.close());
    this.channel?.addEventListener('message', (event: MessageEvent<{ profile?: unknown }>) => {
      if (event.data?.profile !== this.profile()) return;
      this.reload().catch((error: unknown) => console.warn('Plugins could not be reloaded', error));
    });
  }

  /** Reads a package file without installing anything. */
  review(bytes: Uint8Array): PluginReview {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return { ok: false, errors: ['The file is not UTF-8 text'] };
    }
    const parsed = parsePluginPackage(text);
    if (!parsed.ok) return parsed;
    const existing = this.find(parsed.value.manifest.id);
    return {
      ok: true,
      plugin: parsed.value,
      text,
      compatible: isPluginCompatible(parsed.value.manifest, APP_VERSION),
      replaces: existing?.plugin?.manifest.version ?? (existing ? '?' : null),
      profile: this.profile(),
    };
  }

  /**
   * Installs a reviewed package, switched off. A newer file of an installed id
   * replaces it — that is how a local update is done — and keeps it off too.
   */
  async install(review: Extract<PluginReview, { ok: true }>): Promise<void> {
    if (!review.compatible) throw new Error('This package is not made for this version of the app');
    if (review.profile === null || review.profile !== this.profile()) {
      throw new Error('The account changed since this package was picked; pick it again');
    }
    // A replacement must not let work started on the old version finish against the new one.
    const id = review.plugin.manifest.id;
    this.abortPending(id);
    const store = this.store;
    const write = async () => {
      // Checked again once the lock is ours: the account can change while an install waits.
      if (this.profile() !== review.profile || this.store !== store) {
        throw new Error('The account changed since this package was picked; pick it again');
      }
      await store.put({
        id,
        text: review.text,
        enabled: false,
        installedAt: new Date().toISOString(),
      });
    };
    // A default can be seeding right now: the user's install waits for it, and then wins.
    if (isDefaultPackageId(id)) await this.exclusive(review.profile, write);
    else await write();
    await this.changed();
  }

  /**
   * Installs a catalogue package whose bytes were already checked against
   * their entry. Versions are immutable: the same version is never installed
   * over itself. A newer one replaces the old only here, explicitly, and is
   * left off like any install; until the write succeeds, the old one stays.
   */
  async installReviewedUpdate(review: Extract<PluginReview, { ok: true }>): Promise<void> {
    const existing = this.find(review.plugin.manifest.id);
    if (existing?.plugin?.manifest.version === review.plugin.manifest.version) {
      throw new Error(`Version ${review.plugin.manifest.version} is already installed`);
    }
    this.abortPending(review.plugin.manifest.id);
    await this.install(review);
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const installed = this.find(id);
    if (!installed) return;
    if (enabled && installed.problem) throw new Error(installed.problem);
    if (!enabled) this.abortPending(id);
    // Only over the install this window lists: another window may have removed or updated
    // it since, and switching it must neither bring it back nor undo the update.
    await this.store.replace({ ...installed.stored, enabled });
    await this.changed();
  }

  async remove(id: string): Promise<void> {
    this.abortPending(id);
    const store = this.store;
    const profile = this.profile();
    if (isDefaultPackageId(id) && profile !== null) {
      // Remembered first: if the delete never happens, it is still not seeded again.
      await this.exclusive(profile, async () => {
        const state = await store.readBootstrap();
        if (state) {
          state.packages[id] = 'removed';
          await store.writeBootstrap(state);
        }
        await store.remove(id);
      });
    } else {
      await store.remove(id);
    }
    await this.changed();
  }

  /** The context an operation on an active package starts under, or `null` if it may not start. */
  context(id: string): PluginOperationContext | null {
    const installed = this.find(id);
    const profile = this.profile();
    if (!installed?.active || !installed.plugin || profile === null) return null;
    return {
      profile,
      id,
      version: installed.plugin.manifest.version,
      installedAt: installed.stored.installedAt,
    };
  }

  /** Whether an operation's context still holds: nothing changed under it. */
  isCurrent(context: PluginOperationContext): boolean {
    const now = this.context(context.id);
    return (
      now !== null &&
      now.profile === context.profile &&
      now.version === context.version &&
      now.installedAt === context.installedAt
    );
  }

  /**
   * Register work on a package. Its signal aborts when the package is
   * switched off, updated or removed, or the profile changes; call `done`
   * when the work ends.
   */
  begin(id: string): { signal: AbortSignal; done: () => void } {
    const controller = new AbortController();
    const set = this.pending.get(id) ?? new Set<AbortController>();
    set.add(controller);
    this.pending.set(id, set);
    return {
      signal: controller.signal,
      done: () => {
        set.delete(controller);
        if (set.size === 0 && this.pending.get(id) === set) this.pending.delete(id);
      },
    };
  }

  private abortPending(id?: string): void {
    for (const [key, set] of this.pending) {
      if (id !== undefined && key !== id) continue;
      for (const controller of set) controller.abort(new Error('The plugin changed'));
      set.clear();
      this.pending.delete(key);
    }
  }

  /** A host for an active plugin's importers and exporters; `null` for anything else. */
  host(id: string): PluginHost | null {
    const installed = this.find(id);
    return installed?.active && installed.plugin ? new PluginHost(installed.plugin) : null;
  }

  find(id: string): InstalledPlugin | undefined {
    return this.pluginsSignal().find((installed) => installed.id === id);
  }

  private async switchTo(profile: string | null): Promise<void> {
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    this.abortPending();
    this.pluginsSignal.set([]);
    this.defaultsSettled.set(false);
    if (profile === null) {
      // Any load still in flight belongs to a profile that is no longer current.
      this.loads++;
      this.store = new NoPluginStore();
      this.loading.set(true);
      return;
    }
    const store = (this.store = this.storeFor(profile));
    try {
      await this.reload();
      await this.seedDefaults(profile, store, current);
    } catch (error) {
      // Nothing installed is readable here (a window that manages no plugins, storage
      // refused): the app runs on its fallbacks.
      console.warn('Plugins could not be loaded', error);
    } finally {
      if (current()) this.defaultsSettled.set(true);
    }
  }

  /** Installs, switched on, each default this profile never had. See the class comment. */
  private async seedDefaults(
    profile: string,
    store: PluginStore,
    current: () => boolean,
  ): Promise<void> {
    let seeds = false;
    await this.exclusive(profile, async () => {
      // Read inside the lock: another tab may have just seeded, or a removal landed.
      const state = await store.readBootstrap();
      if (!state || !current()) return;
      seeds = true;
      const missing = DEFAULT_PACKAGE_IDS.filter((id) => state.packages[id] === undefined);
      for (const id of missing) {
        try {
          if (!(await this.isInstalled(store, id))) {
            const text = await this.defaultPackageText(id);
            if (!current()) return;
            // Checked again after the fetch, against what is stored now: without Web Locks
            // another window may have removed it meanwhile. And written only if still absent,
            // in one step, so an install made meanwhile — anywhere — is kept as it is.
            const now = await store.readBootstrap();
            const record = { id, text, enabled: true, installedAt: new Date().toISOString() };
            if (now?.packages[id] === undefined && (await store.add(record))) {
              // A removal records itself before it deletes: if one was recorded by the time
              // this write landed, its delete may already have run, so undo the write — this
              // write only, never an install made after it.
              if ((await store.readBootstrap())?.packages[id] === 'removed') {
                await store.removeIf(record);
                continue;
              }
            }
          }
          if (!current()) return;
          await this.recordSeeded(store, id);
        } catch (error) {
          // Left unrecorded, so it is tried again next time; what did succeed stays done.
          console.warn(`The default package ${id} could not be installed`, error);
        }
      }
    });
    // Reloaded even when nothing was written here: another tab may have seeded this profile
    // after the first load of this one. And announced, for a window that loaded before it.
    if (seeds && current()) await this.changed();
  }

  /** Reloads after a write here, and has the other windows of the same profile reload too. */
  private async changed(): Promise<void> {
    const profile = this.profile();
    if (profile !== null) this.channel?.postMessage({ profile });
    await this.reload();
  }

  private async isInstalled(store: PluginStore, id: string): Promise<boolean> {
    return (await store.list()).some((record) => record.id === id);
  }

  /** Records a default as seeded on top of the state stored now, so a removal recorded meanwhile wins. */
  private async recordSeeded(store: PluginStore, id: string): Promise<void> {
    const state = await store.readBootstrap();
    if (!state || state.packages[id] !== undefined) return;
    state.packages[id] = 'seeded';
    state.version = DEFAULT_PACKAGES_VERSION;
    await store.writeBootstrap(state);
  }

  /**
   * A default's package text, from this release's catalogue and checked
   * against its entry. Only data — themes and languages — is ever installed
   * this way, whatever the catalogue says.
   */
  private async defaultPackageText(id: string): Promise<string> {
    const entry = await this.catalogue.entry(id);
    if (!entry) throw new Error("It is not in this release's catalogue");
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      await this.catalogue.fetchPackage(entry),
    );
    const parsed = parsePluginPackage(text);
    if (!parsed.ok) throw new Error(parsed.errors[0]);
    if (!isDataOnlyPackage(parsed.value)) {
      throw new Error('A default package must hold themes or languages only');
    }
    if (!isPluginCompatible(parsed.value.manifest, APP_VERSION)) {
      throw new Error('It is not made for this version of the app');
    }
    return text;
  }

  /** Runs `work` alone among every tab and window of this profile; one at a time here otherwise. */
  private exclusive(profile: string, work: () => Promise<void>): Promise<void> {
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    if (locks) return locks.request(`shadergrove-plugin-defaults:${profile}`, work);
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async reload(): Promise<void> {
    const load = ++this.loads;
    const store = this.store;
    this.loading.set(true);
    try {
      const stored = await store.list();
      // A newer load — another profile, another change — has the last word.
      if (load !== this.loads) return;
      this.pluginsSignal.set(stored.map(toInstalled).sort((a, b) => a.id.localeCompare(b.id)));
    } finally {
      if (load === this.loads) this.loading.set(false);
    }
  }
}

function toInstalled(stored: StoredPlugin): InstalledPlugin {
  const parsed = parsePluginPackage(stored.text);
  if (!parsed.ok) {
    return {
      id: stored.id,
      stored,
      plugin: null,
      problem: `No longer a valid package: ${parsed.errors[0]}`,
      active: false,
    };
  }
  const compatible = isPluginCompatible(parsed.value.manifest, APP_VERSION);
  const problem = compatible
    ? null
    : `Made for app versions ${parsed.value.manifest.appVersionRange}, not ${APP_VERSION}`;
  if (parsed.value.manifest.id !== stored.id) {
    return {
      id: stored.id,
      stored,
      plugin: null,
      problem: 'Stored under another id',
      active: false,
    };
  }
  return {
    id: stored.id,
    stored,
    plugin: parsed.value,
    problem,
    active: stored.enabled && !problem,
  };
}
