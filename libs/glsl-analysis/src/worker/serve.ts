import type { AnalysisJob } from '../native-reply';
import type { GlslangModuleFactory } from './glslang-module';
import type { HostMessage, WorkerMessage } from './protocol';
import { createGlslangRuntime, RuntimeFatalError, type GlslangRuntime } from './runtime';

interface WorkerScope {
  onmessage: ((event: MessageEvent<HostMessage>) => void) | null;
  postMessage(message: WorkerMessage): void;
}

export interface ServeOptions {
  readonly createModule: GlslangModuleFactory;
  readonly initialMemoryBytes: number;
  /** Expected SHA-256 (hex) of the WASM; verified when Web Crypto is available. */
  readonly wasmSha256: string | null;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isJob(value: unknown): value is AnalysisJob {
  const job = value as Partial<AnalysisJob> | null;
  return (
    !!job &&
    typeof job.requestId === 'string' &&
    (job.stage === 'vertex' || job.stage === 'fragment') &&
    (job.version === 100 || job.version === 300) &&
    typeof job.source === 'string'
  );
}

/**
 * Runs the analysis message loop in a dedicated Worker. Requests are handled
 * one at a time and synchronously; the host enforces wall time by terminating
 * this Worker, so nothing here tries to observe cancellation mid-compile.
 */
export function serveGlslAnalysis(options: ServeOptions): void {
  const scope = globalThis as unknown as WorkerScope;
  const post = (message: WorkerMessage) => scope.postMessage(message);
  const encoder = new TextEncoder();
  let runtime: GlslangRuntime | null = null;
  let maxSourceBytes = 0;

  async function init(message: Extract<HostMessage, { type: 'init' }>): Promise<void> {
    try {
      const fetchStarted = performance.now();
      const response = await fetch(message.wasmUrl, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`WASM request failed with HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      const fetchMs = performance.now() - fetchStarted;
      if (options.wasmSha256) {
        const digest = await sha256Hex(bytes);
        if (digest !== null && digest !== options.wasmSha256) {
          throw new Error(`WASM integrity check failed (sha256 ${digest})`);
        }
      }
      const instantiateStarted = performance.now();
      runtime = await createGlslangRuntime(options.createModule, {
        wasmBinary: bytes,
        initialMemoryBytes: options.initialMemoryBytes,
        maximumMemoryBytes: message.maxMemoryBytes,
      });
      maxSourceBytes = message.maxSourceBytes;
      post({
        type: 'ready',
        frontend: runtime.info,
        wasmBytes: bytes.byteLength,
        fetchMs,
        instantiateMs: performance.now() - instantiateStarted,
        memoryBytes: runtime.memoryBytes(),
        heapBytes: runtime.heapBytes(),
      });
    } catch (error) {
      runtime = null;
      post({ type: 'init-error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  function analyze(job: unknown): void {
    const requestId = (job as { requestId?: unknown } | null)?.requestId;
    if (!isJob(job)) {
      post({
        type: 'rejected',
        requestId: typeof requestId === 'string' ? requestId : '',
        reason: 'invalid-request',
        message: 'Malformed analysis job',
      });
      return;
    }
    if (!runtime || !runtime.usable) {
      post({
        type: 'fatal',
        requestId: job.requestId,
        reason: 'crashed',
        message: 'Not initialised',
      });
      return;
    }
    if (encoder.encode(job.source).length > maxSourceBytes) {
      post({
        type: 'rejected',
        requestId: job.requestId,
        reason: 'input-limit',
        message: `Source exceeds ${maxSourceBytes} bytes`,
      });
      return;
    }
    const started = performance.now();
    try {
      const outcome = runtime.analyze(job);
      post({
        type: 'result',
        requestId: job.requestId,
        outcome,
        metrics: {
          analysisMs: performance.now() - started,
          heapBytes: runtime.heapBytes(),
          memoryBytes: runtime.memoryBytes(),
        },
      });
    } catch (error) {
      post({
        type: 'fatal',
        requestId: job.requestId,
        reason: error instanceof RuntimeFatalError ? error.reason : 'crashed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  scope.onmessage = (event) => {
    const message = event.data;
    if (message?.type === 'init') void init(message);
    else if (message?.type === 'analyze') analyze(message.job);
  };
}
