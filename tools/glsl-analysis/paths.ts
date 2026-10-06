import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const toolsDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(toolsDir, '..', '..');
export const packageDir = join(repoRoot, 'libs', 'glsl-analysis');
export const distDir = join(packageDir, 'dist');
export const glslangThirdPartyDir = join(repoRoot, 'third_party', 'glslang');

/**
 * Everything downloaded or generated lives under the ignored `.tmp/glsl-analysis`
 * directory so a clean checkout never depends on a hidden local artifact.
 * `GLSL_ANALYSIS_CACHE_DIR` relocates it (CI caches it between runs).
 */
export const cacheDir = resolve(
  process.env['GLSL_ANALYSIS_CACHE_DIR'] ?? join(repoRoot, '.tmp', 'glsl-analysis'),
);
export const downloadsDir = join(cacheDir, 'downloads');
export const sourcesDir = join(cacheDir, 'src');
export const toolchainsDir = join(cacheDir, 'toolchain');
export const buildDir = join(cacheDir, 'build');
export const evidenceDir = join(cacheDir, 'evidence');
