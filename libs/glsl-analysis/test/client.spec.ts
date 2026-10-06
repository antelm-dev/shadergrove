// Host lifecycle with an in-process WorkerLike that runs the real compiled
// front end; the Playwright smoke repeats the critical paths in a browser Worker.
import { afterEach, describe, expect, it } from 'vitest';
import { GlslAnalysisClient, type WorkerLike } from '../src/client';
import type { AnalysisReply, AnalysisRequest } from '../src/contract';
import type { HostMessage, WorkerMessage } from '../src/worker/protocol';
import { RuntimeFatalError, type GlslangRuntime } from '../src/worker/runtime';
import { createFrontend } from './support/frontend';

type Behaviour =
  | 'normal'
  | 'hang'
  | 'init-fail'
  | 'script-error'
  | 'crash'
  | 'mismatched-first'
  | 'late';

class RuntimeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  terminated = false;
  private runtime: GlslangRuntime | null = null;

  constructor(private readonly behaviour: Behaviour) {}

  postMessage(message: HostMessage): void {
    // Capture the handler like an already-dispatched message event would.
    const handler = this.onmessage;
    const emit = (reply: WorkerMessage) => {
      if (!this.terminated || this.behaviour === 'late')
        handler?.({ data: reply } as MessageEvent<WorkerMessage>);
    };
    setTimeout(() => void this.handle(message, emit), 0);
  }

  terminate(): void {
    this.terminated = true;
  }

  private async handle(message: HostMessage, emit: (reply: WorkerMessage) => void): Promise<void> {
    if (message.type === 'init') {
      if (this.behaviour === 'script-error') {
        this.onerror?.(new Event('error'));
        return;
      }
      if (this.behaviour === 'init-fail') {
        emit({ type: 'init-error', message: 'WASM request failed with HTTP 404' });
        return;
      }
      this.runtime = await createFrontend(message.maxMemoryBytes);
      emit({
        type: 'ready',
        frontend: this.runtime.info,
        wasmBytes: 1,
        fetchMs: 0,
        instantiateMs: 0,
        memoryBytes: this.runtime.memoryBytes(),
        heapBytes: this.runtime.heapBytes(),
      });
      return;
    }
    const { job } = message;
    if (this.behaviour === 'hang') return;
    if (this.behaviour === 'crash') {
      emit({ type: 'fatal', requestId: job.requestId, reason: 'crashed', message: 'trap' });
      return;
    }
    if (this.behaviour === 'mismatched-first') {
      emit({
        type: 'result',
        requestId: 'someone-else',
        outcome: { status: 'invalid-source', diagnostics: [] },
        metrics: { analysisMs: 0, heapBytes: 0, memoryBytes: 0 },
      });
    }
    if (this.behaviour === 'late') await new Promise((resolve) => setTimeout(resolve, 150));
    try {
      const outcome = this.runtime!.analyze(job);
      emit({
        type: 'result',
        requestId: job.requestId,
        outcome,
        metrics: {
          analysisMs: this.behaviour === 'late' ? 12_345 : 1,
          heapBytes: this.runtime!.heapBytes(),
          memoryBytes: this.runtime!.memoryBytes(),
        },
      });
    } catch (error) {
      emit({
        type: 'fatal',
        requestId: job.requestId,
        reason: error instanceof RuntimeFatalError ? error.reason : 'crashed',
        message: String(error),
      });
    }
  }
}

const VALID = 'precision mediump float;\nuniform float u;\nvoid main() { gl_FragColor = vec4(u); }';
let nextId = 0;
const request = (overrides: Partial<AnalysisRequest> = {}): AnalysisRequest => ({
  requestId: `req-${++nextId}`,
  sessionId: 'session-a',
  projectId: 'project-1',
  revision: 1,
  passId: 'image',
  stage: 'fragment',
  profile: { language: 'essl', version: 100 },
  source: VALID,
  ...overrides,
});

const clients: GlslAnalysisClient[] = [];
function harness(behaviours: Behaviour[] = [], limits = {}) {
  const workers: RuntimeWorker[] = [];
  const client = new GlslAnalysisClient({
    assets: { workerUrl: 'test://worker.js', wasmUrl: 'test://glsl.wasm' },
    limits: { timeoutMs: 2_000, ...limits },
    createWorker: () => {
      const worker = new RuntimeWorker(behaviours.shift() ?? 'normal');
      workers.push(worker);
      return worker;
    },
  });
  clients.push(client);
  return { client, workers };
}

afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
});

describe('GlslAnalysisClient', () => {
  it('starts the Worker lazily and echoes request identity', async () => {
    const { client, workers } = harness();
    expect(workers).toHaveLength(0);
    expect(client.state).toBe('idle');
    const input = request({ revision: 7, passId: 'buffer-a' });
    const reply = await client.analyze(input);
    expect(reply).toMatchObject({
      status: 'ok',
      requestId: input.requestId,
      sessionId: 'session-a',
      projectId: 'project-1',
      revision: 7,
      passId: 'buffer-a',
      stage: 'fragment',
      profile: { language: 'essl', version: 100 },
    });
    expect(reply.status === 'ok' && reply.symbols.globals.map((global) => global.name)).toEqual([
      'u',
    ]);
    expect(reply.capabilities.frontend.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(client.state).toBe('ready');
    expect(workers).toHaveLength(1);
  });

  it('lets only the latest request of a session publish', async () => {
    const { client } = harness();
    const replies = await Promise.all(
      [1, 2, 3, 4, 5].map((revision) => client.analyze(request({ revision }))),
    );
    expect(replies.map((reply) => [reply.revision, reply.status])).toEqual([
      [1, 'cancelled'],
      [2, 'cancelled'],
      [3, 'cancelled'],
      [4, 'cancelled'],
      [5, 'ok'],
    ]);
    expect(
      replies
        .slice(0, 4)
        .every((reply) => reply.status === 'cancelled' && reply.reason === 'superseded'),
    ).toBe(true);
    expect(replies.slice(0, 4).every((reply) => reply.symbols === null)).toBe(true);
  });

  it('serves different sessions independently', async () => {
    const { client } = harness();
    const [a, b] = await Promise.all([
      client.analyze(request({ sessionId: 'a' })),
      client.analyze(request({ sessionId: 'b', source: 'void main() { broken' })),
    ]);
    expect(a.status).toBe('ok');
    expect(b.status).toBe('invalid-source');
  });

  it('cancels queued and in-flight work for a session', async () => {
    const { client } = harness();
    const first = client.analyze(request({ sessionId: 'a' }));
    const second = client.analyze(request({ sessionId: 'b' }));
    client.cancel('a');
    client.cancel('b');
    expect(await first).toMatchObject({ status: 'cancelled', reason: 'cancelled' });
    expect(await second).toMatchObject({ status: 'cancelled', reason: 'cancelled' });
    expect((await client.analyze(request({ sessionId: 'a' }))).status).toBe('ok');
  });

  it('ignores replies for other requests', async () => {
    const { client } = harness(['mismatched-first']);
    const input = request();
    const reply = await client.analyze(input);
    expect(reply).toMatchObject({ status: 'ok', requestId: input.requestId });
  });

  it('terminates a hung Worker at the watchdog and recovers with a new one', async () => {
    const { client, workers } = harness(['hang'], { timeoutMs: 100 });
    const hung = await client.analyze(request({ revision: 1 }));
    expect(hung).toMatchObject({
      status: 'unavailable',
      reason: 'timeout',
      revision: 1,
      symbols: null,
    });
    expect(workers[0]?.terminated).toBe(true);
    const recovered = await client.analyze(request({ revision: 2 }));
    expect(recovered).toMatchObject({ status: 'ok', revision: 2 });
    expect(client.stats()).toMatchObject({ workersStarted: 2, timeouts: 1 });
  });

  it('drops a late reply from a terminated Worker', async () => {
    const { client } = harness(['late'], { timeoutMs: 50 });
    expect(await client.analyze(request({ revision: 1 }))).toMatchObject({ reason: 'timeout' });
    const next = await client.analyze(request({ revision: 2 }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(next).toMatchObject({ status: 'ok', revision: 2 });
    expect(client.stats().lastMetrics?.analysisMs).not.toBe(12_345);
  });

  it('reports a crashed Worker as unavailable, then recovers', async () => {
    const { client } = harness(['crash']);
    expect(await client.analyze(request())).toMatchObject({
      status: 'unavailable',
      reason: 'crashed',
    });
    expect((await client.analyze(request())).status).toBe('ok');
  });

  it('turns WASM memory exhaustion into memory-limit and recovers', async () => {
    const levels = ['#version 300 es', 'precision highp float;', 'out vec4 c;', '#define E0 1.0'];
    for (let level = 1; level <= 5; level++) {
      levels.push(
        `#define E${level} ${Array(10)
          .fill(`E${level - 1}`)
          .join(',')}`,
      );
    }
    levels.push('const float big[] = float[](E5);', 'void main() { c = vec4(big[0]); }');
    const { client, workers } = harness([], { maxMemoryBytes: 40 * 1024 * 1024 });
    const reply = await client.analyze(
      request({ source: levels.join('\n'), profile: { language: 'essl', version: 300 } }),
    );
    expect(reply).toMatchObject({ status: 'unavailable', reason: 'memory-limit' });
    expect(workers[0]?.terminated).toBe(true);
    expect((await client.analyze(request())).status).toBe('ok');
  });

  it('recycles a Worker whose memory grew past the recycle threshold', async () => {
    const { client, workers } = harness([], { recycleMemoryBytes: 1 });
    expect((await client.analyze(request())).status).toBe('ok');
    expect(workers[0]?.terminated).toBe(true);
    expect((await client.analyze(request())).status).toBe('ok');
    expect(client.stats().recycled).toBe(2);
  });

  it('reports load failures and stops retrying after repeated failures', async () => {
    const { client, workers } = harness(['init-fail', 'script-error', 'init-fail'], {
      maxConsecutiveFailures: 3,
    });
    expect(await client.analyze(request())).toMatchObject({
      status: 'unavailable',
      reason: 'load-failed',
    });
    expect(await client.analyze(request())).toMatchObject({
      status: 'unavailable',
      reason: 'load-failed',
    });
    expect(await client.analyze(request())).toMatchObject({
      status: 'unavailable',
      reason: 'load-failed',
    });
    expect(client.state).toBe('failed');
    expect(await client.analyze(request())).toMatchObject({ reason: 'load-failed' });
    expect(workers).toHaveLength(3);
    client.reset();
    expect((await client.analyze(request())).status).toBe('ok');
  });

  it('validates requests before they reach the Worker', async () => {
    const { client, workers } = harness([], { maxSourceBytes: 64 });
    const malformed = await client.analyze({ requestId: 'x' } as unknown as AnalysisRequest);
    expect(malformed).toMatchObject({
      status: 'unavailable',
      reason: 'invalid-request',
      requestId: 'x',
    });
    expect(
      await client.analyze(request({ profile: { language: 'essl', version: 310 as 300 } })),
    ).toMatchObject({ status: 'unsupported-profile', detected: null });
    expect(await client.analyze(request({ source: 'x'.repeat(65) }))).toMatchObject({
      status: 'unavailable',
      reason: 'input-limit',
    });
    expect(workers).toHaveLength(0);
  });

  it('bounds the number of waiting sessions', async () => {
    const { client } = harness([], { maxQueuedSessions: 1 });
    const inflight = client.analyze(request({ sessionId: 'a' }));
    const queued = client.analyze(request({ sessionId: 'b' }));
    const rejected = await client.analyze(request({ sessionId: 'c' }));
    expect(rejected).toMatchObject({ status: 'unavailable', reason: 'queue-full' });
    expect((await inflight).status).toBe('ok');
    expect((await queued).status).toBe('ok');
  });

  it('cancels everything on dispose', async () => {
    const { client } = harness(['hang']);
    const pending = client.analyze(request());
    await new Promise((resolve) => setTimeout(resolve, 0));
    client.dispose();
    const replies: AnalysisReply[] = [await pending, await client.analyze(request())];
    expect(replies.map((reply) => reply.status === 'cancelled' && reply.reason)).toEqual([
      'disposed',
      'disposed',
    ]);
  });

  it('degrades to unavailable where Web Workers do not exist (SSR)', async () => {
    const client = new GlslAnalysisClient({
      assets: { workerUrl: 'https://x/w.js', wasmUrl: 'https://x/g.wasm' },
    });
    clients.push(client);
    expect(await client.analyze(request())).toMatchObject({
      status: 'unavailable',
      reason: 'load-failed',
    });
  });
});
