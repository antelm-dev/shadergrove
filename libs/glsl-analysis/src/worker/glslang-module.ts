/** Exports of the Emscripten module built from native/glsl_analysis.cpp. */
export interface GlslangModule {
  _malloc(size: number): number;
  _free(pointer: number): void;
  _gla_init(): number;
  _gla_analyze(source: number, length: number, stage: number): number;
  _gla_observe(source: number, length: number, stage: number): number;
  _gla_free(reply: number): void;
  _gla_heap_used(): number;
}

/** The subset of Emscripten's incoming Module API the build allows (INCOMING_MODULE_JS_API). */
export interface GlslangModuleOptions {
  wasmMemory: WebAssembly.Memory;
  instantiateWasm(
    imports: WebAssembly.Imports,
    receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
  ): object;
  print?(text: string): void;
  printErr?(text: string): void;
  onAbort?(reason: unknown): void;
}

export type GlslangModuleFactory = (options: GlslangModuleOptions) => Promise<GlslangModule>;
