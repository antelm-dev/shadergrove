import { describe, expect, it } from 'vitest';
import { resolveGlslAnalysisAssets } from './assets';

describe('resolveGlslAnalysisAssets', () => {
  it('resolves assets inside the given directory', () => {
    expect(resolveGlslAnalysisAssets('https://app.example/studio/glsl-analysis')).toEqual({
      workerUrl: 'https://app.example/studio/glsl-analysis/glsl-analysis-worker.js',
      wasmUrl: 'https://app.example/studio/glsl-analysis/glsl-analysis.wasm',
    });
  });

  it('works for custom app protocols and URL objects', () => {
    expect(resolveGlslAnalysisAssets(new URL('app://bundle/assets/analysis/')).wasmUrl).toBe(
      'app://bundle/assets/analysis/glsl-analysis.wasm',
    );
  });

  it('refuses relative bases instead of guessing a web root', () => {
    expect(() => resolveGlslAnalysisAssets('assets/glsl-analysis/')).toThrow(TypeError);
  });
});
