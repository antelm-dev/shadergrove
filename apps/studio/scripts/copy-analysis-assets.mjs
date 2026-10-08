// Angular only accepts asset inputs inside this app, so stage the analysis
// package's built Worker, WASM, manifest and licenses here (git-ignored).
import { cpSync, existsSync, rmSync } from 'node:fs';

const from = new URL('../../../libs/glsl-analysis/dist/', import.meta.url);
const to = new URL('../.glsl-analysis-assets/', import.meta.url);

rmSync(to, { recursive: true, force: true });
for (const file of ['glsl-analysis-worker.js', 'glsl-analysis.wasm', 'glsl-analysis-assets.json']) {
  if (!existsSync(new URL(file, from))) throw new Error(`${file} is missing: run build:wasm first`);
  cpSync(new URL(file, from), new URL(file, to));
}
cpSync(new URL('licenses/', from), new URL('licenses/', to), { recursive: true });
