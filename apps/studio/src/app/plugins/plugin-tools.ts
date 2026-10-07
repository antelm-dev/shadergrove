/**
 * The host side of protocol-4 tool contributions: which tools are on offer, the
 * adapters that draw their panels, and the guarded sessions their calls run in.
 *
 * - A **tool** is an active `analyzer` or `assetTool` contribution that this app
 *   has a registered adapter for. Adapters are the app's, registered in its
 *   providers (`provideToolAdapters`) — a package registers no component, file,
 *   GPU or network hook — and an analyzer or an `assetTool`'s workflow with no
 *   adapter is simply not offered. Nothing here names a package.
 * - A **template** is an active `projectTemplate`: data only, offered whether or
 *   not any adapter exists, and instantiated with fresh identities.
 * - A **session** (`ToolSession`) is one panel's conversation with one tool. Each
 *   request captures who it started for — profile, package, version and install
 *   time, the open shader and its source fingerprint when the tool works on a
 *   project, the target capability profile — and a monotone generation. A newer
 *   request supersedes the older one (terminating its Worker, or skipping it if
 *   it never started), and a result is shown, applied, downloaded or assigned
 *   only if all of that still holds *at that moment*: switching the package off,
 *   updating or removing it, changing profile, or — for a project-derived result
 *   — editing or changing the draft makes it vanish at once. Independent file
 *   operations (no project source) stay independent until an assignment names a
 *   target (`deliver`'s `target`). An analyzer report is also bound to the
 *   capability profile it ran for: the session's `target` is the profile of the
 *   latest `analyze` call, set the moment the call is made, so after a target
 *   switch the old report is out of date — while the new request runs, and for
 *   good if it fails, even before any Worker starts.
 *
 * The windows that manage no plugins (the output window, the SSR render) offer
 * nothing and open no session: `available` is false there, so no Worker, file or
 * GPU session can start.
 */
import { isPlatformBrowser } from '@angular/common';
import {
  Injectable,
  InjectionToken,
  PLATFORM_ID,
  computed,
  inject,
  signal,
  type Provider,
  type Signal,
  type Type,
} from '@angular/core';

import {
  CAPABILITY_PROFILE_IDS,
  instantiateProjectTemplate,
  sourceFingerprint,
  type AnalyzerContribution,
  type AnalyzerReport,
  type AnalyzerRequest,
  type AssetToolContribution,
  type AssetToolOutput,
  type AssetToolRequest,
  type AssetWorkflowId,
  type CapabilityProfileId,
  type ProjectTemplateContribution,
  type ProjectTemplatePayload,
} from '@shadergrove/shared/plugin';
import type { Result } from '@shadergrove/shared/validate';
import { isOutputWindow } from '../output-mode';
import { ShaderStore } from '../workspace/shader-store';
import type { AdapterCommand } from './host-adapters';
import { PluginCallError } from './plugin-host';
import {
  PluginInstallations,
  type InstalledPlugin,
  type PluginOperationContext,
} from './plugin-installations';

// --- Adapters -------------------------------------------------------------------

interface ToolAdapterBase {
  /** How the menu and palette offer the tool: host text and a Material icon. */
  readonly command: AdapterCommand;
  /**
   * The panel the Installed card shows. A standalone component with one required
   * input, `session` (`ToolPanelInputs`); it draws everything and delivers
   * through `session.deliver`.
   */
  readonly panel: Type<unknown>;
  /** The tool works on the open draft: its command is dimmed while none is open. */
  readonly needsProject: boolean;
}

/** Draws every `analyzer` (one panel kind: the app has one report view). */
export interface AnalyzerToolAdapter extends ToolAdapterBase {
  readonly kind: 'analyzer';
}

/** Draws every `assetTool` that names its workflow. */
export interface AssetToolAdapter extends ToolAdapterBase {
  readonly kind: 'assetTool';
  readonly workflow: AssetWorkflowId;
  /**
   * Validate operation settings against the workflow's own schema. Called by the
   * session before anything is sent; what it returns is what the Worker gets.
   */
  validateSettings(operation: string, settings: unknown): Result<Record<string, unknown>>;
}

export type ToolAdapter = AnalyzerToolAdapter | AssetToolAdapter;

/** What a panel component receives. */
// A type alias, not an interface: it is an input record for `ngComponentOutlet`.
export type ToolPanelInputs = { session: ToolSession };

export const TOOL_ADAPTERS = new InjectionToken<ToolAdapter[]>('TOOL_ADAPTERS');

/** Register tool adapters in the app's providers. */
export function provideToolAdapters(adapters: Type<ToolAdapter>[]): Provider[] {
  return adapters.map((useClass): Provider => ({ provide: TOOL_ADAPTERS, useClass, multi: true }));
}

// --- Entries --------------------------------------------------------------------

export type ToolContribution = AnalyzerContribution | AssetToolContribution;

export interface ActiveTool {
  /** `<packageId>/<contributionId>`: two packages never share one. */
  readonly ref: string;
  readonly installed: InstalledPlugin;
  readonly contribution: ToolContribution;
  readonly adapter: ToolAdapter;
}

export interface ActiveTemplate {
  readonly ref: string;
  readonly installed: InstalledPlugin;
  readonly contribution: ProjectTemplateContribution;
  readonly payload: ProjectTemplatePayload;
}

/** The part of the open document a project-derived result was computed from. */
export interface ToolSource {
  shaderId: string;
  fingerprint: string;
}

const sameSource = (a: ToolSource | null, b: ToolSource | null): boolean =>
  a === b ||
  (a !== null && b !== null && a.shaderId === b.shaderId && a.fingerprint === b.fingerprint);

@Injectable({ providedIn: 'root' })
export class PluginTools {
  readonly installations = inject(PluginInstallations);
  private readonly adapters = inject(TOOL_ADAPTERS, { optional: true }) ?? [];
  private readonly store = inject(ShaderStore);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));

  /**
   * Whether this window may run tools at all. False on the server render and
   * in the output window — the same windows that manage no plugins.
   */
  readonly available = this.browser && !isOutputWindow();

  /**
   * The open draft's source, as a tool sees it: shader, project, controls,
   * values and render settings, fingerprinted. `null` when none is open. A
   * computed: it is only evaluated while something reads it.
   */
  readonly draftSource = computed<ToolSource | null>(() => {
    const shaderId = this.store.selectedId();
    const draft = this.store.draft();
    if (!shaderId || !draft) return null;
    return {
      shaderId,
      fingerprint: sourceFingerprint({
        project: draft.project,
        render: draft.render,
        controls: this.store.controls(),
        params: this.store.params(),
      }),
    };
  });

  /** Every active tool with a registered adapter, in package then manifest order. */
  readonly tools = computed<readonly ActiveTool[]>(() => {
    if (!this.available) return [];
    return this.installations
      .plugins()
      .filter((installed) => installed.active && installed.plugin)
      .flatMap((installed) =>
        installed.plugin!.manifest.contributions.flatMap((contribution) => {
          if (contribution.kind !== 'analyzer' && contribution.kind !== 'assetTool') return [];
          const adapter = this.adapterFor(contribution);
          if (!adapter) return [];
          return [{ ref: `${installed.id}/${contribution.id}`, installed, contribution, adapter }];
        }),
      );
  });

  /** Every active template, whether or not any adapter exists: they are data. */
  readonly templates = computed<readonly ActiveTemplate[]>(() => {
    if (!this.available) return [];
    return this.installations
      .plugins()
      .filter((installed) => installed.active && installed.plugin)
      .flatMap((installed) =>
        installed.plugin!.manifest.contributions.flatMap((contribution) => {
          if (contribution.kind !== 'projectTemplate') return [];
          const payload = installed.plugin!.templates[contribution.id];
          if (!payload) return [];
          return [{ ref: `${installed.id}/${contribution.id}`, installed, contribution, payload }];
        }),
      );
  });

  /** The registered adapter for a contribution, or `null`: unknown workflows get no panel. */
  adapterFor(contribution: ToolContribution): ToolAdapter | null {
    return (
      this.adapters.find((adapter) =>
        contribution.kind === 'analyzer'
          ? adapter.kind === 'analyzer'
          : adapter.kind === 'assetTool' && adapter.workflow === contribution.workflow,
      ) ?? null
    );
  }

  /** The tools of one package, for its Installed card. */
  toolsOf(packageId: string): readonly ActiveTool[] {
    return this.tools().filter((tool) => tool.installed.id === packageId);
  }

  /** The active tool a reference names right now, or `null`. */
  find(packageId: string, contributionId: string): ActiveTool | null {
    return (
      this.tools().find(
        (tool) => tool.installed.id === packageId && tool.contribution.id === contributionId,
      ) ?? null
    );
  }

  /**
   * A session for an active tool, or `null` when it is not offered (switched
   * off, no adapter, or a window that runs no tools). `source` overrides the
   * source results are tied to: the open draft by default for an analyzer, none
   * for an asset tool (file operations are independent of the project).
   */
  openSession(
    packageId: string,
    contributionId: string,
    options: { source?: (() => ToolSource | null) | null } = {},
  ): ToolSession | null {
    const tool = this.find(packageId, contributionId);
    if (!tool) return null;
    const source =
      options.source === null
        ? null
        : (options.source ?? (tool.contribution.kind === 'analyzer' ? this.draftSource : null));
    return new ToolSession(this.installations, tool, source);
  }

  /**
   * A template's data with fresh identities, if its package is still active.
   * The caller (the New flow) adopts the copy atomically, or drops it.
   */
  instantiate(
    packageId: string,
    contributionId: string,
    context?: PluginOperationContext | null,
  ): ProjectTemplatePayload | null {
    if (context && !this.installations.isCurrent(context)) return null;
    const entry = this.templates().find(
      (template) =>
        template.installed.id === packageId && template.contribution.id === contributionId,
    );
    return entry ? instantiateProjectTemplate(entry.payload) : null;
  }
}

// --- Sessions -------------------------------------------------------------------

export type ToolOutcome<T> =
  | { status: 'ok'; value: T }
  /** A newer request replaced it; nothing is shown. */
  | { status: 'superseded' }
  /** The plugin, profile or source changed under it; nothing is shown. */
  | { status: 'stale' }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string; code?: PluginCallError['code'] };

export type ToolDelivery<R> =
  | { status: 'delivered'; value: R }
  | { status: 'stale' }
  | { status: 'failed'; message: string };

interface Capture {
  generation: number;
  context: PluginOperationContext;
  source: ToolSource | null;
  /** The capability profile an analyzer request ran for; `null` for an asset tool. */
  profileId: string | null;
}

/** Why an operation stopped without a result. */
class Superseded extends Error {}
class StaleResult extends Error {}
class Cancelled extends Error {}

/** What a session shows: the latest result that still holds, with what it was computed for. */
export interface ToolResultView<T> {
  value: T;
  source: ToolSource | null;
  /** The request generation that produced it. */
  generation: number;
}

export class ToolSession {
  readonly packageId: string;
  readonly contributionId: string;
  readonly adapter: ToolAdapter;
  private readonly contribution: ToolContribution;

  private generation = 0;
  private inFlight: AbortController | null = null;
  private readonly closed = new AbortController();
  private readonly state = signal<{ capture: Capture; value: unknown } | null>(null);
  private readonly targetSignal = signal<string | null>(null);
  private readonly runningSignal = signal(false);
  private readonly errorSignal = signal<string | null>(null);

  /**
   * The capability profile the latest `analyze` call asked for, set when the
   * call is made — whether or not it then runs, fails or is refused. A report
   * shows only while it is the report of this profile. `null` until an analyzer
   * is first asked, and always for an asset tool.
   */
  readonly target = this.targetSignal.asReadonly();
  /** Whether a request is under way. */
  readonly running = this.runningSignal.asReadonly();
  /** The message of the last failed request, until the next one starts. */
  readonly error = this.errorSignal.asReadonly();

  /**
   * The displayed result: the latest one, and only while everything it was
   * computed under still holds. Reactive — it turns `null` the moment the plugin
   * changes, the capability profile an analyzer targets switches, or the source
   * is edited.
   */
  readonly result: Signal<ToolResultView<AnalyzerReport | AssetToolOutput> | null> = computed(
    () => {
      const state = this.state();
      if (!state || !this.holds(state.capture)) return null;
      return {
        value: state.value as AnalyzerReport | AssetToolOutput,
        source: state.capture.source,
        generation: state.capture.generation,
      };
    },
  );

  /** A result exists but no longer holds: show "out of date", not the result. */
  readonly stale = computed(() => this.state() !== null && this.result() === null);

  constructor(
    private readonly installations: PluginInstallations,
    tool: ActiveTool,
    private readonly source: (() => ToolSource | null) | null,
  ) {
    this.packageId = tool.installed.id;
    this.contributionId = tool.contribution.id;
    this.adapter = tool.adapter;
    this.contribution = tool.contribution;
  }

  /** Whether a capture still describes the world: plugin, profile, version, install, target and source. */
  private holds(capture: Capture): boolean {
    if (this.closed.signal.aborted || !this.installations.isCurrent(capture.context)) return false;
    if (capture.profileId !== this.targetSignal()) return false;
    return this.source === null || sameSource(this.source(), capture.source);
  }

  /**
   * Run the analyzer against a host-selected capability profile. Newer requests
   * supersede it.
   *
   * `profileId` becomes the session's `target` at once, before anything can
   * fail: a report for another profile stops showing now, while this request
   * runs and if it never lands (an undeclared or unknown profile, a stopped
   * Worker, an invalid snapshot).
   *
   * Snapshot coherence: the caller supplies the snapshot, and the request's
   * `revision` is the fingerprint of that snapshot, while the staleness check
   * compares the source's own fingerprint (`PluginTools.draftSource`, read from
   * `ShaderStore` when the request starts). The two describe one draft only if
   * the snapshot is built from the store in the same tick as this call — no
   * `await` in between, which is how a project-derived panel must call it. A
   * load state that changes later does not change `draftSource`; a tool that
   * wants it to invalidate a report passes a `source` to `openSession`.
   */
  analyze(
    profileId: CapabilityProfileId,
    snapshot: Omit<AnalyzerRequest, 'profileId' | 'revision'>,
  ): Promise<ToolOutcome<AnalyzerReport>> {
    if (this.closed.signal.aborted) return Promise.resolve({ status: 'cancelled' });
    if (this.contribution.kind !== 'analyzer') {
      return Promise.resolve({ status: 'failed', message: 'This tool is not an analyzer.' });
    }
    this.targetSignal.set(profileId);
    if (!CAPABILITY_PROFILE_IDS.includes(profileId)) {
      return Promise.resolve({ status: 'failed', message: 'Unknown capability profile.' });
    }
    return this.execute<AnalyzerReport>(true, profileId, (host, signal) =>
      host.analyze(
        this.contributionId,
        { ...snapshot, profileId, revision: sourceFingerprint(snapshot) },
        { signal },
      ),
    );
  }

  /**
   * Run the asset tool. Settings go through the workflow adapter first; planes
   * are copied before they cross, so the buffers the caller passes stay usable
   * and are never detached. Previews are coalesced: each request supersedes the
   * one before it.
   */
  runAsset(request: AssetToolRequest): Promise<ToolOutcome<AssetToolOutput>> {
    if (this.closed.signal.aborted) return Promise.resolve({ status: 'cancelled' });
    if (this.contribution.kind !== 'assetTool' || this.adapter.kind !== 'assetTool') {
      return Promise.resolve({ status: 'failed', message: 'This tool is not an asset tool.' });
    }
    const settings = this.adapter.validateSettings(request.operation, request.settings ?? {});
    if (!settings.ok) {
      return Promise.resolve({
        status: 'failed',
        message: settings.errors[0] ?? 'Invalid settings',
      });
    }
    return this.execute<AssetToolOutput>(false, null, (host, signal) =>
      host.runAssetTool(this.contributionId, { ...request, settings: settings.value }, { signal }),
    );
  }

  /** Abort the request under way, if any. Its result is not shown. */
  cancel(): void {
    this.inFlight?.abort(new Cancelled());
  }

  /** Forget the displayed result (a panel's "clear"). */
  clear(): void {
    this.state.set(null);
  }

  /** End the session: abort whatever runs and refuse everything after. Safe to call twice. */
  close(): void {
    this.closed.abort(new Cancelled());
    this.inFlight?.abort(new Cancelled());
    this.state.set(null);
  }

  /**
   * Hand the displayed result to host code (apply it, write a file, assign a
   * texture) — only if it still holds right now. `check` throws when it stops
   * holding; call it again after every `await` and before every write. `target`
   * is the source an assignment is aimed at: when given it must equal the
   * source the destination has *now*, so an independent file result can be
   * assigned to a project only to the one it was explicitly aimed at.
   */
  async deliver<R>(
    work: (
      value: AnalyzerReport | AssetToolOutput,
      check: () => void,
      signal: AbortSignal,
    ) => Promise<R>,
    target?: { expected: ToolSource; current: () => ToolSource | null },
  ): Promise<ToolDelivery<R>> {
    const state = this.state();
    if (!state || !this.holds(state.capture)) return { status: 'stale' };
    const pending = this.installations.begin(this.packageId);
    const signal = AbortSignal.any([pending.signal, this.closed.signal]);
    const check = () => {
      if (
        signal.aborted ||
        !this.holds(state.capture) ||
        (target && !sameSource(target.current(), target.expected))
      ) {
        throw new StaleResult();
      }
    };
    try {
      check();
      return { status: 'delivered', value: await work(state.value as never, check, signal) };
    } catch (error) {
      if (error instanceof StaleResult || signal.aborted || !this.holds(state.capture)) {
        return { status: 'stale' };
      }
      return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
    } finally {
      pending.done();
    }
  }

  private async execute<T>(
    needsSource: boolean,
    profileId: string | null,
    call: (
      host: NonNullable<ReturnType<PluginInstallations['host']>>,
      signal: AbortSignal,
    ) => Promise<T>,
  ): Promise<ToolOutcome<T>> {
    if (this.closed.signal.aborted) return { status: 'cancelled' };
    const context = this.installations.context(this.packageId);
    if (!context) return { status: 'failed', message: 'Switch the plugin on to use it.' };
    const source = this.source ? this.source() : null;
    if (needsSource && this.source && !source) {
      return { status: 'failed', message: 'Open a shader first.' };
    }
    const host = this.installations.host(this.packageId);
    if (!host) return { status: 'stale' };

    // A newer request replaces the one under way: its Worker is terminated, or never started.
    this.inFlight?.abort(new Superseded());
    const own = new AbortController();
    this.inFlight = own;
    const capture: Capture = { generation: ++this.generation, context, source, profileId };
    const pending = this.installations.begin(this.packageId);
    const signal = AbortSignal.any([pending.signal, own.signal, this.closed.signal]);
    this.errorSignal.set(null);
    this.runningSignal.set(true);
    try {
      const value = await call(host, signal);
      // Checked before the result is shown, not only when it was asked for.
      if (capture.generation !== this.generation) return { status: 'superseded' };
      if (signal.aborted || !this.holds(capture)) return { status: 'stale' };
      this.state.set({ capture, value });
      return { status: 'ok', value };
    } catch (error) {
      const reason: unknown = own.signal.aborted ? own.signal.reason : undefined;
      if (reason instanceof Superseded || capture.generation !== this.generation) {
        return { status: 'superseded' };
      }
      if (reason instanceof Cancelled || this.closed.signal.aborted) return { status: 'cancelled' };
      if (pending.signal.aborted || !this.holds(capture)) return { status: 'stale' };
      const message = error instanceof Error ? error.message : String(error);
      this.errorSignal.set(message);
      return {
        status: 'failed',
        message,
        ...(error instanceof PluginCallError ? { code: error.code } : {}),
      };
    } finally {
      pending.done();
      if (this.inFlight === own) {
        this.inFlight = null;
        this.runningSignal.set(false);
      }
    }
  }
}
