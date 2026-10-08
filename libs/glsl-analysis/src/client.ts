import type { GlslAnalysisAssets } from './assets';
import type {
  AnalysisCapabilities,
  AnalysisReply,
  AnalysisRequest,
  CancelledReason,
  UnavailableReason,
} from './contract';
import { DEFAULT_LIMITS, type AnalysisLimits } from './limits';
import { checkRequest, echoIdentity } from './request';
import type { HostMessage, WorkerMessage, WorkerMetrics } from './worker/protocol';
import type { FrontendInfo } from './worker/runtime';

/** The part of `Worker` the client uses; injectable for tests and other hosts. */
export interface WorkerLike {
  postMessage(message: HostMessage): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null;
  onerror: ((event: Event) => void) | null;
}

export interface GlslAnalysisClientOptions {
  readonly assets: GlslAnalysisAssets;
  readonly limits?: Partial<AnalysisLimits>;
  readonly createWorker?: (url: string) => WorkerLike;
}

export type ClientState = 'idle' | 'starting' | 'ready' | 'failed' | 'disposed';

export interface StartupMetrics {
  /** Worker creation to `ready`, including script load, WASM fetch and instantiation. */
  readonly totalMs: number;
  readonly fetchMs: number;
  readonly instantiateMs: number;
  readonly wasmBytes: number;
  readonly memoryBytes: number;
  readonly heapBytes: number;
}

export interface ClientStats {
  readonly state: ClientState;
  readonly workersStarted: number;
  readonly workersTerminated: number;
  readonly timeouts: number;
  readonly crashes: number;
  readonly recycled: number;
  readonly startupFailures: number;
  readonly lastStartup: StartupMetrics | null;
  readonly lastMetrics: WorkerMetrics | null;
}

interface Pending {
  readonly request: AnalysisRequest;
  readonly resolve: (reply: AnalysisReply) => void;
  readonly enqueuedAt: number;
  startedAt: number;
  settled: boolean;
}

function defaultCreateWorker(url: string): WorkerLike {
  if (typeof Worker === 'undefined') throw new Error('Web Workers are unavailable here');
  return new Worker(url, { type: 'module', name: 'glsl-analysis' }) as unknown as WorkerLike;
}

/**
 * Host side of the analysis service. One lazily created module Worker runs
 * requests sequentially; within a session the latest request wins. Every
 * runtime failure (load, timeout, memory, crash) resolves as `unavailable`,
 * never as a shader error, and the next request gets a fresh Worker. The
 * promise returned by `analyze` never rejects.
 */
export class GlslAnalysisClient {
  private readonly limits: AnalysisLimits;
  private readonly createWorker: (url: string) => WorkerLike;
  private worker: WorkerLike | null = null;
  private generation = 0;
  private ready: Promise<boolean> | null = null;
  private startup: { resolve(ok: boolean): void; fail(message: string): void } | null = null;
  private startedAt = 0;
  private readonly queue = new Map<string, Pending>();
  private inflight: Pending | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private consecutiveStartupFailures = 0;
  private lastLoadError = '';
  private disposed = false;
  private frontend: FrontendInfo | null = null;
  private counters = {
    workersStarted: 0,
    workersTerminated: 0,
    timeouts: 0,
    crashes: 0,
    recycled: 0,
    startupFailures: 0,
  };
  private lastStartup: StartupMetrics | null = null;
  private lastMetrics: WorkerMetrics | null = null;

  constructor(private readonly options: GlslAnalysisClientOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.createWorker = options.createWorker ?? defaultCreateWorker;
  }

  get state(): ClientState {
    if (this.disposed) return 'disposed';
    if (this.consecutiveStartupFailures >= this.limits.maxConsecutiveFailures) return 'failed';
    if (!this.worker) return 'idle';
    return this.frontend && this.startup === null ? 'ready' : 'starting';
  }

  get capabilities(): AnalysisCapabilities {
    return {
      frontend: {
        name: 'glslang',
        version: this.frontend?.glslangVersion ?? 'unknown',
        commit: this.frontend?.glslangCommit ?? 'unknown',
      },
      profiles: [
        { language: 'essl', version: 100, stages: ['vertex', 'fragment'] },
        { language: 'essl', version: 300, stages: ['vertex', 'fragment'] },
      ],
      spirv: false,
      symbols: {
        globals: true,
        userFunctions: 'definitions',
        overloads: true,
        locals: false,
        references: false,
        globalDeclarationLocations: false,
        functionDefinitionLocations: 'compiler',
        incompleteSources: 'none',
      },
      diagnostics: { columns: 'utf16-when-derivable' },
      limits: {
        maxSourceBytes: this.limits.maxSourceBytes,
        timeoutMs: this.limits.timeoutMs,
        maxMemoryBytes: this.limits.maxMemoryBytes,
      },
    };
  }

  stats(): ClientStats {
    return {
      state: this.state,
      ...this.counters,
      lastStartup: this.lastStartup,
      lastMetrics: this.lastMetrics,
    };
  }

  analyze(input: AnalysisRequest): Promise<AnalysisReply> {
    if (this.disposed) return Promise.resolve(this.cancelled(echoIdentity(input), 'disposed'));
    const check = checkRequest(input, this.limits.maxSourceBytes);
    if (check.kind === 'invalid') {
      return Promise.resolve(
        this.unavailable(echoIdentity(input), 'invalid-request', check.issues.join('; ')),
      );
    }
    if (check.kind === 'unsupported-profile') {
      return Promise.resolve({
        ...echoIdentity(input),
        status: 'unsupported-profile',
        message: check.message,
        detected: null,
        diagnostics: [],
        symbols: null,
        capabilities: this.capabilities,
      });
    }
    if (check.kind === 'too-large') {
      return Promise.resolve(
        this.unavailable(
          echoIdentity(input),
          'input-limit',
          `Source is ${check.sourceBytes} bytes; the limit is ${this.limits.maxSourceBytes}.`,
        ),
      );
    }
    const request = check.request;
    if (this.state === 'failed') {
      return Promise.resolve(
        this.unavailable(
          request,
          'load-failed',
          `Analysis stopped after repeated start-up failures: ${this.lastLoadError}`,
        ),
      );
    }
    return new Promise((resolve) => {
      const queued = this.queue.get(request.sessionId);
      if (queued) {
        this.queue.delete(request.sessionId);
        this.settle(queued, this.cancelled(queued.request, 'superseded'));
      } else if (this.queue.size >= this.limits.maxQueuedSessions) {
        resolve(
          this.unavailable(request, 'queue-full', 'Too many sessions are waiting for analysis.'),
        );
        return;
      }
      if (this.inflight && this.inflight.request.sessionId === request.sessionId) {
        // The Worker cannot be interrupted; its eventual result is discarded.
        this.settle(this.inflight, this.cancelled(this.inflight.request, 'superseded'));
      }
      this.queue.set(request.sessionId, {
        request,
        resolve,
        enqueuedAt: performance.now(),
        startedAt: 0,
        settled: false,
      });
      this.pump();
    });
  }

  /** Cancels queued and in-flight work for a session (e.g. a closed document). */
  cancel(sessionId: string): void {
    const queued = this.queue.get(sessionId);
    if (queued) {
      this.queue.delete(sessionId);
      this.settle(queued, this.cancelled(queued.request, 'cancelled'));
    }
    if (this.inflight?.request.sessionId === sessionId) {
      this.settle(this.inflight, this.cancelled(this.inflight.request, 'cancelled'));
    }
  }

  /** Allows new start-up attempts after the client reached the `failed` state. */
  reset(): void {
    this.consecutiveStartupFailures = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.teardown();
    for (const pending of this.queue.values()) {
      this.settle(pending, this.cancelled(pending.request, 'disposed'));
    }
    this.queue.clear();
    if (this.inflight)
      this.settle(this.inflight, this.cancelled(this.inflight.request, 'disposed'));
    this.inflight = null;
  }

  private pump(): void {
    if (this.disposed || this.inflight) return;
    const next = this.queue.entries().next();
    if (next.done) return;
    const [sessionId, pending] = next.value;
    this.queue.delete(sessionId);
    this.inflight = pending;
    void this.dispatch(pending);
  }

  private async dispatch(pending: Pending): Promise<void> {
    const ok = await this.ensureWorker();
    if (this.inflight !== pending) return;
    if (!ok || !this.worker) {
      this.finish(pending, this.unavailable(pending.request, 'load-failed', this.lastLoadError));
      return;
    }
    const generation = this.generation;
    pending.startedAt = performance.now();
    this.watchdog = setTimeout(() => this.onTimeout(generation, pending), this.limits.timeoutMs);
    const { requestId, stage, profile, source, observe } = pending.request;
    this.worker.postMessage({
      type: 'analyze',
      job: { requestId, stage, version: profile.version, source, ...(observe ? { observe } : {}) },
    });
  }

  private ensureWorker(): Promise<boolean> {
    if (this.ready) return this.ready;
    if (this.state === 'failed') return Promise.resolve(false);
    const generation = ++this.generation;
    let worker: WorkerLike;
    try {
      worker = this.createWorker(this.options.assets.workerUrl);
    } catch (error) {
      this.recordStartupFailure(error instanceof Error ? error.message : String(error));
      return Promise.resolve(false);
    }
    this.worker = worker;
    this.frontend = null;
    this.counters.workersStarted++;
    this.startedAt = performance.now();
    this.ready = new Promise<boolean>((resolve) => {
      const timer = setTimeout(
        () => this.startup?.fail(`Worker start-up exceeded ${this.limits.initTimeoutMs} ms`),
        this.limits.initTimeoutMs,
      );
      this.startup = {
        resolve: (ok) => {
          clearTimeout(timer);
          this.startup = null;
          resolve(ok);
        },
        fail: (message) => {
          if (generation !== this.generation) return;
          clearTimeout(timer);
          this.startup = null;
          this.recordStartupFailure(message);
          this.teardown();
          resolve(false);
        },
      };
    });
    worker.onmessage = (event) => this.onMessage(generation, event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      this.onWorkerError(
        generation,
        (event as ErrorEvent).message || 'Worker script failed to load',
      );
    };
    worker.postMessage({
      type: 'init',
      wasmUrl: this.options.assets.wasmUrl,
      maxMemoryBytes: this.limits.maxMemoryBytes,
      maxSourceBytes: this.limits.maxSourceBytes,
    });
    return this.ready;
  }

  private onMessage(generation: number, message: WorkerMessage): void {
    if (generation !== this.generation) return;
    switch (message.type) {
      case 'ready':
        this.frontend = message.frontend;
        this.consecutiveStartupFailures = 0;
        this.lastStartup = {
          totalMs: performance.now() - this.startedAt,
          fetchMs: message.fetchMs,
          instantiateMs: message.instantiateMs,
          wasmBytes: message.wasmBytes,
          memoryBytes: message.memoryBytes,
          heapBytes: message.heapBytes,
        };
        this.startup?.resolve(true);
        return;
      case 'init-error':
        this.startup?.fail(message.message);
        return;
      default:
        break;
    }
    const pending = this.inflight;
    // Replies for anything but the current in-flight request are stale; drop them.
    if (!pending || message.requestId !== pending.request.requestId) return;
    if (message.type === 'rejected') {
      this.finish(pending, this.unavailable(pending.request, message.reason, message.message));
      return;
    }
    if (message.type === 'fatal') {
      this.counters.crashes++;
      this.teardown();
      this.finish(pending, this.unavailable(pending.request, message.reason, message.message));
      return;
    }
    this.lastMetrics = message.metrics;
    const timing = {
      queuedMs: pending.startedAt - pending.enqueuedAt,
      analysisMs: message.metrics.analysisMs,
      totalMs: performance.now() - pending.enqueuedAt,
    };
    const base = { ...this.identity(pending.request), capabilities: this.capabilities };
    const outcome = message.outcome;
    const reply: AnalysisReply =
      outcome.status === 'ok'
        ? { ...base, ...outcome, timing }
        : outcome.status === 'invalid-source'
          ? { ...base, ...outcome, symbols: null, timing }
          : { ...base, ...outcome, symbols: null };
    if (message.metrics.memoryBytes > this.limits.recycleMemoryBytes) {
      this.counters.recycled++;
      this.teardown();
    }
    this.finish(pending, reply);
  }

  private onWorkerError(generation: number, message: string): void {
    if (generation !== this.generation) return;
    if (this.startup) {
      this.startup.fail(message);
      return;
    }
    const pending = this.inflight;
    this.counters.crashes++;
    this.teardown();
    if (pending) this.finish(pending, this.unavailable(pending.request, 'crashed', message));
  }

  private onTimeout(generation: number, pending: Pending): void {
    if (generation !== this.generation || this.inflight !== pending) return;
    this.counters.timeouts++;
    this.teardown();
    this.finish(
      pending,
      this.unavailable(
        pending.request,
        'timeout',
        `Analysis exceeded ${this.limits.timeoutMs} ms; the Worker was terminated.`,
      ),
    );
  }

  private recordStartupFailure(message: string): void {
    this.lastLoadError = message;
    this.consecutiveStartupFailures++;
    this.counters.startupFailures++;
  }

  /** Terminates the current Worker; late messages from it are ignored by generation. */
  private teardown(): void {
    this.generation++;
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this.counters.workersTerminated++;
    }
    this.worker = null;
    this.ready = null;
    this.frontend = null;
    // Settle an interrupted start-up so nothing awaits a Worker that is gone.
    const startup = this.startup;
    this.startup = null;
    startup?.resolve(false);
  }

  private finish(pending: Pending, reply: AnalysisReply): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    if (this.inflight === pending) this.inflight = null;
    this.settle(pending, reply);
    this.pump();
  }

  private settle(pending: Pending, reply: AnalysisReply): void {
    if (pending.settled) return;
    pending.settled = true;
    pending.resolve(reply);
  }

  private identity(request: Omit<AnalysisRequest, 'source'>): Omit<AnalysisRequest, 'source'> {
    const { requestId, sessionId, projectId, revision, passId, stage, profile } = request;
    return { requestId, sessionId, projectId, revision, passId, stage, profile };
  }

  private unavailable(
    request: Omit<AnalysisRequest, 'source'>,
    reason: UnavailableReason,
    message: string,
  ): AnalysisReply {
    return {
      ...this.identity(request),
      status: 'unavailable',
      reason,
      message,
      symbols: null,
      capabilities: this.capabilities,
    };
  }

  private cancelled(
    request: Omit<AnalysisRequest, 'source'>,
    reason: CancelledReason,
  ): AnalysisReply {
    return {
      ...this.identity(request),
      status: 'cancelled',
      reason,
      symbols: null,
      capabilities: this.capabilities,
    };
  }
}
