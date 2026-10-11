/**
 * Where `ShaderEngine` sends the driver's raw compile output and its own
 * renderer messages, without depending on Angular or the Output panel.
 *
 * `ShaderEngine` is constructed through a static factory, not Angular's
 * injector, so it cannot `inject(OutputLog)` itself — the caller that *can*
 * (`ShaderCanvas`) hands one down instead. `OutputLog` (see
 * `../ui/bottom-panel/output-log`) satisfies this interface structurally: its
 * `write` accepts a wider set of sources than the engine ever produces, which
 * is exactly what makes passing it here without an adapter type-check.
 */
export type EngineOutputLevel = 'info' | 'warning' | 'error';
export type EngineOutputSource = 'compiler' | 'renderer';

export interface EngineOutputSink {
  write(level: EngineOutputLevel, source: EngineOutputSource, message: string): void;
}
