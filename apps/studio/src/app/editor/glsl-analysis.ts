import { signal } from '@angular/core';
import type {
  AnalysisReply,
  AnalysisSymbols,
  FunctionSymbol,
  GlobalSymbol,
  GlslAnalysisClient,
  UnavailableReason,
} from '@shadergrove/glsl-analysis';
import type { ShaderProject } from '@shadergrove/shared/project';

import {
  GENERATED_GLOBALS,
  dedupeDiagnostics,
  mapDiagnostic,
  prepareUnits,
  type AnalysisUnit,
  type MappedDiagnostic,
} from './glsl-analysis-source';

/** What `analyze` needs to know about the current project. */
export interface AnalysisInput {
  /** Identity of the project being edited; revisions are only comparable within one. */
  readonly projectId: string;
  /** The store's draft revision, bumped on every edit. */
  readonly revision: number;
  readonly project: ShaderProject;
}

export interface AnalysisFailure {
  readonly reason: UnavailableReason;
  readonly message: string;
}

interface UnitResult {
  readonly unit: AnalysisUnit;
  readonly diagnostics: readonly MappedDiagnostic[];
  /** Null unless the front end accepted this exact source. */
  readonly symbols: AnalysisSymbols | null;
  /** Set when the front end declined the profile; this is not a shader error. */
  readonly unsupported: string | null;
}

/**
 * Everything the front end said about one revision of one project. Replaced
 * whole, never patched, so nothing in it can describe two revisions at once.
 */
export interface AnalysisSnapshot {
  readonly projectId: string;
  readonly revision: number;
  readonly units: ReadonlyMap<string, UnitResult>;
  readonly diagnostics: readonly MappedDiagnostic[];
  readonly failure: AnalysisFailure | null;
}

export type AnalysisHealth =
  | { readonly state: 'idle' }
  | { readonly state: 'analyzing' }
  | { readonly state: 'ready' }
  | { readonly state: 'unavailable'; readonly failure: AnalysisFailure };

export interface DocumentSymbols {
  readonly globals: readonly GlobalSymbol[];
  readonly functions: readonly FunctionSymbol[];
}

export interface ProjectAnalysisOptions {
  readonly debounceMs?: number;
  /** Test seam; the default loads the real client lazily from the local assets. */
  readonly createClient?: () => Promise<GlslAnalysisClient>;
}

async function createLocalClient(): Promise<GlslAnalysisClient> {
  // A dynamic import keeps the client out of the main bundle; the Worker and
  // WASM are only fetched by the first request that reaches `analyze`.
  const { GlslAnalysisClient, resolveGlslAnalysisAssets } =
    await import('@shadergrove/glsl-analysis');
  const assets = resolveGlslAnalysisAssets(new URL('glsl-analysis/', document.baseURI));
  return new GlslAnalysisClient({ assets });
}

/**
 * Real front-end analysis of the current project, as a signal-friendly facade.
 *
 * `update` says what the project is now. Every call (and `markDirty`) starts a
 * new epoch; a reply only becomes the snapshot if its epoch is still the latest,
 * so nothing computed for an older edit, or an older project, is ever shown.
 * Between an edit and the next accepted reply `current` is false and no symbols
 * or diagnostics are served — stale analysis is withheld, not "best effort".
 *
 * Rendering stays authoritative: this never touches compile decisions, and a
 * failed analysis is a `health` state, never a diagnostic.
 */
export class ProjectAnalysis {
  readonly snapshot = signal<AnalysisSnapshot | null>(null);
  readonly health = signal<AnalysisHealth>({ state: 'idle' });

  private readonly debounceMs: number;
  private readonly createClient: () => Promise<GlslAnalysisClient>;
  private client: Promise<GlslAnalysisClient> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private epoch = 0;
  private sequence = 0;
  private disposed = false;
  private latest: AnalysisInput | null = null;
  /** Whether `snapshot` describes the latest input. */
  private currentEpoch = -1;
  private projectId: string | null = null;
  /** Unchanged units keep their result; the compiler is only asked about what changed. */
  private readonly reuse = new Map<string, { source: string; reply: AcceptedReply }>();
  /** Units submitted to the client and not yet answered: they must be cancellable before any result. */
  private readonly pending = new Set<string>();

  constructor(options: ProjectAnalysisOptions = {}) {
    this.debounceMs = options.debounceMs ?? 300;
    this.createClient = options.createClient ?? createLocalClient;
  }

  /** True when `snapshot` describes the project exactly as it is now. */
  get current(): boolean {
    return this.snapshot() !== null && this.currentEpoch === this.epoch;
  }

  /** The text just changed somewhere: whatever was known is no longer about it. */
  markDirty(): void {
    this.epoch++;
  }

  update(input: AnalysisInput): void {
    if (this.disposed) return;
    const epoch = ++this.epoch;
    this.latest = input;

    if (this.projectId !== input.projectId) {
      this.leaveProject();
      this.projectId = input.projectId;
    }

    if (this.timer) clearTimeout(this.timer);
    this.health.update((health) =>
      health.state === 'unavailable' ? health : { state: 'analyzing' },
    );
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run(input, epoch);
    }, this.debounceMs);
  }

  /** Try again after a failure, with a fresh start-up budget. */
  async retry(): Promise<void> {
    if (this.disposed || !this.latest) return;
    (await this.client)?.reset();
    this.update(this.latest);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.snapshot.set(null);
    const client = this.client;
    this.client = null;
    void client?.then((resolved) => resolved.dispose());
  }

  diagnosticsFor(docId: string): readonly MappedDiagnostic[] {
    const snapshot = this.snapshot();
    if (!snapshot || !this.current) return [];
    return snapshot.diagnostics.filter((diagnostic) => diagnostic.docId === docId);
  }

  /**
   * Declared globals and user functions visible in `docId`'s compilation(s).
   * Null unless every contributing source was accepted at the current revision.
   * Names three.js declares in front of the user's code are not the user's.
   */
  symbolsFor(docId: string): DocumentSymbols | null {
    const snapshot = this.snapshot();
    if (!snapshot || !this.current) return null;

    const globals = new Map<string, GlobalSymbol>();
    const functions = new Map<string, FunctionSymbol>();
    let any = false;
    for (const result of snapshot.units.values()) {
      if (!result.symbols || !result.unit.docIds.has(docId)) continue;
      any = true;
      const generated = GENERATED_GLOBALS[result.unit.stage];
      for (const symbol of result.symbols.globals) {
        if (symbol.name && !generated.has(symbol.name)) globals.set(symbol.name, symbol);
      }
      for (const symbol of result.symbols.functions) {
        // A user overload may share a generated helper's name: only a definition
        // inside the prefix (or one we cannot place) is three.js's.
        const line = symbol.definition?.line;
        const inPrefix = line === undefined || line <= result.unit.prefixLines;
        if (!generated.has(symbol.name) || !inPrefix) functions.set(symbol.signature, symbol);
      }
    }
    return any ? { globals: [...globals.values()], functions: [...functions.values()] } : null;
  }

  /** The document and line of the first analysis problem, for "go to problem". */
  firstProblem(after?: { docId: string; line: number }): MappedDiagnostic | null {
    const snapshot = this.snapshot();
    if (!snapshot || !this.current) return null;
    const errors = snapshot.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
    if (!errors.length) return null;
    if (!after) return errors[0];
    const index = errors.findIndex(
      (diagnostic) => diagnostic.docId === after.docId && (diagnostic.line ?? 0) === after.line,
    );
    return errors[(index + 1) % errors.length];
  }

  // ---------------------------------------------------------------------------

  /** Departing a project: nothing of it may be answered, cached or left running. */
  private leaveProject(): void {
    const previous = this.projectId;
    const keys = new Set([...this.reuse.keys(), ...this.pending]);
    this.reuse.clear();
    this.pending.clear();
    this.snapshot.set(null);
    if (previous === null) return;
    void this.client?.then((client) => {
      for (const key of keys) client.cancel(sessionId(previous, key));
    });
  }

  private async run(input: AnalysisInput, epoch: number): Promise<void> {
    const units = prepareUnits(input.project);
    const live = new Set(units.map((unit) => unit.key));

    // A document that is gone takes its analysis with it.
    const client = await this.ensureClient();
    if (!client || epoch !== this.epoch) return;
    for (const key of new Set([...this.reuse.keys(), ...this.pending])) {
      if (live.has(key)) continue;
      this.reuse.delete(key);
      this.pending.delete(key);
      client.cancel(sessionId(input.projectId, key));
    }

    let failure: AnalysisFailure | null = null;
    const results = await Promise.all(
      units.map(async (unit): Promise<UnitResult | null> => {
        const reused = this.reuse.get(unit.key);
        // Same bytes, possibly different documents or names: map the raw reply afresh.
        if (reused?.source === unit.source) return toResult(unit, reused.reply);

        const requestId = `a${++this.sequence}`;
        this.pending.add(unit.key);
        const reply = await client.analyze({
          requestId,
          sessionId: sessionId(input.projectId, unit.key),
          projectId: input.projectId,
          revision: input.revision,
          passId: unit.key,
          stage: unit.stage,
          profile: { language: 'essl', version: 300 },
          source: unit.source,
        });

        // The client already drops superseded work; this is the belt to its braces.
        if (
          epoch !== this.epoch ||
          reply.requestId !== requestId ||
          reply.projectId !== input.projectId ||
          reply.revision !== input.revision
        ) {
          return null;
        }
        if (reply.status === 'cancelled') return null;
        if (reply.status === 'unavailable') {
          failure ??= { reason: reply.reason, message: reply.message };
          return null;
        }

        this.reuse.set(unit.key, { source: unit.source, reply });
        return toResult(unit, reply);
      }),
    );
    if (epoch !== this.epoch || this.disposed) return;

    if (failure) {
      this.snapshot.set(null);
      this.health.set({ state: 'unavailable', failure });
      return;
    }

    const byKey = new Map<string, UnitResult>();
    for (const result of results) if (result) byKey.set(result.unit.key, result);
    if (byKey.size !== units.length) return;

    this.currentEpoch = epoch;
    this.snapshot.set({
      projectId: input.projectId,
      revision: input.revision,
      units: byKey,
      diagnostics: dedupeDiagnostics([...byKey.values()].flatMap((result) => result.diagnostics)),
      failure: null,
    });
    this.health.set({ state: 'ready' });
  }

  private ensureClient(): Promise<GlslAnalysisClient | null> {
    this.client ??= this.createClient();
    return this.client.catch((error: unknown) => {
      // The module itself failed to load (offline chunk, blocked): same recoverable state.
      this.client = null;
      this.health.set({
        state: 'unavailable',
        failure: {
          reason: 'load-failed',
          message: error instanceof Error ? error.message : String(error),
        },
      });
      return null;
    });
  }
}

function sessionId(projectId: string, key: string): string {
  return `${projectId}\u0000${key}`;
}

type AcceptedReply = Exclude<AnalysisReply, { status: 'unavailable' | 'cancelled' }>;

function toResult(unit: AnalysisUnit, reply: AcceptedReply): UnitResult {
  const diagnostics = reply.diagnostics.map((diagnostic) => mapDiagnostic(unit, diagnostic));
  return {
    unit,
    diagnostics,
    symbols: reply.status === 'ok' ? reply.symbols : null,
    unsupported: reply.status === 'unsupported-profile' ? reply.message : null,
  };
}
