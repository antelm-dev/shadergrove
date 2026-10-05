import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { WebSocket } from 'ws';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  HandshakeAckSchema,
  MCP_BRIDGE_PROTOCOL_VERSION,
  type Handshake,
} from '@shadergrove/shared/mcp-protocol';

/**
 * Exercises the *built* `dist/server.mjs` as an end user would run it — a
 * real child process talking stdio, not `buildServer()` wired to an
 * in-memory transport (that's what `server.spec.ts` covers). Requires
 * `pnpm build:mcp` to have run first; `test:mcp` always does.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(here, '../../dist/server.mjs');

const TEST_TOKEN = 'stdio-integration-test-token-value';

let nextPort = 43217; // isolated, well away from the app's default (4310)
let currentChild: ChildProcess | null = null;

function testEnv(port: number, overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SHADER_STUDIO_MCP_PORT: String(port),
    SHADER_STUDIO_MCP_TOKEN: TEST_TOKEN,
    SHADER_STUDIO_MCP_HOST: '127.0.0.1',
    SHADER_STUDIO_MCP_LOG_LEVEL: 'info',
    ...overrides,
  };
}

function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timed out waiting for: ${label}`));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out waiting for process exit')),
      timeoutMs,
    );
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

beforeAll(() => {
  if (!existsSync(distPath)) {
    throw new Error(
      `Expected a built server at ${distPath}. Run \`pnpm build:mcp\` before running these tests.`,
    );
  }
});

afterEach(() => {
  if (currentChild && currentChild.exitCode === null && currentChild.signalCode === null) {
    currentChild.kill('SIGKILL');
  }
  currentChild = null;
});

describe('built server.mjs', () => {
  it('is a standalone executable with the required shebang', () => {
    const contents = readFileSync(distPath, 'utf8');
    expect(contents.startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('bundles its dependencies — no bare imports of ws/zod/the MCP SDK remain', () => {
    const contents = readFileSync(distPath, 'utf8');
    // Anchored to the start of a line: the bundled SDK's own source contains
    // doc-comment *text* mentioning these package names, which isn't a real
    // ES module import and shouldn't fail this check.
    expect(contents).not.toMatch(/^import .*from ['"]ws['"]/m);
    expect(contents).not.toMatch(/^import .*from ['"]zod['"]/m);
    expect(contents).not.toMatch(/^import .*from ['"]@modelcontextprotocol\/sdk/m);
    expect(contents).not.toMatch(/^import .*from ['"]@shadergrove\/shared/m);
  });

  it('writes only JSON-RPC frames to stdout, and startup logs only to stderr', async () => {
    const port = nextPort++;
    const child = spawn(process.execPath, [distPath], {
      env: testEnv(port),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    currentChild = child;

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString('utf8')));

    await waitFor(() => stderrChunks.join('').includes('listening'), 5000, 'bridge listening log');

    // The auto-generated token must never be printed — only the ok/pairing
    // instructions when the server itself generated one. Here we configured
    // one explicitly, so its value must not appear anywhere in stderr.
    expect(stderrChunks.join('')).not.toContain(TEST_TOKEN);

    const initializeRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'stdio-purity-test', version: '1.0.0' },
      },
    };
    child.stdin?.write(`${JSON.stringify(initializeRequest)}\n`);

    await waitFor(() => stdoutChunks.join('').includes('"id":1'), 5000, 'initialize response');

    const stdoutText = stdoutChunks.join('');
    const lines = stdoutText.split('\n').filter((line) => line.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const parsed: unknown = JSON.parse(line); // throws (fails the test) on anything but pure JSON
      expect(parsed).toMatchObject({ jsonrpc: '2.0' });
    }

    const stderrText = stderrChunks.join('');
    expect(stderrText).toContain('[shader-studio-mcp]');
    expect(stderrText).not.toContain('"jsonrpc"');

    child.stdin?.end();
    const code = await waitForExit(child, 5000);
    expect(code).toBe(0);
  });

  it('shuts down cleanly when stdin closes', async () => {
    const port = nextPort++;
    const child = spawn(process.execPath, [distPath], {
      env: testEnv(port),
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    currentChild = child;

    const stderrChunks: string[] = [];
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString('utf8')));
    await waitFor(() => stderrChunks.join('').includes('listening'), 5000, 'bridge listening log');

    child.stdin?.end();
    const code = await waitForExit(child, 5000);
    expect(code).toBe(0);
  });

  // On Windows, `ChildProcess.kill('SIGINT' | 'SIGTERM')` unconditionally
  // terminates the process rather than delivering a catchable signal (Node
  // only emulates real signal delivery for Ctrl+C from an actual console, not
  // for programmatic `kill()`), so `process.on('SIGINT'/'SIGTERM', ...)`
  // never runs and there's nothing meaningful to assert here. The handlers
  // themselves are plain `process.on(...)` calls with no platform-specific
  // code, so this only needs POSIX coverage.
  it.skipIf(process.platform === 'win32').each(['SIGINT', 'SIGTERM'] as const)(
    'shuts down cleanly on %s',
    async (signal) => {
      const port = nextPort++;
      const child = spawn(process.execPath, [distPath], {
        env: testEnv(port),
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      currentChild = child;

      const stderrChunks: string[] = [];
      child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString('utf8')));
      await waitFor(
        () => stderrChunks.join('').includes('MCP server ready'),
        5000,
        'server ready after shutdown handlers are installed',
      );

      child.kill(signal);
      const code = await waitForExit(child, 5000);
      expect(code).toBe(0);
    },
  );

  it('exits non-zero with a stderr message when the port is invalid', async () => {
    const port = nextPort++;
    const child = spawn(process.execPath, [distPath], {
      env: testEnv(port, { SHADER_STUDIO_MCP_PORT: '999999' }),
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    currentChild = child;

    const stderrChunks: string[] = [];
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString('utf8')));

    const code = await waitForExit(child, 5000);
    expect(code).not.toBe(0);
    expect(stderrChunks.join('')).toContain('Invalid configuration');
  });

  it('completes a full tool call round-trip through the WebSocket bridge', async () => {
    const port = nextPort++;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distPath],
      env: testEnv(port) as Record<string, string>,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-roundtrip-test', version: '1.0.0' });

    try {
      await client.connect(transport);

      // Wait for the bridge to actually be listening before the fake "app" dials in.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for bridge')), 5000);
        transport.stderr?.on('data', (chunk: Buffer) => {
          if (chunk.toString('utf8').includes('listening')) {
            clearTimeout(timer);
            resolve();
          }
        });
      });

      const app = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((resolve, reject) => {
        app.once('open', () => {
          const handshake: Handshake = {
            kind: 'hello',
            role: 'app',
            protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
            appVersion: '1.0.0',
            sessionId: crypto.randomUUID(),
            token: TEST_TOKEN,
            capabilities: [],
          };
          app.send(JSON.stringify(handshake));
        });
        app.once('message', (raw) => {
          const ack = HandshakeAckSchema.safeParse(JSON.parse(String(raw)));
          if (ack.success) resolve();
          else reject(new Error('Fake app handshake was rejected'));
        });
        app.once('error', reject);
      });

      app.on('message', (raw) => {
        const request = JSON.parse(String(raw)) as { id: string; type: string };
        if (request.type !== 'getState') {
          app.send(
            JSON.stringify({
              id: request.id,
              ok: false,
              error: { code: 'INTERNAL', message: `Unhandled ${request.type}` },
            }),
          );
          return;
        }
        app.send(
          JSON.stringify({
            id: request.id,
            ok: true,
            result: {
              selectedId: 'roundtrip-demo',
              shaders: [],
              record: null,
              draft: null,
              controls: [],
              params: {},
              presets: [],
              activePresetId: null,
              dirty: false,
              hasErrors: false,
              diagnostics: [],
            },
          }),
        );
      });

      const result = await client.callTool({ name: 'get_state', arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ selectedId: 'roundtrip-demo' });

      app.close();
    } finally {
      await client.close();
    }
  });
});
