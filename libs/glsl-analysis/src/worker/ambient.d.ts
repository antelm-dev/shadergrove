// Resolved by tools/glsl-analysis/build-wasm.ts (esbuild alias) to the generated Emscripten glue.
declare module '#glslang-module' {
  import type { GlslangModuleFactory } from './glslang-module';

  const createGlslangModule: GlslangModuleFactory;
  export default createGlslangModule;
}

// Injected by the Worker bundle build.
declare const __GLSL_ANALYSIS_WASM_SHA256__: string;
declare const __GLSL_ANALYSIS_INITIAL_MEMORY__: number;
