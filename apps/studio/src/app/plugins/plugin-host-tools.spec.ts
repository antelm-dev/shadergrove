import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PALETTE_FORMAT,
  PLUGIN_LIMITS,
  TOOL_LIMITS,
  sourceFingerprint,
  validatePluginPackage,
  type AnalyzerRequest,
  type PluginPackage,
} from '@shadergrove/shared/plugin';
import { DEFAULT_RENDER } from '@shadergrove/shared/model';
import { migrateLegacyProject } from '@shadergrove/shared/project';

import { PluginCallError, PluginHost } from './plugin-host';
import {
  gate,
  newRecord,
  recordingStart,
  resetGate,
  toolsPackageText,
  type SandboxRecord,
} from './testing/tool-fixtures';

/**
 * Protocol-4 calls through the real `PluginHost`: what crosses into the
 * Worker, what is believed on the way back, and how a call ends. The Worker
 * code is the fixture package's, run in-process; the sandbox around it is a
 * stand-in that keeps the real wire (`encodeLikePrelude` → `decodeResult`),
 * the real per-call limits, termination on timeout and on cancellation, and
 * a record of every request.
 */
const parsed = validatePluginPackage(JSON.parse(toolsPackageText()));
if (!parsed.ok) throw new Error(parsed.errors.join());
const plugin: PluginPackage = parsed.value;

function toolHost(options: { timeoutMs?: number } = {}): {
  host: PluginHost;
  sent: SandboxRecord['sent'];
  terminated: SandboxRecord['terminated'];
  started: () => number;
} {
  const record = newRecord();
  const host = new PluginHost(plugin, { ...options, start: recordingStart(plugin, record) });
  return {
    host,
    sent: record.sent,
    terminated: record.terminated,
    started: () => record.starts,
  };
}

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: unknown) => (error instanceof PluginCallError ? error.code : String(error)),
  );

const channels = Array.from({ length: 4 }, () => ({
  state: 'empty' as const,
  present: false,
  ext: null,
  width: 0,
  height: 0,
  wrap: 'clamp' as const,
  filter: 'linear' as const,
  flipY: false,
}));
function snapshot(name = 'Seascape'): AnalyzerRequest {
  const request = {
    name,
    project: migrateLegacyProject('void main() {}', 'void main() {}'),
    controls: [],
    params: {},
    render: DEFAULT_RENDER,
    channels,
    postProcessingActive: false,
  };
  return { ...request, profileId: 'studio-webgl2/v1', revision: sourceFingerprint(request) };
}

function plane(width: number, height: number, usage: 'color' | 'data' = 'data') {
  const bytes = new Uint8Array(width * height * 4);
  bytes.forEach((_, index) => (bytes[index] = (index * 7) % 256));
  return {
    width,
    height,
    orientation: 'top-left' as const,
    alpha: 'straight' as const,
    usage,
    rgba: bytes.buffer,
  };
}

afterEach(resetGate);

describe('PluginHost.analyze', () => {
  it('sends the snapshot and the host-selected profile, and returns a validated report', async () => {
    const { host, sent, terminated } = toolHost();
    const request = snapshot();
    const report = await host.analyze('doctor', request);
    expect(report.profile).toBe('studio-webgl2/v1');
    expect(report.targetVersion).toBe(1);
    expect(report.revision).toBe(request.revision);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.location).toEqual({
      kind: 'binding',
      passId: request.project.passes[0]!.id,
      channel: 0,
    });
    const [call] = sent;
    expect(call!.method).toBe('analyzer:doctor');
    expect(call!.transfer).toEqual([]);
    expect(call!.timeoutMs).toBe(PLUGIN_LIMITS.callTimeoutMs);
    expect(call!.maxResultBytes).toBe(TOOL_LIMITS.analyzerOutputBytes);
    expect((call!.params as { profile: { id: string } }).profile.id).toBe('studio-webgl2/v1');
    expect(JSON.stringify(call!.params)).not.toContain('apiKey');
    expect(terminated).toEqual(['Call finished']);
  });

  it('judges the reply against the snapshot it sent', async () => {
    const run = (name: string) => code(toolHost().host.analyze('doctor', snapshot(name)));
    expect(await run('bad-line')).toBe('output-invalid');
    expect(await run('other-revision')).toBe('output-invalid');
    expect(await run('Seascape')).toBe('resolved');
  });

  it('refuses before starting a Worker: unknown contribution, unregistered or undeclared profile', async () => {
    const { host, started } = toolHost();
    expect(await code(host.analyze('pack', snapshot()))).toBe('unknown-contribution');
    expect(await code(host.analyze('missing', snapshot()))).toBe('unknown-contribution');
    expect(await code(host.analyze('doctor', { ...snapshot(), profileId: 'webgpu/v1' }))).toBe(
      'input-invalid',
    );
    const huge = snapshot();
    huge.project.vertex = 'x'.repeat(TOOL_LIMITS.analyzerInputBytes);
    expect(await code(host.analyze('doctor', huge))).toBe('input-too-large');
    expect(started()).toBe(0);
  });

  it('terminates the Worker on timeout and on cancellation, and surfaces a plugin failure', async () => {
    const timed = toolHost({ timeoutMs: 40 });
    expect(await code(timed.host.analyze('doctor', snapshot('hang')))).toMatch(/did not answer/);
    expect(timed.terminated).toEqual(['Call finished']);

    const controller = new AbortController();
    const cancelled = toolHost();
    const pending = code(
      cancelled.host.analyze('doctor', snapshot('hang'), { signal: controller.signal }),
    );
    await vi.waitFor(() => expect(cancelled.sent).toHaveLength(1));
    controller.abort();
    expect(await pending).toBe('cancelled');
    expect(cancelled.terminated.length).toBeGreaterThan(0);

    expect(await code(toolHost().host.analyze('doctor', snapshot('boom')))).toBe(
      'Error: rule crashed',
    );
    // An already-aborted signal never starts a Worker.
    const aborted = toolHost();
    expect(
      await code(aborted.host.analyze('doctor', snapshot(), { signal: AbortSignal.abort() })),
    ).toBe('cancelled');
    expect(aborted.started()).toBe(0);
  });
});

describe('PluginHost.runAssetTool', () => {
  const request = (overrides: Record<string, unknown> = {}) => ({
    operation: 'pack',
    settings: {},
    planes: [plane(4, 2)],
    ...overrides,
  });

  it('transfers copies, leaving the caller buffers attached, and returns the unapplied image', async () => {
    const { host, sent } = toolHost();
    const input = plane(4, 2);
    const before = new Uint8Array(input.rgba).slice();
    const output = await host.runAssetTool('pack', request({ planes: [input] }));
    expect(output.kind).toBe('image');
    if (output.kind !== 'image') return;
    expect(output.images[0]!.rgba.byteLength).toBe(32);
    expect(new Uint8Array(output.images[0]!.rgba)[0]).toBe(255 - before[0]!);
    expect(output.metadata).toEqual({ seen: [32], preview: false });
    // The call carried a transfer list, none of which is the caller's buffer.
    const call = sent[0]!;
    expect(call.method).toBe('assetTool:pack');
    expect(call.transfer).toHaveLength(1);
    expect(call.transfer[0]).not.toBe(input.rgba);
    expect(call.maxResultBytes).toBe(TOOL_LIMITS.outputBytes);
    expect(input.rgba.byteLength).toBe(32);
    expect(new Uint8Array(input.rgba)).toEqual(before);
  });

  it('counts a view by its window and sends only that window', async () => {
    const { host, sent } = toolHost();
    const backing = new Uint8Array(4096).map((_, index) => index % 256);
    const view = new Uint8ClampedArray(backing.buffer, 64, 4 * 2 * 4);
    await host.runAssetTool('pack', request({ planes: [{ ...plane(4, 2), rgba: view }] }));
    const params = sent[0]!.params as { planes: { rgba: ArrayBuffer }[] };
    expect(params.planes[0]!.rgba.byteLength).toBe(32);
    expect(new Uint8Array(params.planes[0]!.rgba)).toEqual(backing.slice(64, 96));
    expect(
      await code(
        host.runAssetTool('pack', request({ planes: [{ ...plane(4, 2), rgba: backing }] })),
      ),
    ).toBe('input-invalid');
  });

  it('refuses before starting a Worker: bounds, undeclared inputs, hostile settings', async () => {
    const { host, started } = toolHost();
    const five = Array.from({ length: 5 }, () => plane(1, 1));
    expect(await code(host.runAssetTool('pack', request({ planes: five })))).toBe(
      'input-too-large',
    );
    expect(
      await code(host.runAssetTool('pack', request({ planes: [plane(257, 1)], preview: true }))),
    ).toBe('input-too-large');
    expect(
      await code(
        host.runAssetTool(
          'pack',
          request({ palette: { format: PALETTE_FORMAT, name: 'p', colors: ['#000000'] } }),
        ),
      ),
    ).toBe('input-invalid');
    expect(
      await code(host.runAssetTool('pack', request({ settings: { buffer: new ArrayBuffer(8) } }))),
    ).toBe('input-invalid');
    expect(await code(host.runAssetTool('pack', request({ operation: 'Pack Now' })))).toBe(
      'input-invalid',
    );
    expect(await code(host.runAssetTool('doctor', request()))).toBe('unknown-contribution');
    expect(started()).toBe(0);
  });

  it('refuses replies that are views, an undeclared kind or over the limit', async () => {
    const run = (mode: string) =>
      code(toolHost().host.runAssetTool('pack', request({ settings: { mode } })));
    expect(await run('view')).toBe('output-invalid');
    expect(await run('palette')).toBe('output-invalid');
    expect(await run('invert')).toBe('resolved');
  });

  it('passes a preview flag through and bounds previews to 256×256', async () => {
    const { host, sent } = toolHost();
    const output = await host.runAssetTool(
      'pack',
      request({ planes: [plane(256, 256)], preview: true }),
    );
    expect(output.metadata).toEqual({ seen: [256 * 256 * 4], preview: true });
    expect((sent[0]!.params as { preview: boolean }).preview).toBe(true);
  });

  it('terminates on timeout and on cancellation without a result', async () => {
    const timed = toolHost({ timeoutMs: 40 });
    expect(
      await code(timed.host.runAssetTool('pack', request({ settings: { mode: 'hang' } }))),
    ).toMatch(/did not answer/);
    expect(timed.terminated).toEqual(['Call finished']);

    const controller = new AbortController();
    const cancelled = toolHost();
    const pending = code(
      cancelled.host.runAssetTool('pack', request({ settings: { mode: 'hang' } }), {
        signal: controller.signal,
      }),
    );
    await vi.waitFor(() => expect(cancelled.sent).toHaveLength(1));
    controller.abort();
    expect(await pending).toBe('cancelled');
  });

  it('runs analyzer and asset-tool calls one at a time through the one queue', async () => {
    const { host, sent } = toolHost();
    const hold = gate();
    const slow = host.runAssetTool('pack', request({ settings: { mode: 'slow' } }));
    const analysis = host.analyze('doctor', snapshot());
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    // The analysis has not started: one Worker at a time.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toHaveLength(1);
    hold.release();
    await Promise.all([slow, analysis]);
    expect(sent.map((call) => call.method)).toEqual(['assetTool:pack', 'analyzer:doctor']);
  });
});
