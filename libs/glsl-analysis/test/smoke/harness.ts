// Runs in a real browser page (tools/glsl-analysis/smoke-worker.ts). Every
// scenario uses GlslAnalysisClient with real module Workers and the built WASM.
import { resolveGlslAnalysisAssets } from '../../src/assets';
import { GlslAnalysisClient } from '../../src/client';
import { planObservationInsertion, sourceIdentity } from '../../src/observation';
import type { AnalysisReply, AnalysisRequest, EsslVersion, GlslStage } from '../../src/contract';

interface SmokeWindow {
  __smoke?: { done: boolean; error?: string; results: Record<string, unknown> };
}

const results: Record<string, unknown> = {};
const smokeWindow = window as unknown as SmokeWindow;
smokeWindow.__smoke = { done: false, results };

let nextId = 0;
function request(
  source: string,
  stage: GlslStage,
  version: EsslVersion,
  overrides: Partial<AnalysisRequest> = {},
): AnalysisRequest {
  return {
    requestId: `smoke-${++nextId}`,
    sessionId: 'smoke-session',
    projectId: 'smoke-project',
    revision: nextId,
    passId: 'image',
    stage,
    profile: { language: 'essl', version },
    source,
    ...overrides,
  };
}

function summary(reply: AnalysisReply) {
  const base = { status: reply.status, revision: reply.revision, requestId: reply.requestId };
  switch (reply.status) {
    case 'ok':
      return {
        ...base,
        globals: reply.symbols.globals.length,
        functions: reply.symbols.functions.map((fn) => fn.signature),
        timing: reply.timing,
      };
    case 'invalid-source':
      return { ...base, diagnostics: reply.diagnostics, timing: reply.timing };
    case 'unsupported-profile':
      return { ...base, message: reply.message, detected: reply.detected };
    case 'unavailable':
      return { ...base, reason: reply.reason, message: reply.message };
    case 'cancelled':
      return { ...base, reason: reply.reason };
  }
}

const assetsAt = (path: string) => resolveGlslAnalysisAssets(new URL(path, location.href));
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0;
};

function wideExpansion(levels: number): string {
  const lines = ['#version 300 es', 'precision highp float;', 'out vec4 c;', '#define E0 1.0'];
  for (let level = 1; level <= levels; level++) {
    lines.push(
      `#define E${level} ${Array(10)
        .fill(`E${level - 1}`)
        .join(',')}`,
    );
  }
  lines.push(`const float big[] = float[](E${levels});`, 'void main() { c = vec4(big[0]); }');
  return lines.join('\n');
}

async function run(): Promise<void> {
  const corpusNames = [
    ['essl100-shadergrove.frag', 'fragment', 100],
    ['essl100-three-prefix.vert', 'vertex', 100],
    ['essl300-webgl2.frag', 'fragment', 300],
    ['essl300-webgl2.vert', 'vertex', 300],
  ] as const;
  const corpus = await Promise.all(
    corpusNames.map(async ([name, stage, version]) => ({
      name,
      stage,
      version,
      source: await (await fetch(`/corpus/${name}`)).text(),
    })),
  );

  // Cold start: lazy Worker creation, WASM fetch + integrity check, instantiate, first compile.
  const client = new GlslAnalysisClient({ assets: assetsAt('/assets/') });
  results['stateBeforeFirstRequest'] = client.state;
  const coldStarted = performance.now();
  const first = corpus[2]!;
  const cold = await client.analyze(request(first.source, first.stage, first.version));
  results['cold'] = {
    reply: summary(cold),
    wallMs: performance.now() - coldStarted,
    startup: client.stats().lastStartup,
  };

  // Valid corpus (each profile/stage pair once; first use of a pair builds glslang's built-in tables).
  results['corpus'] = [];
  for (const entry of corpus) {
    const started = performance.now();
    const reply = await client.analyze(request(entry.source, entry.stage, entry.version));
    (results['corpus'] as unknown[]).push({
      name: entry.name,
      wallMs: performance.now() - started,
      reply: summary(reply),
    });
  }

  // Invalid and incomplete sources in both stages and versions.
  const invalid = [
    [
      'undeclared-100-frag',
      'precision mediump float;\nvoid main() {\n  gl_FragColor = vec4(missing);\n}',
      'fragment',
      100,
    ],
    ['missing-brace-100-vert', 'void main() {\n  gl_Position = vec4(0.0);\n', 'vertex', 100],
    [
      'ends-in-call-300-frag',
      '#version 300 es\nprecision highp float;\nout vec4 c;\nvoid main() {\n  c = foo(',
      'fragment',
      300,
    ],
    [
      'type-error-300-vert',
      '#version 300 es\nvoid main() {\n  float a = vec3(1.0);\n  gl_Position = vec4(a);\n}',
      'vertex',
      300,
    ],
    [
      'missing-main-300-frag',
      '#version 300 es\nprecision highp float;\nout vec4 c;\n',
      'fragment',
      300,
    ],
  ] as const;
  results['invalid'] = [];
  for (const [name, source, stage, version] of invalid) {
    const reply = await client.analyze(request(source, stage, version));
    (results['invalid'] as unknown[]).push({ name, reply: summary(reply) });
  }
  results['unsupportedProfile'] = summary(
    await client.analyze(request('#version 300 es\nvoid main() {}', 'vertex', 100)),
  );

  // Warm latency over the corpus.
  const analysisMs: number[] = [];
  const totalMs: number[] = [];
  for (let round = 0; round < 25; round++) {
    for (const entry of corpus) {
      const reply = await client.analyze(request(entry.source, entry.stage, entry.version));
      if (reply.status === 'ok') {
        analysisMs.push(reply.timing.analysisMs);
        totalMs.push(reply.timing.totalMs);
      }
    }
  }
  results['warm'] = {
    samples: analysisMs.length,
    analysisMs: {
      median: percentile(analysisMs, 0.5),
      p95: percentile(analysisMs, 0.95),
      max: Math.max(...analysisMs),
    },
    roundTripMs: {
      median: percentile(totalMs, 0.5),
      p95: percentile(totalMs, 0.95),
      max: Math.max(...totalMs),
    },
    worker: client.stats().lastMetrics,
  };

  // Latest wins within a session; nothing stale is published.
  const rapid = await Promise.all(
    [1, 2, 3, 4, 5].map((revision) =>
      client.analyze(request(corpus[0]!.source, 'fragment', 100, { sessionId: 'rapid', revision })),
    ),
  );
  results['latestWins'] = rapid.map(summary);

  // Cancellation of queued work.
  const blocker = client.analyze(
    request(corpus[2]!.source, 'fragment', 300, { sessionId: 'busy' }),
  );
  const doomed = client.analyze(
    request(corpus[0]!.source, 'fragment', 100, { sessionId: 'closing' }),
  );
  client.cancel('closing');
  results['cancel'] = { blocker: summary(await blocker), cancelled: summary(await doomed) };

  // Request validation.
  results['validation'] = {
    malformed: summary(await client.analyze({ requestId: 'bad' } as unknown as AnalysisRequest)),
    unsupportedVersion: summary(
      await client.analyze(request('void main() {}', 'vertex', 310 as EsslVersion)),
    ),
    inputLimit: summary(
      await client.analyze(request(`void main() {}\n//${'x'.repeat(300 * 1024)}`, 'vertex', 100)),
    ),
  };

  // Memory: the same macro-expanded source succeeds under the default ceiling and
  // fails as memory-limit under a 40 MiB ceiling; the limited client then recovers.
  const big = wideExpansion(5);
  const bigReply = await client.analyze(request(big, 'fragment', 300));
  results['memory'] = {
    defaultCeiling: { reply: summary(bigReply), worker: client.stats().lastMetrics },
  };
  const limited = new GlslAnalysisClient({
    assets: assetsAt('/assets/'),
    limits: { maxMemoryBytes: 40 * 1024 * 1024 },
  });
  const limitedReply = await limited.analyze(request(big, 'fragment', 300));
  const afterLimit = await limited.analyze(request(corpus[0]!.source, 'fragment', 100));
  (results['memory'] as Record<string, unknown>)['limitedCeiling'] = {
    reply: summary(limitedReply),
    recovery: summary(afterLimit),
    stats: limited.stats(),
  };
  limited.dispose();

  // A configured ceiling below the compiled 32 MiB floor must be rejected,
  // rather than silently allocating above the host's declared budget.
  const requestedMemoryBytes = 16 * 1024 * 1024;
  let belowFloor: GlslAnalysisClient | null = null;
  try {
    belowFloor = new GlslAnalysisClient({
      assets: assetsAt('/assets/'),
      limits: { maxMemoryBytes: requestedMemoryBytes },
    });
    const reply = await belowFloor.analyze(request(corpus[0]!.source, 'fragment', 100));
    results['undersizedMemory'] = {
      requestedMemoryBytes,
      reply: summary(reply),
      stats: belowFloor.stats(),
      rejectedBeforeStartup: false,
    };
  } catch {
    results['undersizedMemory'] = { requestedMemoryBytes, rejectedBeforeStartup: true };
  } finally {
    belowFloor?.dispose();
  }

  // Hung synchronous compile: the watchdog terminates the Worker; the page keeps running.
  const hangClient = new GlslAnalysisClient({
    assets: assetsAt('/hang/'),
    limits: { timeoutMs: 1_000 },
  });
  await hangClient.analyze(request(corpus[0]!.source, 'fragment', 100)); // warm the fixture Worker
  let lastTick = performance.now();
  let maxGap = 0;
  const ticker = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - lastTick);
    lastTick = now;
  }, 16);
  const hangStarted = performance.now();
  const hung = await hangClient.analyze(
    request(`// @smoke-hang\n${corpus[0]!.source}`, 'fragment', 100, { revision: 900 }),
  );
  const hangMs = performance.now() - hangStarted;
  clearInterval(ticker);
  const recovered = await hangClient.analyze(
    request(corpus[0]!.source, 'fragment', 100, { revision: 901 }),
  );
  results['hang'] = {
    reply: summary(hung),
    elapsedMs: hangMs,
    mainThreadMaxGapMs: maxGap,
    recovery: summary(recovered),
    stats: hangClient.stats(),
  };
  hangClient.dispose();

  // Asset load failures.
  const loadFailure = async (path: string) => {
    const failing = new GlslAnalysisClient({
      assets: assetsAt(path),
      limits: { initTimeoutMs: 10_000 },
    });
    const reply = await failing.analyze(request(corpus[0]!.source, 'fragment', 100));
    const state = failing.state;
    failing.dispose();
    return { reply: summary(reply), state };
  };
  const repeated = new GlslAnalysisClient({
    assets: assetsAt('/missing/'),
    limits: { maxConsecutiveFailures: 3 },
  });
  const repeatedReplies = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    repeatedReplies.push(
      summary(await repeated.analyze(request(corpus[0]!.source, 'fragment', 100))),
    );
  }
  results['loadFailures'] = {
    missingWasm: await loadFailure('/missing/'),
    corruptWasm: await loadFailure('/corrupt/'),
    missingWorker: await loadFailure('/noworker/'),
    repeated: { replies: repeatedReplies, state: repeated.state, stats: repeated.stats() },
  };
  repeated.dispose();

  // Private opt-in observation catalogue through the real Worker and WASM.
  const observed = ['#version 300 es', 'precision highp float;', 'out vec4 c;'];
  const observedSource = [
    ...observed,
    '#define SET_X x = 1.0',
    'void main() {',
    '  float x = 0.0;',
    '  SET_X;',
    '  vec2 p = vec2(x, 2.0);',
    '  c = vec4(p, x, 1.0);',
    '}',
  ].join('\n');
  const plain = await client.analyze(request(observedSource, 'fragment', 300));
  const opted = await client.analyze(request(observedSource, 'fragment', 300, { observe: true }));
  const observation = opted.status === 'ok' ? opted.observation : undefined;
  const observedPoint = observation?.points.find((point) => point.name === 'p');
  const insertion =
    observation && observedPoint
      ? planObservationInsertion(observedSource, observation, observedPoint.id)
      : null;
  const invalidObserved = await client.analyze(
    request('#version 300 es\nvoid main() {\n  float a = vec3(1.0);\n}', 'vertex', 300, {
      observe: true,
    }),
  );
  const observeRapid = await Promise.all(
    [1, 2, 3].map((revision) =>
      client.analyze(
        request(observedSource, 'fragment', 300, {
          sessionId: 'observe-rapid',
          revision,
          observe: true,
        }),
      ),
    ),
  );
  const observeRecovery = await client.analyze(
    request(observedSource, 'fragment', 300, { observe: true }),
  );
  results['observation'] = {
    ordinaryHasObservation: plain.status === 'ok' && 'observation' in plain,
    optedStatus: opted.status,
    source: observation?.source ?? null,
    expectedSource: sourceIdentity(observedSource),
    points: observation?.points.map((point) => `${point.name}:${point.kind}:${point.type}`) ?? [],
    refusals: observation?.refusals.map((refusal) => refusal.reason) ?? [],
    spanText: observedPoint
      ? observedSource.slice(observedPoint.span.statement.start, observedPoint.span.statement.end)
      : null,
    insertion: insertion
      ? insertion.ok
        ? { ok: true, kinds: insertion.insertion.edits.map((edit) => edit.kind) }
        : { ok: false, reason: insertion.reason }
      : null,
    staleReason:
      observation && observedPoint
        ? (() => {
            const stale = planObservationInsertion(
              `${observedSource}\n`,
              observation,
              observedPoint.id,
            );
            return stale.ok ? null : stale.reason;
          })()
        : null,
    invalid: { status: invalidObserved.status, hasObservation: 'observation' in invalidObserved },
    latestWins: observeRapid.map((reply) => `${reply.status}:${reply.revision}`),
    recovery: {
      status: observeRecovery.status,
      points: observeRecovery.status === 'ok' ? observeRecovery.observation?.points.length : null,
    },
  };

  // The healthy client is unaffected by all of the above.
  results['finalCheck'] = summary(await client.analyze(request(corpus[1]!.source, 'vertex', 100)));
  results['clientStats'] = client.stats();
  client.dispose();
}

run().then(
  () => {
    smokeWindow.__smoke!.done = true;
  },
  (error: unknown) => {
    smokeWindow.__smoke!.error =
      error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
    smokeWindow.__smoke!.done = true;
  },
);
