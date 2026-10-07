/**
 * Builds libs/glsl-analysis/dist from pinned inputs only:
 *   glslang (third_party/glslang/UPSTREAM.json) + native wrapper
 *     --em++ (tools/glsl-analysis/toolchain.lock.json)--> glue + WASM
 *   glue + src/worker --esbuild--> self-contained module Worker
 * and records every input hash, option and notice in glsl-analysis-assets.json.
 *
 *   pnpm --filter @shadergrove/glsl-analysis build:wasm
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib';
import { fileExists, sha256File } from './archive.ts';
import {
  checkThirdPartyLicense,
  ensureGlslangSource,
  ensureToolchain,
  readUpstream,
  type GlslangSource,
  type Toolchain,
} from './bootstrap.ts';
import {
  buildDir,
  distDir,
  glslangThirdPartyDir,
  packageDir,
  repoRoot,
  toolsDir,
} from './paths.ts';
import { run, runPool } from './process.ts';

/** Linear-memory floor; the Worker imports a memory with this initial size. */
export const INITIAL_MEMORY_BYTES = 32 * 1024 * 1024;
/** Hard ceiling compiled into the module; the host chooses a lower runtime maximum. */
const MAXIMUM_MEMORY_BYTES = 1024 * 1024 * 1024;
const STACK_BYTES = 1024 * 1024;

const COMPILE_FLAGS = [
  '-std=c++17',
  '-Os',
  '-fno-exceptions',
  '-fno-rtti',
  '-DNDEBUG',
  '-DGLSLANG_OSINCLUDE_UNIX',
  '-Wno-unused-parameter',
  '-Wno-unused-variable',
  '-Wno-unused-but-set-variable',
  '-Wno-unused-const-variable',
];

const EXPORTED_FUNCTIONS = [
  '_malloc',
  '_free',
  '_gla_init',
  '_gla_analyze',
  '_gla_observe',
  '_gla_free',
  '_gla_heap_used',
];

const LINK_FLAGS = [
  '-Os',
  '-fno-exceptions',
  '-fno-rtti',
  '-sMODULARIZE=1',
  '-sEXPORT_ES6=1',
  '-sEXPORT_NAME=createGlslangModule',
  '-sENVIRONMENT=web,worker,node',
  '-sFILESYSTEM=0',
  '-sDYNAMIC_EXECUTION=0',
  '-sALLOW_MEMORY_GROWTH=1',
  '-sIMPORTED_MEMORY=1',
  '-sABORTING_MALLOC=0',
  `-sINITIAL_MEMORY=${INITIAL_MEMORY_BYTES}`,
  `-sMAXIMUM_MEMORY=${MAXIMUM_MEMORY_BYTES}`,
  `-sSTACK_SIZE=${STACK_BYTES}`,
  '-sSTACK_OVERFLOW_CHECK=1',
  '-sASSERTIONS=0',
  `-sEXPORTED_FUNCTIONS=${EXPORTED_FUNCTIONS.join(',')}`,
  '-sEXPORTED_RUNTIME_METHODS=[]',
  '-sINCOMING_MODULE_JS_API=instantiateWasm,wasmMemory,print,printErr,onAbort',
];

const WORKER_FILE = 'glsl-analysis-worker.js';
const WASM_FILE = 'glsl-analysis.wasm';
const GLUE_FILE = 'node/glslang-module.mjs';
const MANIFEST_FILE = 'glsl-analysis-assets.json';
const WRAPPER = join(packageDir, 'native', 'glsl_analysis.cpp');

const hashText = (text: string) => createHash('sha256').update(text).digest('hex');

async function emcc(toolchain: Toolchain, args: string[], cwd: string): Promise<void> {
  const script = join(toolchain.emscriptenDir, 'em++.py');
  await run(toolchain.python.command, [...toolchain.python.args, script, ...args], {
    cwd,
    env: toolchain.env,
  });
}

async function writeBuildInfo(source: GlslangSource, includeDir: string): Promise<void> {
  const template = await readFile(join(source.dir, 'build_info.h.tmpl'), 'utf8');
  const [, major, minor, patch, flavor] = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(source.version) ?? [];
  const header = template
    .replaceAll('@major@', major ?? '0')
    .replaceAll('@minor@', minor ?? '0')
    .replaceAll('@patch@', patch ?? '0')
    .replaceAll('@flavor@', flavor ?? '');
  await mkdir(join(includeDir, 'glslang'), { recursive: true });
  await writeFile(join(includeDir, 'glslang', 'build_info.h'), header);
}

async function compileObjects(
  toolchain: Toolchain,
  source: GlslangSource,
  includeDir: string,
  sources: string[],
): Promise<string[]> {
  const objectDir = join(buildDir, 'obj');
  await mkdir(objectDir, { recursive: true });
  const flags = [
    ...COMPILE_FLAGS,
    `-I${source.dir}`,
    `-I${includeDir}`,
    `-DGLA_GLSLANG_COMMIT="${source.commit}"`,
  ];
  const objects: string[] = [];
  const pending: { file: string; object: string }[] = [];
  for (const file of sources) {
    const key = hashText(
      JSON.stringify([
        toolchain.archiveSha256,
        // Headers are not hashed per object; the pinned tree digest covers them.
        source.treeDigest,
        source.version,
        flags,
        relative(repoRoot, file).replaceAll('\\', '/'),
      ]) + (await sha256File(file)),
    );
    const object = join(objectDir, `${basename(file, '.cpp')}-${key.slice(0, 16)}.o`);
    objects.push(object);
    if (!(await fileExists(object))) pending.push({ file, object });
  }
  let done = 0;
  await runPool(pending, availableParallelism(), async ({ file, object }) => {
    await emcc(toolchain, [...flags, '-c', file, '-o', `${object}.tmp`], source.dir);
    await rename(`${object}.tmp`, object);
    done++;
    console.log(`[glsl-analysis] compiled ${done}/${pending.length} ${basename(file)}`);
  });
  return objects;
}

interface AssetRecord {
  path: string;
  bytes: number;
  sha256: string;
  gzipBytes: number;
  brotliBytes: number;
}

async function describeAsset(path: string): Promise<AssetRecord> {
  const content = await readFile(path);
  return {
    path: relative(distDir, path).replaceAll('\\', '/'),
    bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
    gzipBytes: gzipSync(content, { level: 9 }).length,
    brotliBytes: brotliCompressSync(content, {
      params: { [zlib.BROTLI_PARAM_QUALITY]: 11 },
    }).length,
  };
}

async function main(): Promise<void> {
  const started = performance.now();
  const upstream = await readUpstream();
  if (upstream.patches.length) throw new Error('Upstream patches are not supported yet');
  const source = await ensureGlslangSource();
  await checkThirdPartyLicense(source);
  const toolchain = await ensureToolchain();

  const includeDir = join(buildDir, 'include', source.commit);
  await writeBuildInfo(source, includeDir);
  const sources = [...upstream.compiledSources.map((path) => join(source.dir, path)), WRAPPER];
  const objects = await compileObjects(toolchain, source, includeDir, sources);

  const inputs = {
    glslangCommit: source.commit,
    glslangTreeDigest: source.treeDigest,
    toolchainArchiveSha256: toolchain.archiveSha256,
    wrapperSha256: await sha256File(WRAPPER),
    buildScriptSha256: await sha256File(join(toolsDir, 'build-wasm.ts')),
    compileFlags: COMPILE_FLAGS,
    linkFlags: LINK_FLAGS,
    // Ordered link inputs; object names embed a hash of source, flags and toolchain.
    linkObjects: objects.map((object) => basename(object)),
  };
  const buildKey = hashText(JSON.stringify(inputs));
  const linkDir = join(buildDir, 'link', buildKey.slice(0, 16));
  const glue = join(linkDir, 'glslang-module.mjs');
  if (!(await fileExists(join(linkDir, 'glslang-module.wasm')))) {
    await mkdir(linkDir, { recursive: true });
    console.log('[glsl-analysis] linking');
    await emcc(toolchain, [...LINK_FLAGS, ...objects, '-o', glue], linkDir);
  }

  await rm(distDir, { recursive: true, force: true });
  await mkdir(join(distDir, 'node'), { recursive: true });
  await mkdir(join(distDir, 'licenses'), { recursive: true });
  const wasm = join(distDir, WASM_FILE);
  await copyFile(join(linkDir, 'glslang-module.wasm'), wasm);
  await copyFile(glue, join(distDir, GLUE_FILE));
  const wasmSha256 = await sha256File(wasm);

  const require = createRequire(join(packageDir, 'package.json'));
  const esbuild = require('esbuild') as typeof import('esbuild');
  const bundle = await esbuild.build({
    entryPoints: [join(packageDir, 'src', 'worker', 'entry.ts')],
    outfile: join(distDir, WORKER_FILE),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    minify: true,
    legalComments: 'eof',
    metafile: true,
    // The Emscripten glue has Node-only branches that never run in a Worker.
    external: ['module', 'node:*', 'fs', 'path', 'url', 'crypto', 'worker_threads'],
    alias: { '#glslang-module': glue },
    define: {
      __GLSL_ANALYSIS_WASM_SHA256__: JSON.stringify(wasmSha256),
      __GLSL_ANALYSIS_INITIAL_MEMORY__: String(INITIAL_MEMORY_BYTES),
    },
    logLevel: 'warning',
  });

  const licenses: Record<string, string> = {
    'licenses/glslang-LICENSE.txt': join(glslangThirdPartyDir, 'LICENSE.txt'),
    'licenses/emscripten-LICENSE.txt': join(toolchain.emscriptenDir, 'LICENSE'),
    'licenses/libcxx-LICENSE.txt': join(toolchain.emscriptenDir, 'system/lib/libcxx/LICENSE.TXT'),
    'licenses/libcxxabi-LICENSE.txt': join(
      toolchain.emscriptenDir,
      'system/lib/libcxxabi/LICENSE.TXT',
    ),
    'licenses/compiler-rt-LICENSE.txt': join(
      toolchain.emscriptenDir,
      'system/lib/compiler-rt/LICENSE.TXT',
    ),
    'licenses/musl-COPYRIGHT.txt': join(toolchain.emscriptenDir, 'system/lib/libc/musl/COPYRIGHT'),
  };
  for (const [target, from] of Object.entries(licenses)) {
    await copyFile(from, join(distDir, target));
  }

  const manifest = {
    formatVersion: 1,
    files: {
      worker: await describeAsset(join(distDir, WORKER_FILE)),
      wasm: await describeAsset(wasm),
    },
    testSupport: { nodeGlue: GLUE_FILE },
    licenses: Object.keys(licenses),
    memory: {
      initialBytes: INITIAL_MEMORY_BYTES,
      compiledMaximumBytes: MAXIMUM_MEMORY_BYTES,
      stackBytes: STACK_BYTES,
    },
    glslang: {
      repository: upstream.repository,
      commit: source.commit,
      version: source.version,
      treeDigest: source.treeDigest,
      compiledSources: upstream.compiledSources,
      patches: upstream.patches,
    },
    toolchain: {
      emscripten: toolchain.version,
      releaseHash: toolchain.releaseHash,
      platform: toolchain.platform,
      archiveSha256: toolchain.archiveSha256,
      python: toolchain.python.version,
      node: process.version,
      esbuild: esbuild.version,
    },
    build: {
      key: buildKey,
      compileFlags: COMPILE_FLAGS,
      linkFlags: LINK_FLAGS,
      wrapperSha256: inputs.wrapperSha256,
      bundleInputs: Object.keys(bundle.metafile.inputs).length,
    },
  };
  await writeFile(join(distDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const { size } = await stat(wasm);
  console.log(
    `[glsl-analysis] built ${WORKER_FILE} (${manifest.files.worker.bytes} B) + ${WASM_FILE} ` +
      `(${size} B, brotli ${manifest.files.wasm.brotliBytes} B) in ${seconds}s; key ${buildKey.slice(0, 16)}`,
  );
}

await main();
