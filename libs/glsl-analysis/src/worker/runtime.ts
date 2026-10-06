import {
  interpretNativeReply,
  type AnalysisJob,
  type JobOutcome,
  type NativeReply,
} from '../native-reply';
import type { GlslangModule, GlslangModuleFactory } from './glslang-module';

const PAGE_BYTES = 65_536;

export type FatalReason = 'memory-limit' | 'crashed';

/** The WASM instance is unusable after this; the host must recreate the Worker. */
export class RuntimeFatalError extends Error {
  constructor(
    readonly reason: FatalReason,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeFatalError';
  }
}

export interface FrontendInfo {
  readonly glslangVersion: string;
  readonly glslangCommit: string;
}

export interface RuntimeOptions {
  readonly wasmBinary: BufferSource;
  /** Must be at least the module's compiled INITIAL_MEMORY. */
  readonly initialMemoryBytes: number;
  /** Hard runtime ceiling for linear memory; growth beyond it fails the request. */
  readonly maximumMemoryBytes: number;
}

export interface GlslangRuntime {
  readonly info: FrontendInfo;
  analyze(job: AnalysisJob): JobOutcome;
  /** Bytes currently malloc'd inside the module. */
  heapBytes(): number;
  /** Current linear-memory size (never shrinks). */
  memoryBytes(): number;
  readonly usable: boolean;
}

const STAGE_CODE = { vertex: 0, fragment: 1 } as const;

/**
 * Instantiates the glslang module in the current thread. Used by the Worker
 * and directly by Node tests; it never runs on the UI thread in production.
 */
export async function createGlslangRuntime(
  factory: GlslangModuleFactory,
  options: RuntimeOptions,
): Promise<GlslangRuntime> {
  // Budget failures reject here, before any memory exists; the Worker reports
  // them as `init-error` and the client as `unavailable`.
  for (const [name, bytes] of [
    ['initialMemoryBytes', options.initialMemoryBytes],
    ['maximumMemoryBytes', options.maximumMemoryBytes],
  ] as const) {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes % PAGE_BYTES !== 0) {
      throw new RangeError(
        `${name} must be a positive multiple of ${PAGE_BYTES} bytes, got ${bytes}`,
      );
    }
  }
  if (options.maximumMemoryBytes < options.initialMemoryBytes) {
    throw new RangeError(
      `maxMemoryBytes ${options.maximumMemoryBytes} is below the ${options.initialMemoryBytes} bytes the module needs to start`,
    );
  }
  const initial = options.initialMemoryBytes / PAGE_BYTES;
  const maximum = options.maximumMemoryBytes / PAGE_BYTES;
  const memory = new WebAssembly.Memory({ initial, maximum });

  // Emscripten grows memory from JS; record a refused growth so a later abort
  // is reported as the memory limit rather than a generic crash.
  let growthRefused = false;
  const grow = memory.grow.bind(memory);
  memory.grow = (delta: number) => {
    try {
      return grow(delta);
    } catch (error) {
      growthRefused = true;
      throw error;
    }
  };

  let aborted: string | null = null;
  // Emscripten's factory promise never settles if instantiation fails, so a
  // failed instantiate or an abort during start-up rejects this race instead.
  let failStartup: (error: unknown) => void = () => undefined;
  const startupFailed = new Promise<never>((_, reject) => {
    failStartup = reject;
  });
  // A later abort (during analysis) must not surface as an unhandled rejection.
  startupFailed.catch(() => undefined);
  const module: GlslangModule = await Promise.race([
    factory({
      wasmMemory: memory,
      instantiateWasm(imports, receive) {
        WebAssembly.instantiate(options.wasmBinary, imports).then(
          ({ instance, module: compiled }) => receive(instance, compiled),
          failStartup,
        );
        return {};
      },
      print: () => undefined,
      printErr: () => undefined,
      onAbort: (reason) => {
        aborted = String(reason);
        failStartup(new Error(`glslang aborted during start-up: ${aborted}`));
      },
    }),
    startupFailed,
  ]);

  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const heap = () => new Uint8Array(memory.buffer);
  const readReply = (pointer: number): string => {
    const bytes = heap();
    const end = bytes.indexOf(0, pointer);
    return decoder.decode(bytes.subarray(pointer, end < 0 ? bytes.length : end));
  };

  const initPointer = module._gla_init();
  if (!initPointer) throw new RuntimeFatalError('memory-limit', 'glslang initialisation failed');
  const init = JSON.parse(readReply(initPointer)) as FrontendInfo & { initialized: boolean };
  module._gla_free(initPointer);
  if (!init.initialized)
    throw new RuntimeFatalError('crashed', 'glslang::InitializeProcess failed');

  let usable = true;
  const fail = (error: unknown): RuntimeFatalError => {
    usable = false;
    if (error instanceof RuntimeFatalError) return error;
    const detail =
      aborted || (error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    return growthRefused
      ? new RuntimeFatalError(
          'memory-limit',
          `WASM memory limit of ${memory.buffer.byteLength} bytes reached (${detail})`,
        )
      : new RuntimeFatalError('crashed', `glslang trapped (${detail})`);
  };

  return {
    info: { glslangVersion: init.glslangVersion, glslangCommit: init.glslangCommit },
    get usable() {
      return usable;
    },
    heapBytes: () => module._gla_heap_used(),
    memoryBytes: () => memory.buffer.byteLength,
    analyze(job) {
      if (!usable)
        throw new RuntimeFatalError('crashed', 'The glslang runtime is no longer usable');
      const bytes = encoder.encode(job.source);
      let source = 0;
      let reply = 0;
      try {
        source = module._malloc(bytes.length + 1);
        if (!source) throw new RuntimeFatalError('memory-limit', 'Could not allocate the source');
        const view = heap();
        view.set(bytes, source);
        view[source + bytes.length] = 0;
        reply = module._gla_analyze(source, bytes.length, STAGE_CODE[job.stage]);
        if (!reply) throw new RuntimeFatalError('memory-limit', 'Could not allocate the reply');
        return interpretNativeReply(JSON.parse(readReply(reply)) as NativeReply, job);
      } catch (error) {
        throw fail(error);
      } finally {
        if (usable) {
          if (source) module._free(source);
          if (reply) module._gla_free(reply);
        }
      }
    },
  };
}
