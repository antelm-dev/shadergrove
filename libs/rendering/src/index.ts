/**
 * The shader runtime: one `ShaderEngine` per `GlContext`, three.js loaded on
 * demand. Browser-only and framework-free, so the studio and any other web host
 * (a VS Code webview, say) run the very same engine.
 */
export * from './shader-engine';
export * from './gl-context';
export * from './engine-output-sink';
export * from './performance-profiler';
export * from './render-inspection';
// Types only: the engine loads render-observation on demand, a value re-export would make it eager.
export type * from './render-observation';
export { effectDocId } from './engine/custom-effect-pass';
