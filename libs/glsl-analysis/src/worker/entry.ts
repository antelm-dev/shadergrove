// Module Worker entry bundled by tools/glsl-analysis/build-wasm.ts into dist/glsl-analysis-worker.js.
import createGlslangModule from '#glslang-module';
import { serveGlslAnalysis } from './serve';

serveGlslAnalysis({
  createModule: createGlslangModule,
  initialMemoryBytes: __GLSL_ANALYSIS_INITIAL_MEMORY__,
  wasmSha256: __GLSL_ANALYSIS_WASM_SHA256__,
});
