/**
 * Materialises the pinned glslang sources and the pinned Emscripten toolchain
 * under `.tmp/glsl-analysis`. Inputs are verified by content (git object ids,
 * archive SHA-256) before use; nothing is taken from PATH except git, Python
 * and the running Node.js.
 *
 *   node tools/glsl-analysis/bootstrap.ts
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePinnedDownload, extractZip, fileExists, type PinnedDownload } from './archive.ts';
import {
  cacheDir,
  downloadsDir,
  glslangThirdPartyDir,
  sourcesDir,
  toolchainsDir,
  toolsDir,
} from './paths.ts';
import { findPython, run, type PythonCommand } from './process.ts';

export interface GlslangUpstream {
  name: string;
  repository: string;
  commit: string;
  committedAt: string;
  paths: string[];
  compiledSources: string[];
  patches: string[];
}

export interface ToolchainLock {
  emscripten: {
    version: string;
    emsdkCommit: string;
    releaseHash: string;
    archives: Record<string, PinnedDownload & { format: 'zip' | 'tar.xz' }>;
  };
}

export interface GlslangSource {
  dir: string;
  commit: string;
  version: string;
  /** SHA-256 over the sorted `<blob id> <path>` list of every materialised file. */
  treeDigest: string;
  /** SHA-256 over the pinned path selection; a changed selection re-materialises. */
  selectionSha256: string;
}

/** Identity of what UPSTREAM.json asks to be materialised from the pinned commit. */
export function selectionDigest(upstream: GlslangUpstream): string {
  return createHash('sha256')
    .update(JSON.stringify([upstream.commit, upstream.paths, upstream.compiledSources]))
    .digest('hex');
}

export interface Toolchain {
  version: string;
  releaseHash: string;
  platform: string;
  archiveSha256: string;
  emscriptenDir: string;
  configPath: string;
  python: PythonCommand;
  env: NodeJS.ProcessEnv;
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

/** `GLSL_ANALYSIS_UPSTREAM` points the cache-invalidation probe at an edited copy. */
export const readUpstream = () =>
  readJson<GlslangUpstream>(
    process.env['GLSL_ANALYSIS_UPSTREAM'] ?? join(glslangThirdPartyDir, 'UPSTREAM.json'),
  );
export const readToolchainLock = () =>
  readJson<ToolchainLock>(join(toolsDir, 'toolchain.lock.json'));

function catFileBatch(gitDir: string, ids: string[]): Promise<Map<string, Buffer>> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', ['--git-dir', gitDir, 'cat-file', '--batch'], { shell: false });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`git cat-file exited with ${code}`));
      const output = Buffer.concat(chunks);
      const blobs = new Map<string, Buffer>();
      let cursor = 0;
      while (cursor < output.length) {
        const newline = output.indexOf(0x0a, cursor);
        const [id, type, size] = output.toString('utf8', cursor, newline).split(' ');
        if (type !== 'blob' || !id || !size) return reject(new Error(`Unexpected object ${id}`));
        const start = newline + 1;
        blobs.set(id, output.subarray(start, start + Number(size)));
        cursor = start + Number(size) + 1;
      }
      resolvePromise(blobs);
    });
    child.stdin.end(ids.join('\n') + '\n');
  });
}

/** The version glslang's CMake derives from the first release heading in CHANGES.md. */
export function parseGlslangVersion(changes: string): string {
  const match = /^## (\d+)\.(\d+)\.(\d+)(-[A-Za-z0-9]+)?/m.exec(changes);
  if (!match) throw new Error('Could not find a release heading in glslang CHANGES.md');
  return match.slice(1, 4).join('.') + (match[4] ?? '');
}

export async function ensureGlslangSource(): Promise<GlslangSource> {
  const upstream = await readUpstream();
  const dir = join(sourcesDir, `glslang-${upstream.commit}`);
  const markerPath = join(dir, '.materialized.json');
  if (await fileExists(markerPath)) {
    const marker = await readJson<GlslangSource>(markerPath);
    if (marker.commit === upstream.commit && marker.selectionSha256 === selectionDigest(upstream)) {
      return { ...marker, dir };
    }
  }

  const gitDir = join(sourcesDir, 'glslang.git');
  if (!(await fileExists(gitDir))) {
    await mkdir(sourcesDir, { recursive: true });
    await run('git', ['init', '--bare', '--quiet', gitDir]);
  }
  const present = await run(
    'git',
    ['--git-dir', gitDir, 'cat-file', '-e', `${upstream.commit}^{commit}`],
    { allowFailure: true },
  );
  if (present.code !== 0) {
    console.log(`[glsl-analysis] fetching ${upstream.repository} @ ${upstream.commit}`);
    await run('git', [
      '--git-dir',
      gitDir,
      'fetch',
      '--quiet',
      '--depth=1',
      '--no-tags',
      upstream.repository,
      upstream.commit,
    ]);
  }
  const resolved = (
    await run('git', ['--git-dir', gitDir, 'rev-parse', `${upstream.commit}^{commit}`])
  ).stdout.trim();
  if (resolved !== upstream.commit) {
    throw new Error(`glslang commit mismatch: expected ${upstream.commit}, got ${resolved}`);
  }

  const listing = await run('git', [
    '--git-dir',
    gitDir,
    'ls-tree',
    '-r',
    '-z',
    upstream.commit,
    '--',
    ...upstream.paths,
  ]);
  const entries = listing.stdout
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split('\t') as [string, string];
      const [, type, id] = meta.split(' ') as [string, string, string];
      return { type, id, path };
    })
    .filter((entry) => entry.type === 'blob');
  for (const path of upstream.paths) {
    if (!entries.some((entry) => entry.path === path || entry.path.startsWith(`${path}/`))) {
      throw new Error(`Pinned glslang path is missing upstream: ${path}`);
    }
  }
  for (const path of upstream.compiledSources) {
    if (!entries.some((entry) => entry.path === path)) {
      throw new Error(`Compiled glslang source is not materialised: ${path}`);
    }
  }

  const blobs = await catFileBatch(
    gitDir,
    entries.map((entry) => entry.id),
  );
  const staging = `${dir}.partial`;
  await rm(staging, { recursive: true, force: true });
  for (const entry of entries) {
    const target = join(staging, entry.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, blobs.get(entry.id) as Buffer);
  }
  const treeDigest = createHash('sha256')
    .update(
      entries
        .map((entry) => `${entry.id} ${entry.path}\n`)
        .sort()
        .join(''),
    )
    .digest('hex');
  const version = parseGlslangVersion(await readFile(join(staging, 'CHANGES.md'), 'utf8'));
  const marker: GlslangSource = {
    dir,
    commit: upstream.commit,
    version,
    treeDigest,
    selectionSha256: selectionDigest(upstream),
  };
  await writeFile(join(staging, '.materialized.json'), JSON.stringify(marker, null, 2));
  await rm(dir, { recursive: true, force: true });
  await rename(staging, dir);
  console.log(`[glsl-analysis] glslang ${version} materialised (${entries.length} files)`);
  return marker;
}

/**
 * third_party/glslang/LICENSE.txt is a verbatim copy of the pinned upstream
 * file. `--update-license` refreshes it after a pin change; builds call
 * `checkThirdPartyLicense` so the shipped notice can never drift.
 */
export async function checkThirdPartyLicense(source: GlslangSource, update = false): Promise<void> {
  const upstream = await readFile(join(source.dir, 'LICENSE.txt'));
  const committedPath = join(glslangThirdPartyDir, 'LICENSE.txt');
  const committed = (await fileExists(committedPath)) ? await readFile(committedPath) : null;
  if (committed?.equals(upstream)) return;
  if (!update) {
    throw new Error(
      `${committedPath} differs from glslang ${source.commit} LICENSE.txt; ` +
        'run `node tools/glsl-analysis/bootstrap.ts --update-license`.',
    );
  }
  await writeFile(committedPath, upstream);
  console.log(`[glsl-analysis] updated ${committedPath}`);
}

const DOWNLOAD_PLATFORM: Record<string, string> = { 'win32-x64': 'win', 'linux-x64': 'linux' };

function pythonString(value: string): string {
  return JSON.stringify(value.replaceAll('\\', '/'));
}

export async function ensureToolchain(): Promise<Toolchain> {
  const lock = (await readToolchainLock()).emscripten;
  const platform = `${process.platform}-${process.arch}`;
  const archive = lock.archives[platform];
  if (!archive) {
    throw new Error(
      `No pinned Emscripten ${lock.version} archive for ${platform}. ` +
        `Pinned platforms: ${Object.keys(lock.archives).join(', ')}.`,
    );
  }
  const python = await findPython();
  const root = join(toolchainsDir, `emscripten-${lock.version}-${platform}`);
  const markerPath = join(root, '.installed.json');
  const installed =
    (await fileExists(markerPath)) &&
    (await readJson<{ sha256: string }>(markerPath)).sha256 === archive.sha256;

  if (!installed) {
    const extension = archive.format === 'zip' ? 'zip' : 'tar.xz';
    const download = join(
      downloadsDir,
      `emscripten-${lock.releaseHash}-${DOWNLOAD_PLATFORM[platform] ?? platform}.${extension}`,
    );
    await ensurePinnedDownload(archive, download);
    const staging = `${root}.partial`;
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    console.log(`[glsl-analysis] extracting Emscripten ${lock.version}`);
    if (archive.format === 'zip') {
      await extractZip(download, staging);
    } else {
      await run('tar', ['-xJf', download, '-C', staging]);
    }
    await writeFile(
      join(staging, '.installed.json'),
      JSON.stringify({ version: lock.version, sha256: archive.sha256, url: archive.url }, null, 2),
    );
    await rm(root, { recursive: true, force: true });
    await rename(staging, root);
  }

  const install = join(root, 'install');
  const emscriptenDir = join(install, 'emscripten');
  // Release archives report e.g. `6.0.11-git` (sometimes quoted).
  const reported = (await readFile(join(emscriptenDir, 'emscripten-version.txt'), 'utf8'))
    .trim()
    .replaceAll('"', '');
  if (reported !== lock.version && reported !== `${lock.version}-git`) {
    throw new Error(`Emscripten reports ${reported}, expected pinned ${lock.version}`);
  }

  // The release archive ships prebuilt system libraries in its own cache
  // directory, which is used as-is so no libc/libc++ is rebuilt locally.
  const configPath = join(cacheDir, `emscripten-config-${lock.version}-${platform}.py`);
  await writeFile(
    configPath,
    [
      '# Generated by tools/glsl-analysis/bootstrap.ts; do not edit.',
      `LLVM_ROOT = ${pythonString(join(install, 'bin'))}`,
      `BINARYEN_ROOT = ${pythonString(install)}`,
      `NODE_JS = ${pythonString(process.execPath)}`,
      '',
    ].join('\n'),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    EM_CONFIG: configPath,
    EMSDK_PYTHON: python.command,
  };
  for (const name of ['EMSDK', 'EM_CACHE', 'EM_COMPILER_WRAPPER', 'EMCC_CFLAGS']) delete env[name];
  return {
    version: lock.version,
    releaseHash: lock.releaseHash,
    platform,
    archiveSha256: archive.sha256,
    emscriptenDir,
    configPath,
    python,
    env,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const source = await ensureGlslangSource();
  await checkThirdPartyLicense(source, process.argv.includes('--update-license'));
  const toolchain = await ensureToolchain();
  console.log(
    JSON.stringify(
      {
        glslang: source,
        emscripten: {
          version: toolchain.version,
          platform: toolchain.platform,
          dir: toolchain.emscriptenDir,
          python: toolchain.python.version,
        },
      },
      null,
      2,
    ),
  );
}
