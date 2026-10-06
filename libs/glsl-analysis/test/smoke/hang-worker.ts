// Smoke-test fixture only (never shipped): the real Worker and WASM, except
// that a source containing HANG_SENTINEL never returns from the synchronous
// native analysis call. This deterministically reproduces a hung compile that
// no message can interrupt; only the host watchdog can end it.
import createGlslangModule from '#glslang-module';
import type { GlslangModule, GlslangModuleFactory } from '../../src/worker/glslang-module';
import { serveGlslAnalysis } from '../../src/worker/serve';

const HANG_SENTINEL = '@smoke-hang';
const decoder = new TextDecoder();

const hangingModule: GlslangModuleFactory = async (options) => {
  const module: GlslangModule = await createGlslangModule(options);
  const analyze = module._gla_analyze.bind(module);
  module._gla_analyze = (source: number, length: number, stage: number): number => {
    const text = decoder.decode(new Uint8Array(options.wasmMemory.buffer, source, length));
    const reply = analyze(source, length, stage);
    const forever = Number.POSITIVE_INFINITY;
    while (text.includes(HANG_SENTINEL) && performance.now() < forever) {
      // Spin: the Worker thread is blocked exactly like a non-terminating compile.
    }
    return reply;
  };
  return module;
};

serveGlslAnalysis({
  createModule: hangingModule,
  initialMemoryBytes: __GLSL_ANALYSIS_INITIAL_MEMORY__,
  wasmSha256: __GLSL_ANALYSIS_WASM_SHA256__,
});
