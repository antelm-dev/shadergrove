import { spawn, type SpawnOptions } from 'node:child_process';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command without a shell; rejects on a non-zero exit unless `allowFailure`. */
export function run(
  command: string,
  args: readonly string[],
  options: SpawnOptions & { allowFailure?: boolean; input?: string | Buffer } = {},
): Promise<RunResult> {
  const { allowFailure = false, input, ...spawnOptions } = options;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...spawnOptions, shell: false });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const result = {
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (result.code !== 0 && !allowFailure) {
        reject(
          new Error(
            `${command} ${args.join(' ')} exited with ${result.code}\n${result.stderr}${result.stdout}`,
          ),
        );
      } else {
        resolvePromise(result);
      }
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

export interface PythonCommand {
  command: string;
  args: string[];
  version: string;
}

/**
 * emcc is a Python program. Prefer an explicit interpreter, then the usual
 * launchers; require Python 3.10+ so failures are reported before compiling.
 */
export async function findPython(): Promise<PythonCommand> {
  const explicit = process.env['GLSL_ANALYSIS_PYTHON'] ?? process.env['EMSDK_PYTHON'];
  const candidates: [string, string[]][] = explicit
    ? [[explicit, []]]
    : [
        ['python3', []],
        ['python', []],
        ['py', ['-3']],
      ];
  const tried: string[] = [];
  for (const [command, args] of candidates) {
    try {
      const { code, stdout, stderr } = await run(command, [...args, '--version'], {
        allowFailure: true,
      });
      const match = /Python (\d+)\.(\d+)\.(\d+)/.exec(stdout + stderr);
      if (code === 0 && match) {
        const [major, minor] = [Number(match[1]), Number(match[2])];
        if (major > 3 || (major === 3 && minor >= 10)) {
          return { command, args, version: match[0] };
        }
        tried.push(`${command}: ${match[0]} is older than 3.10`);
        continue;
      }
      tried.push(`${command}: exited ${code}`);
    } catch (error) {
      tried.push(`${command}: ${(error as Error).message}`);
    }
  }
  throw new Error(
    `Python 3.10+ is required to run Emscripten. Set GLSL_ANALYSIS_PYTHON.\n${tried.join('\n')}`,
  );
}

/** Runs `tasks` with at most `limit` in flight; the first failure rejects. */
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await task(item);
    }
  });
  await Promise.all(workers);
}
