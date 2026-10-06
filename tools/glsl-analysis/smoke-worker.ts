/**
 * Real browser smoke: serves dist/ locally, opens a harness page in headless
 * Chromium (Playwright) and drives GlslAnalysisClient against real module
 * Workers and the built WASM. Asserts lifecycle outcomes and records payload,
 * cold start, warm latency, memory and machine details as evidence.
 *
 *   pnpm --filter @shadergrove/glsl-analysis smoke:worker
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, constants as zlib } from 'node:zlib';
import { buildDir, distDir, evidenceDir, packageDir } from './paths.ts';

const require = createRequire(join(packageDir, 'package.json'));
const esbuild = require('esbuild') as typeof import('esbuild');
const { chromium } = require('playwright') as typeof import('playwright');

interface AssetRecord {
  path: string;
  bytes: number;
  sha256: string;
  gzipBytes: number;
  brotliBytes: number;
}

interface Manifest {
  files: { worker: AssetRecord; wasm: AssetRecord };
  testSupport: { nodeGlue: string };
  memory: { initialBytes: number };
  glslang: { commit: string; version: string };
  toolchain: Record<string, string>;
}

const CORPUS = [
  'essl100-shadergrove.frag',
  'essl100-three-prefix.vert',
  'essl300-webgl2.frag',
  'essl300-webgl2.vert',
];

/** Reads a nested value from the untyped harness results. */
function at(value: unknown, ...path: (string | number)[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

const manifest = JSON.parse(
  await readFile(join(distDir, 'glsl-analysis-assets.json'), 'utf8'),
) as Manifest;
const smokeDir = join(buildDir, 'smoke');
await mkdir(smokeDir, { recursive: true });

await esbuild.build({
  entryPoints: {
    harness: join(packageDir, 'test', 'smoke', 'harness.ts'),
    'hang-worker': join(packageDir, 'test', 'smoke', 'hang-worker.ts'),
  },
  outdir: smokeDir,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  external: ['module', 'node:*', 'fs', 'path', 'url', 'crypto', 'worker_threads'],
  alias: { '#glslang-module': join(distDir, manifest.testSupport.nodeGlue) },
  define: {
    __GLSL_ANALYSIS_WASM_SHA256__: JSON.stringify(manifest.files.wasm.sha256),
    __GLSL_ANALYSIS_INITIAL_MEMORY__: String(manifest.memory.initialBytes),
  },
  logLevel: 'warning',
});

const worker = await readFile(join(distDir, manifest.files.worker.path));
const wasm = await readFile(join(distDir, manifest.files.wasm.path));
const corrupt = Buffer.from(wasm);
const middle = Math.floor(corrupt.length / 2);
corrupt[middle] = (corrupt[middle] ?? 0) ^ 0xff;
const harness = await readFile(join(smokeDir, 'harness.js'));
const javascript = 'text/javascript';
const routes = new Map<string, { body: Buffer; type: string }>([
  [
    '/',
    {
      body: Buffer.from(
        '<!doctype html><title>glsl-analysis smoke</title><script type="module" src="/harness.js"></script>',
      ),
      type: 'text/html',
    },
  ],
  ['/harness.js', { body: harness, type: javascript }],
  ['/assets/glsl-analysis-worker.js', { body: worker, type: javascript }],
  ['/assets/glsl-analysis.wasm', { body: wasm, type: 'application/wasm' }],
  [
    '/hang/glsl-analysis-worker.js',
    { body: await readFile(join(smokeDir, 'hang-worker.js')), type: javascript },
  ],
  ['/hang/glsl-analysis.wasm', { body: wasm, type: 'application/wasm' }],
  // /missing/ serves the Worker but no WASM; /noworker/ serves nothing.
  ['/missing/glsl-analysis-worker.js', { body: worker, type: javascript }],
  ['/corrupt/glsl-analysis-worker.js', { body: worker, type: javascript }],
  ['/corrupt/glsl-analysis.wasm', { body: corrupt, type: 'application/wasm' }],
]);
for (const name of CORPUS) {
  routes.set(`/corpus/${name}`, {
    body: await readFile(join(packageDir, 'test', 'corpus', name)),
    type: 'text/plain',
  });
}

// Like a production server, serve pre-compressed Brotli JS/WASM when the browser
// accepts it. Compressing up front keeps server work out of the cold-start timing.
const compressed = new Map<string, Buffer>();
for (const [path, route] of routes) {
  if (/\.(js|wasm)$/.test(path)) {
    compressed.set(
      path,
      brotliCompressSync(route.body, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11 } }),
    );
  }
}
const served: { path: string; status: number; encoding: string; bytes: number }[] = [];
const server = createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  const route = routes.get(path);
  if (!route) {
    response.writeHead(404).end();
    served.push({ path, status: 404, encoding: 'identity', bytes: 0 });
    return;
  }
  const headers: Record<string, string> = {
    'content-type': route.type,
    'cache-control': 'no-store',
  };
  let body = route.body;
  const brotli = compressed.get(path);
  if (brotli && /\bbr\b/.test(String(request.headers['accept-encoding']))) {
    body = brotli;
    headers['content-encoding'] = 'br';
  }
  response.writeHead(200, headers).end(body);
  served.push({
    path,
    status: 200,
    encoding: headers['content-encoding'] ?? 'identity',
    bytes: body.length,
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

const browser = await chromium.launch({ headless: true });
const browserVersion = browser.version();
const page = await browser.newPage();
const pageLog: string[] = [];
page.on('console', (message) => pageLog.push(`[${message.type()}] ${message.text()}`));
page.on('pageerror', (error) => pageLog.push(`[pageerror] ${error.message}`));

let results: Record<string, unknown> = {};
let harnessError: string | undefined;
try {
  await page.goto(origin);
  await page.waitForFunction(
    () => (window as unknown as { __smoke?: { done: boolean } }).__smoke?.done === true,
    undefined,
    { timeout: 180_000 },
  );
  const smoke = (await page.evaluate(
    () => (window as unknown as { __smoke: unknown }).__smoke,
  )) as {
    results: Record<string, unknown>;
    error?: string;
  };
  results = smoke.results;
  harnessError = smoke.error;
} finally {
  await browser.close().catch(() => undefined);
  server.close();
}

const failures: string[] = [];
const expect = (condition: boolean, message: string) => {
  if (!condition) failures.push(message);
};
const r = results;
expect(!harnessError, `harness threw: ${harnessError}`);
expect(
  at(r, 'stateBeforeFirstRequest') === 'idle',
  'Worker must not start before the first request',
);
expect(at(r, 'cold', 'reply', 'status') === 'ok', 'cold request must succeed');
for (const entry of (at(r, 'corpus') ?? []) as unknown[]) {
  expect(at(entry, 'reply', 'status') === 'ok', `${at(entry, 'name')} must analyse cleanly`);
}
const invalidLines: Record<string, number | null> = {
  'undeclared-100-frag': 3,
  'missing-brace-100-vert': 3,
  'ends-in-call-300-frag': 5,
  'type-error-300-vert': 3,
  'missing-main-300-frag': null,
};
for (const entry of (at(r, 'invalid') ?? []) as unknown[]) {
  const name = String(at(entry, 'name'));
  const line = at(entry, 'reply', 'diagnostics', 0, 'location', 'line') ?? null;
  expect(at(entry, 'reply', 'status') === 'invalid-source', `${name} must be invalid-source`);
  expect(line === invalidLines[name], `${name} first diagnostic line was ${String(line)}`);
}
expect(
  at(r, 'unsupportedProfile', 'status') === 'unsupported-profile',
  'profile mismatch must be explicit',
);
const rapid = (at(r, 'latestWins') ?? []) as unknown[];
expect(
  rapid.length === 5 &&
    rapid
      .slice(0, 4)
      .every(
        (reply) => at(reply, 'status') === 'cancelled' && at(reply, 'reason') === 'superseded',
      ) &&
    at(rapid, 4, 'status') === 'ok' &&
    at(rapid, 4, 'revision') === 5,
  'only the latest revision of a session may publish',
);
expect(at(r, 'cancel', 'cancelled', 'status') === 'cancelled', 'cancelled work must not publish');
expect(at(r, 'validation', 'malformed', 'reason') === 'invalid-request', 'malformed request');
expect(
  at(r, 'validation', 'unsupportedVersion', 'status') === 'unsupported-profile',
  'unsupported version',
);
expect(at(r, 'validation', 'inputLimit', 'reason') === 'input-limit', 'input limit');
expect(
  at(r, 'undersizedMemory', 'rejectedBeforeStartup') === true ||
    at(r, 'undersizedMemory', 'reply', 'status') === 'unavailable',
  'a memory ceiling below the compiled minimum must be rejected, not silently exceeded',
);
const undersizedMemory = at(r, 'undersizedMemory', 'stats', 'lastStartup', 'memoryBytes');
expect(
  typeof undersizedMemory !== 'number' ||
    undersizedMemory <= Number(at(r, 'undersizedMemory', 'requestedMemoryBytes')),
  'Worker startup memory must not exceed the configured hard ceiling',
);
expect(
  at(r, 'memory', 'defaultCeiling', 'reply', 'status') === 'ok',
  'large source under default ceiling',
);
expect(
  at(r, 'memory', 'limitedCeiling', 'reply', 'reason') === 'memory-limit',
  'memory limit reported',
);
expect(
  at(r, 'memory', 'limitedCeiling', 'recovery', 'status') === 'ok',
  'recovery after memory limit',
);
const hangMs = Number(at(r, 'hang', 'elapsedMs'));
const gapMs = Number(at(r, 'hang', 'mainThreadMaxGapMs'));
expect(at(r, 'hang', 'reply', 'reason') === 'timeout', 'hung compile must time out');
expect(hangMs < 2_500, `watchdog took ${hangMs} ms`);
expect(gapMs < 250, `main thread stalled for ${gapMs} ms`);
expect(at(r, 'hang', 'recovery', 'status') === 'ok', 'recovery after watchdog termination');
expect(at(r, 'hang', 'stats', 'workersStarted') === 2, 'watchdog must recreate the Worker');
for (const key of ['missingWasm', 'corruptWasm', 'missingWorker']) {
  expect(
    at(r, 'loadFailures', key, 'reply', 'reason') === 'load-failed',
    `${key} must be load-failed`,
  );
}
expect(
  /integrity/.test(String(at(r, 'loadFailures', 'corruptWasm', 'reply', 'message'))),
  'corrupt WASM must fail the integrity check',
);
expect(
  at(r, 'loadFailures', 'repeated', 'state') === 'failed',
  'repeated load failures stop retrying',
);
expect(
  at(r, 'loadFailures', 'repeated', 'stats', 'workersStarted') === 3,
  'no Worker after the cap',
);
expect(at(r, 'finalCheck', 'status') === 'ok', 'healthy client must be unaffected');

const transfer = (path: string) =>
  served.find((entry) => entry.path === path && entry.status === 200);
const cpu = cpus();
const evidence = {
  generatedAt: new Date().toISOString(),
  result: failures.length ? 'failed' : 'passed',
  failures,
  machine: {
    platform: `${platform()} ${release()} ${arch()}`,
    cpu: cpu[0]?.model.trim() ?? 'unknown',
    logicalCores: cpu.length,
    memoryGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    node: process.version,
    browser: `Chromium ${browserVersion} (headless, Playwright)`,
  },
  build: { glslang: manifest.glslang, toolchain: manifest.toolchain, assets: manifest.files },
  payload: {
    worker: transfer('/assets/glsl-analysis-worker.js'),
    wasm: transfer('/assets/glsl-analysis.wasm'),
  },
  corpus: `libs/glsl-analysis/test/corpus (${CORPUS.join(', ')}) plus inline invalid, incomplete, memory and hang cases in test/smoke/harness.ts`,
  results,
  pageLog,
  served,
  harnessSha256: createHash('sha256').update(harness).digest('hex'),
};
await mkdir(evidenceDir, { recursive: true });
const evidencePath = join(evidenceDir, 'smoke-worker.json');
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

const ms = (value: unknown) => (typeof value === 'number' ? `${value.toFixed(1)} ms` : 'n/a');
process.stdout.write(
  [
    `[glsl-analysis] smoke ${evidence.result} in ${evidence.machine.browser}`,
    `  payload (br): worker ${evidence.payload.worker?.bytes} B, wasm ${evidence.payload.wasm?.bytes} B (raw ${manifest.files.wasm.bytes} B)`,
    `  cold: first reply ${ms(at(r, 'cold', 'wallMs'))} (Worker start-up ${ms(at(r, 'cold', 'startup', 'totalMs'))}, instantiate ${ms(at(r, 'cold', 'startup', 'instantiateMs'))})`,
    `  warm analysis: median ${ms(at(r, 'warm', 'analysisMs', 'median'))}, p95 ${ms(at(r, 'warm', 'analysisMs', 'p95'))}; round trip median ${ms(at(r, 'warm', 'roundTripMs', 'median'))}`,
    `  memory: linear ${String(at(r, 'warm', 'worker', 'memoryBytes'))} B, malloc ${String(at(r, 'warm', 'worker', 'heapBytes'))} B; large source linear ${String(at(r, 'memory', 'defaultCeiling', 'worker', 'memoryBytes'))} B`,
    `  hang: timeout after ${ms(hangMs)}, main-thread max gap ${ms(gapMs)}`,
    `  evidence: ${evidencePath}`,
    ...failures.map((failure) => `  FAIL ${failure}`),
    '',
  ].join('\n'),
);
process.exitCode = failures.length ? 1 : 0;
