import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { EsslVersion, GlslStage } from '../../src/contract';
import type { AnalysisJob } from '../../src/native-reply';
import type { GlslangModuleFactory } from '../../src/worker/glslang-module';
import { createGlslangRuntime, type GlslangRuntime } from '../../src/worker/runtime';

export const distDir = fileURLToPath(new URL('../../dist/', import.meta.url));
export const corpusDir = fileURLToPath(new URL('../corpus/', import.meta.url));

export interface AssetManifest {
  files: { worker: { path: string; sha256: string }; wasm: { path: string; sha256: string } };
  testSupport: { nodeGlue: string };
  memory: { initialBytes: number };
  glslang: { commit: string; version: string };
}

export async function readManifest(): Promise<AssetManifest> {
  const path = join(distDir, 'glsl-analysis-assets.json');
  if (!existsSync(path)) {
    throw new Error('dist/ is missing: run `pnpm --filter @shadergrove/glsl-analysis build:wasm`');
  }
  return JSON.parse(await readFile(path, 'utf8')) as AssetManifest;
}

/** Instantiates the real compiled glslang module (dist/) in this Node process. */
export async function createFrontend(
  maximumMemoryBytes = 256 * 1024 * 1024,
): Promise<GlslangRuntime> {
  const manifest = await readManifest();
  const glue = (await import(pathToFileURL(join(distDir, manifest.testSupport.nodeGlue)).href)) as {
    default: GlslangModuleFactory;
  };
  return createGlslangRuntime(glue.default, {
    wasmBinary: await readFile(join(distDir, manifest.files.wasm.path)),
    initialMemoryBytes: manifest.memory.initialBytes,
    maximumMemoryBytes,
  });
}

export function readCorpus(name: string): Promise<string> {
  return readFile(join(corpusDir, name), 'utf8');
}

let nextId = 0;
export function job(source: string, stage: GlslStage, version: EsslVersion): AnalysisJob {
  return { requestId: `job-${++nextId}`, stage, version, source };
}
