/** File names produced in dist/ by `build:wasm`; copy the whole set (plus licenses/) together. */
export const GLSL_ANALYSIS_ASSET_FILES = {
  worker: 'glsl-analysis-worker.js',
  wasm: 'glsl-analysis.wasm',
  manifest: 'glsl-analysis-assets.json',
  licenses: 'licenses/',
} as const;

export interface GlslAnalysisAssets {
  /** Absolute URL of the module Worker script. */
  readonly workerUrl: string;
  /** Absolute URL of the WASM binary, fetched by the Worker itself. */
  readonly wasmUrl: string;
}

/**
 * Resolves the analysis assets inside a directory the caller serves locally,
 * e.g. `new URL('glsl-analysis/', document.baseURI)` on the web or the
 * packaged app's asset URL in Electron. No web root, CDN or file:// layout is
 * assumed here; the base must be absolute.
 */
export function resolveGlslAnalysisAssets(baseUrl: string | URL): GlslAnalysisAssets {
  let base: URL;
  try {
    base = new URL(String(baseUrl));
  } catch {
    throw new TypeError(
      `GLSL analysis asset base must be an absolute URL, got "${String(baseUrl)}"`,
    );
  }
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  return {
    workerUrl: new URL(GLSL_ANALYSIS_ASSET_FILES.worker, base).href,
    wasmUrl: new URL(GLSL_ANALYSIS_ASSET_FILES.wasm, base).href,
  };
}
