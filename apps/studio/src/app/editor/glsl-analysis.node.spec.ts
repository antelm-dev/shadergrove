// Runs in Node (`pnpm test:analysis`): the real compiled glslang front end is
// instantiated in-process behind the real client, because the ng test runner
// has no `node:` imports. The browser Worker path is covered by
// apps/studio-e2e/src/glsl-analysis.spec.ts.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { GlslAnalysisClient, type WorkerLike } from '@shadergrove/glsl-analysis';
import { DEFAULT_VERTEX, createProject, type ShaderProject } from '@shadergrove/shared/project';

import { createFrontend } from '../../../../../libs/glsl-analysis/test/support/frontend';
import { ProjectAnalysis } from './glsl-analysis';
import {
  GENERATED_PREFIX,
  mapDiagnostic,
  prepareFragmentUnit,
  prepareUnits,
} from './glsl-analysis-source';

type Message = Parameters<WorkerLike['postMessage']>[0];
type Reply = Parameters<NonNullable<WorkerLike['onmessage']>>[0]['data'];

const behaviour = {
  initFails: false,
  gate: null as Promise<void> | null,
  analyzed: [] as string[],
};

let frontend: ReturnType<typeof createFrontend> | null = null;

/** The real front end behind the real client; only the thread boundary is absent. */
class InProcessWorker implements WorkerLike {
  onmessage: WorkerLike['onmessage'] = null;
  onerror: WorkerLike['onerror'] = null;
  private terminated = false;

  postMessage(message: Message): void {
    const handler = this.onmessage;
    const emit = (data: Reply) => {
      if (!this.terminated) handler?.({ data } as MessageEvent<Reply>);
    };
    setTimeout(() => void this.handle(message, emit), 0);
  }

  terminate(): void {
    this.terminated = true;
  }

  private async handle(message: Message, emit: (reply: Reply) => void): Promise<void> {
    if (message.type === 'init') {
      if (behaviour.initFails) {
        emit({ type: 'init-error', message: 'WASM request failed with HTTP 404' });
        return;
      }
      const runtime = await (frontend ??= createFrontend());
      emit({
        type: 'ready',
        frontend: runtime.info,
        wasmBytes: 1,
        fetchMs: 0,
        instantiateMs: 0,
        memoryBytes: runtime.memoryBytes(),
        heapBytes: runtime.heapBytes(),
      });
      return;
    }
    const { job } = message;
    behaviour.analyzed.push(job.requestId);
    if (behaviour.gate) await behaviour.gate;
    const runtime = await frontend!;
    emit({
      type: 'result',
      requestId: job.requestId,
      outcome: runtime.analyze(job),
      metrics: { analysisMs: 0, heapBytes: 0, memoryBytes: runtime.memoryBytes() },
    });
  }
}

const live: ProjectAnalysis[] = [];

function makeAnalysis(): ProjectAnalysis {
  const analysis = new ProjectAnalysis({
    debounceMs: 0,
    createClient: async () =>
      new GlslAnalysisClient({
        assets: { workerUrl: 'worker.js', wasmUrl: 'glsl-analysis.wasm' },
        createWorker: () => new InProcessWorker(),
      }),
  });
  live.push(analysis);
  return analysis;
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(() => {
  for (const analysis of live.splice(0)) analysis.dispose();
  behaviour.initFails = false;
  behaviour.gate = null;
  behaviour.analyzed = [];
  vi.restoreAllMocks();
});

const FRAGMENT = `uniform float iTime;
uniform vec2 iResolution;
uniform sampler2D iChannel0;
varying vec2 vUv;

float wave(vec2 p) { return sin(p.x + iTime); }

void main() {
  gl_FragColor = texture2D(iChannel0, vUv) * wave(vUv);
}
`;

function project(fragment = FRAGMENT): ShaderProject {
  return createProject(fragment, DEFAULT_VERTEX);
}

async function analyse(next: ShaderProject, id = 'p1', revision = 1): Promise<ProjectAnalysis> {
  const analysis = makeAnalysis();
  analysis.update({ projectId: id, revision, project: next });
  await until(() => analysis.current, 'the analysis snapshot');
  return analysis;
}

describe('generated ESSL preparation', () => {
  it('uses three.js ShaderMaterial declarations, not the export helper', () => {
    const require = createRequire(import.meta.url);
    const three = readFileSync(
      join(dirname(require.resolve('three')), '../src/renderers/webgl/WebGLProgram.js'),
      'utf8',
    );

    const checked = [GENERATED_PREFIX.vertex, GENERATED_PREFIX.fragment]
      .flatMap((prefix) => prefix.split('\n'))
      .filter((line) =>
        /^(uniform|attribute|layout\(|#define (attribute|varying|tex|gl_))/.test(line),
      );
    expect(checked.length).toBeGreaterThan(20);
    for (const line of checked) expect(three, line).toContain(`'${line}'`);
  });

  it('keeps the user line numbering behind a known prefix', () => {
    const unit = prepareFragmentUnit(project(), project().passes[0]);
    expect(unit.source.startsWith(GENERATED_PREFIX.fragment)).toBe(true);
    expect(unit.source.split('\n')[unit.prefixLines]).toBe('uniform float iTime;');
  });
});

describe('real front end through the facade', () => {
  it('accepts a driver-compatible legacy shader and offers only its own symbols', async () => {
    const next = project();
    const analysis = await analyse(next);

    expect(analysis.diagnosticsFor(next.passes[0].id)).toEqual([]);
    const symbols = analysis.symbolsFor(next.passes[0].id)!;
    expect(symbols.globals.map((symbol) => symbol.name)).toEqual(
      expect.arrayContaining(['iTime', 'iResolution', 'iChannel0']),
    );
    expect(symbols.functions.map((symbol) => symbol.name)).toContain('wave');
    // three.js declares these in front of the source; they are not the user's.
    expect(symbols.globals.map((symbol) => symbol.name)).not.toContain('cameraPosition');
    expect(symbols.globals.map((symbol) => symbol.name)).not.toContain('pc_fragColor');
  });

  it('withholds symbols for an incomplete buffer and reports the error', async () => {
    const next = project('void main() { float x = ');
    const analysis = await analyse(next);

    expect(analysis.symbolsFor(next.passes[0].id)).toBeNull();
    const diagnostics = analysis.diagnosticsFor(next.passes[0].id);
    expect(diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(true);
    expect(diagnostics.every((diagnostic) => diagnostic.line !== 0)).toBe(true);
  });

  it('keeps legal fragment globals whose names are generated only in the vertex stage', async () => {
    const next = project(
      'uniform float uv; uniform vec3 position; uniform mat4 modelMatrix; void main() { gl_FragColor = vec4(uv + position.x + modelMatrix[0][0]); }',
    );
    const analysis = await analyse(next);
    expect(analysis.diagnosticsFor(next.passes[0].id)).toEqual([]);
    expect(analysis.symbolsFor(next.passes[0].id)?.globals.map((symbol) => symbol.name)).toEqual(
      expect.arrayContaining(['uv', 'position', 'modelMatrix']),
    );
  });

  it('serves nothing between an edit and its accepted result', async () => {
    const next = project();
    const analysis = await analyse(next);
    expect(analysis.symbolsFor(next.passes[0].id)).not.toBeNull();

    analysis.markDirty();
    expect(analysis.current).toBe(false);
    expect(analysis.symbolsFor(next.passes[0].id)).toBeNull();
    expect(analysis.diagnosticsFor(next.passes[0].id)).toEqual([]);
  });

  it('never publishes a result for a project that was left while it was pending', async () => {
    let release!: () => void;
    behaviour.gate = new Promise<void>((resolve) => (release = resolve));
    const analysis = makeAnalysis();
    const published = vi.spyOn(analysis.snapshot, 'set');

    analysis.update({ projectId: 'a', revision: 1, project: project() });
    await until(() => behaviour.analyzed.length > 0, 'project a to reach the front end');

    const b = project(`${FRAGMENT}\nfloat onlyInB() { return 1.0; }`);
    analysis.update({ projectId: 'b', revision: 1, project: b });
    release();
    await until(() => analysis.current, 'project b');

    const ids = published.mock.calls.map(([snapshot]) => snapshot?.projectId ?? null);
    expect(ids).not.toContain('a');
    expect(analysis.snapshot()!.projectId).toBe('b');
    expect(analysis.symbolsFor(b.passes[0].id)!.functions.map((f) => f.name)).toContain('onlyInB');
  });

  it('drops the analysis of a departed pass', async () => {
    const withBuffer = project();
    withBuffer.passes.push({
      ...withBuffer.passes[0],
      id: 'buffer-a',
      kind: 'buffer',
      slot: 'A',
      name: 'Buffer A',
    });
    const analysis = await analyse(withBuffer);
    expect(analysis.snapshot()!.units.has('buffer-a')).toBe(true);

    analysis.update({
      projectId: 'p1',
      revision: 2,
      project: {
        ...withBuffer,
        passes: withBuffer.passes.filter((pass) => pass.id !== 'buffer-a'),
      },
    });
    await until(() => analysis.current && analysis.snapshot()!.revision === 2, 'revision 2');
    expect(analysis.snapshot()!.units.has('buffer-a')).toBe(false);
    expect(analysis.symbolsFor('buffer-a')).toBeNull();
  });

  it('cancels departed projects before their pending units can fill the queue', async () => {
    let release!: () => void;
    behaviour.gate = new Promise<void>((resolve) => (release = resolve));
    const analysis = makeAnalysis();
    analysis.update({ projectId: 'pending-0', revision: 1, project: project() });
    await until(() => behaviour.analyzed.length > 0, 'the first pending job');
    for (let index = 1; index <= 10; index++) {
      analysis.update({ projectId: `pending-${index}`, revision: 1, project: project() });
      // Let the facade's zero-delay debounce submit this project's units.
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    release();
    await until(
      () => analysis.current || analysis.health().state === 'unavailable',
      'the latest project result',
    );
    expect(analysis.health().state).toBe('ready');
    expect(analysis.snapshot()?.projectId).toBe('pending-10');
  });

  it('reports a failed start-up as health, not as a shader error, and recovers', async () => {
    behaviour.initFails = true;
    const analysis = makeAnalysis();
    analysis.update({ projectId: 'p1', revision: 1, project: project() });
    await until(() => analysis.health().state === 'unavailable', 'unavailable health');

    expect(analysis.snapshot()).toBeNull();
    expect(analysis.diagnosticsFor(project().passes[0].id)).toEqual([]);

    behaviour.initFails = false;
    await analysis.retry();
    await until(() => analysis.health().state === 'ready', 'recovery');
    expect(analysis.current).toBe(true);
  });
});

describe('source mapping', () => {
  const lib = 'float f() { /* é✓ */ return undeclared_x; }';

  function withInclude(): ShaderProject {
    const base = project(`#include "lib.glsl"\nvoid main() { gl_FragColor = vec4(f()); }`);
    base.files.push({ id: 'file-lib', name: 'lib.glsl', source: `// header\n${lib}\n` });
    return base;
  }

  it('maps an error inside an include to that file, line and UTF-16 column', async () => {
    const next = withInclude();
    const analysis = await analyse(next);

    const found = analysis.snapshot()!.diagnostics.filter((d) => d.severity === 'error');
    const hit = found.find((diagnostic) => diagnostic.message.includes('undeclared'))!;
    expect(hit.docId).toBe('file-lib');
    expect(hit.line).toBe(2);
    expect(hit.origin).toBe('user');
    expect(hit.startColumn).toBe(lib.indexOf('undeclared_x') + 1);
    expect(hit.endColumn).toBe(hit.startColumn! + 'undeclared_x'.length);
    expect(analysis.diagnosticsFor(next.passes[0].id)).toEqual([]);
  });

  it('shows a shared include error once, naming every pass that reports it', async () => {
    const next = withInclude();
    next.passes.splice(1, 0, {
      ...next.passes[0],
      id: 'buffer-a',
      kind: 'buffer',
      slot: 'A',
      name: 'Buffer A',
    });
    const analysis = await analyse(next);

    const inLib = analysis.snapshot()!.diagnostics.filter((d) => d.docId === 'file-lib');
    expect(inLib).toHaveLength(1);
    expect(inLib[0].passIds).toEqual(expect.arrayContaining([next.passes[0].id, 'buffer-a']));
  });

  it('remaps cached diagnostics when the same source belongs to a replacement include', async () => {
    const before = withInclude();
    const analysis = await analyse(before);
    expect(analysis.diagnosticsFor('file-lib')).toHaveLength(1);
    const after = {
      ...before,
      files: before.files.map((file) => ({ ...file, id: 'replacement-lib' })),
    };
    analysis.update({ projectId: 'p1', revision: 2, project: after });
    await until(
      () => analysis.current && analysis.snapshot()!.revision === 2,
      'replacement include',
    );
    expect(analysis.diagnosticsFor('file-lib')).toEqual([]);
    expect(analysis.diagnosticsFor('replacement-lib')).toHaveLength(1);
    expect(analysis.diagnosticsFor('replacement-lib')[0].line).toBe(2);
  });

  it('keeps the line but refuses a column on a line the macro expansion rewrote', async () => {
    const next = project(
      `void main() {\n  float w = float(__MAX_WAVES__) + undeclared_y;\n  gl_FragColor = vec4(w);\n}`,
    );
    const analysis = await analyse(next);

    const hit = analysis.snapshot()!.diagnostics.find((d) => d.message.includes('undeclared'))!;
    expect(hit.line).toBe(2);
    expect(hit.startColumn).toBeNull();
  });

  it('attributes nothing when #line has remapped the compiler lines', () => {
    const next = project(`#line 50\nvoid main() { gl_FragColor = vec4(undeclared_z); }`);
    const unit = prepareFragmentUnit(next, next.passes[0]);
    const mapped = mapDiagnostic(unit, {
      severity: 'error',
      phase: 'compile',
      message: "'undeclared_z' : undeclared identifier",
      token: 'undeclared_z',
      location: { sourceString: '0', line: unit.prefixLines + 2, column: 30, byteColumn: 30 },
    });
    expect(mapped.origin).toBe('unattributed');
    expect(mapped.line).toBeNull();
  });

  it('marks a diagnostic inside the generated prefix as generated, not as a user line', () => {
    const next = project();
    const unit = prepareFragmentUnit(next, next.passes[0]);
    const mapped = mapDiagnostic(unit, {
      severity: 'error',
      phase: 'compile',
      message: "'cameraPosition' : redefinition",
      token: 'cameraPosition',
      location: { sourceString: '0', line: 3, column: 1, byteColumn: 1 },
    });
    expect(mapped.origin).toBe('generated');
    expect(mapped.line).toBeNull();
  });

  it('analyses the vertex shader as its own unit without composition', () => {
    const units = prepareUnits(project());
    const vertex = units.find((unit) => unit.stage === 'vertex')!;
    expect(vertex.spans).toBeNull();
    expect(vertex.docId).toBe('@vertex');
  });
});
