/**
 * Real-WASM check that the link cache is keyed by the actual ordered compiler
 * inputs. Run after a normal build (it reuses the same cache):
 *
 *   node tools/glsl-analysis/cache-probe.ts
 *
 *   1. wrapper-only selection  -> build must fail (unresolved symbols), dist untouched
 *   2. reordered selection     -> build succeeds with a different key and the reordered
 *                                 provenance (it may be a cache hit from an earlier run)
 *   3. pinned selection again  -> original key, no relink (unchanged-build reuse)
 *
 * On any failure the pinned selection is rebuilt so dist never keeps probe provenance.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { distDir, glslangThirdPartyDir, toolsDir } from './paths.ts';
import type { GlslangUpstream } from './bootstrap.ts';

const manifestPath = join(distDir, 'glsl-analysis-assets.json');
const readManifest = async () =>
  JSON.parse(await readFile(manifestPath, 'utf8')) as {
    build: { key: string };
    glslang: { compiledSources: string[] };
    files: { wasm: { sha256: string } };
  };

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`cache-probe: ${message}`);
  console.log(`ok - ${message}`);
}

const pinned = JSON.parse(
  await readFile(join(glslangThirdPartyDir, 'UPSTREAM.json'), 'utf8'),
) as GlslangUpstream;
const scratch = await mkdtemp(join(tmpdir(), 'glsl-analysis-probe-'));

async function build(compiledSources: string[]) {
  const upstream = join(scratch, 'UPSTREAM.json');
  await writeFile(upstream, JSON.stringify({ ...pinned, compiledSources }));
  const result = spawnSync(process.execPath, [join(toolsDir, 'build-wasm.ts')], {
    encoding: 'utf8',
    env: { ...process.env, GLSL_ANALYSIS_UPSTREAM: upstream },
  });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

const sha256 = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const wasmPath = join(distDir, 'glsl-analysis.wasm');

let before: Awaited<ReturnType<typeof readManifest>> | undefined;
const problems: unknown[] = [];
let restored = false;
try {
  before = await readManifest();
  assert(before.glslang.compiledSources.length === pinned.compiledSources.length, 'baseline dist');

  const wrapperOnly = await build([]);
  assert(
    wrapperOnly.code !== 0,
    'wrapper-only selection fails instead of reusing the old compiler',
  );
  assert(/undefined symbol|unresolved/i.test(wrapperOnly.output), 'failure is unresolved symbols');
  assert((await readManifest()).files.wasm.sha256 === before.files.wasm.sha256, 'dist untouched');

  const reordered = await build([...pinned.compiledSources].reverse());
  assert(reordered.code === 0, 'reordered selection builds');
  // The reversed link may already be cached from an earlier run, so relinking is not required.
  const swapped = await readManifest();
  assert(swapped.build.key !== before.build.key, 'reordered selection changes key');
  assert(
    JSON.stringify(swapped.glslang.compiledSources) ===
      JSON.stringify([...pinned.compiledSources].reverse()),
    'manifest records the reordered sources',
  );
  assert(
    swapped.files.wasm.sha256 === (await sha256(wasmPath)),
    'manifest WASM hash matches the generated asset',
  );

  const pinnedAgain = await build(pinned.compiledSources);
  restored = pinnedAgain.code === 0;
  assert(restored, 'pinned selection builds');
  assert(!/linking|compiled \d/.test(pinnedAgain.output), 'pinned selection reuses cached link');
  const after = await readManifest();
  assert(after.build.key === before.build.key, 'original key restored');
  assert(after.files.wasm.sha256 === before.files.wasm.sha256, 'original WASM hash restored');
} catch (error) {
  problems.push(error);
} finally {
  // Cleanup never throws here (no-unsafe-finally); problems are raised after this block.
  try {
    // Never leave generated assets describing a probe selection.
    if (!restored) {
      const result = await build(pinned.compiledSources);
      const key = (await readManifest()).build.key;
      if (result.code !== 0 || (before && key !== before.build.key)) {
        problems.push(
          new Error(`cache-probe: restoring the pinned build failed\n${result.output}`),
        );
      }
    }
  } catch (error) {
    problems.push(error);
  }
  await rm(scratch, { recursive: true, force: true }).catch((error) => problems.push(error));
}
if (problems.length === 1) throw problems[0];
if (problems.length) throw new AggregateError(problems, 'cache-probe failed and restore failed');
