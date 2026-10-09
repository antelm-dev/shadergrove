import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { DEFAULT_RENDER } from '@shadergrove/shared/model';
import { DEFAULT_VERTEX, makePass } from '@shadergrove/shared/project';
import { fail, ok } from '@shadergrove/shared/validate';

import type { PluginPackage } from '@shadergrove/shared/plugin';

import type { PluginHostOptions, SandboxHandle } from '../plugin-host';
import { decodeResult } from '../plugin-sandbox';
import type { AnalyzerToolAdapter, AssetToolAdapter, ToolSession } from '../plugin-tools';
import { encodeLikePrelude } from './in-process-sandbox';

/**
 * Fixtures that exercise the whole protocol-4 seam without a real tool: a
 * package declaring an analyzer, two asset tools and a template, the Worker code
 * behind them (run in-process, like the other host specs), and stand-in host
 * adapters and panels. No official package is involved; these are what the
 * three vertical slices copy from.
 *
 * The Worker code reads `globalThis.__toolGate` — a promise a spec can leave
 * pending to hold a call in flight, then resolve to let it answer.
 */
export const TOOLS_PACKAGE_ID = 'dev.example.tools';

declare global {
  // oxlint-disable-next-line no-var
  var __toolGate: Promise<void> | undefined;
}

/** Holds every `slow` tool call until `release()`; `resetGate()` when done. */
export function gate(): { release: () => void } {
  let release!: () => void;
  globalThis.__toolGate = new Promise<void>((resolve) => (release = resolve));
  return { release };
}
export function resetGate(): void {
  globalThis.__toolGate = undefined;
}

export const TOOL_WORKER_CODE = `
// A slot whose load is not a verdict (anything but empty or loaded) is unchecked, never a pass.
const unchecked = (input) => input.channels.flatMap((channel, slot) =>
  channel.state === 'empty' || channel.state === 'loaded' ? [] : [{
    ruleId: 'resources.texture',
    severity: 'info',
    message: 'texture ' + slot + ' is ' + channel.state + ': not checked',
    confidence: 'possible',
    coverage: 'unchecked',
    targetVersion: input.profile.version,
  }]);
const report = (input, findings) => ({
  profile: input.profile.id,
  targetVersion: input.profile.version,
  revision: input.revision,
  checkedRules: ['limits.passes'],
  uncheckedRules: ['glsl.semantics'],
  findings: [...findings, ...unchecked(input)],
});
shaderStudio.handle('analyzer:doctor', async (input) => {
  if (input.name === 'slow') await globalThis.__toolGate;
  if (input.name === 'hang') return new Promise(() => {});
  if (input.name === 'boom') throw new Error('rule crashed');
  if (input.name === 'other-revision') {
    return { ...report(input, []), revision: 'fp1:0000000000000000' };
  }
  const where = input.name === 'bad-line'
    ? { kind: 'pass', id: input.project.passes[0].id, line: 9999 }
    : { kind: 'binding', passId: input.project.passes[0].id, channel: 0 };
  return report(input, [{
    ruleId: 'limits.passes',
    severity: input.project.passes.length > input.profile.limits.passes ? 'error' : 'info',
    message: 'passes: ' + input.project.passes.length + ' on ' + input.profile.id,
    confidence: 'certain',
    coverage: 'structural',
    targetVersion: input.profile.version,
    location: where,
  }]);
});
shaderStudio.handle('assetTool:pack', async (input) => {
  const mode = input.settings.mode;
  if (mode === 'slow') await globalThis.__toolGate;
  if (mode === 'hang') return new Promise(() => {});
  const source = new Uint8Array(input.planes[0].rgba);
  const image = (rgba) => ({
    name: 'packed', width: input.planes[0].width, height: input.planes[0].height,
    orientation: input.planes[0].orientation, alpha: input.planes[0].alpha, usage: input.planes[0].usage,
    rgba,
  });
  if (mode === 'view') return { kind: 'image', images: [image(source)], metadata: {} };
  if (mode === 'palette') return { kind: 'palette', palette: {} };
  // Invert the red channel so a test can tell the result from its input.
  const out = source.slice();
  for (let i = 0; i < out.length; i += 4) out[i] = 255 - out[i];
  return {
    kind: 'image',
    images: [image(out.buffer)],
    metadata: { seen: input.planes.map((p) => p.rgba.byteLength), preview: input.preview },
  };
});
shaderStudio.handle('assetTool:palette', () => ({
  kind: 'palette',
  palette: { format: 'shadergrove-palette/v1', name: 'Extracted', colors: ['#112233'] },
}));
`;

/** One feedback buffer sampling itself and the image sampling it: the shape recipes use. */
export function feedbackTemplate() {
  return {
    project: {
      version: 1,
      vertex: DEFAULT_VERTEX,
      passes: [
        makePass({ id: 'common', kind: 'common', name: 'Common', source: '' }),
        makePass({
          id: 'trail',
          kind: 'buffer',
          name: 'Trails',
          slot: 'A',
          source: 'void main() {}',
          channels: [
            { kind: 'buffer', passId: 'trail', feedback: true },
            { kind: 'none' },
            { kind: 'none' },
            { kind: 'none' },
          ],
        }),
        makePass({
          id: 'main',
          kind: 'image',
          name: 'Image',
          source: 'void main() {}',
          channels: [
            { kind: 'buffer', passId: 'trail', feedback: false },
            { kind: 'none' },
            { kind: 'none' },
            { kind: 'none' },
          ],
        }),
      ],
      files: [],
    },
    controls: [{ key: 'fade', type: 'number', label: 'Fade', default: 0.9, min: 0, max: 1 }],
    render: DEFAULT_RENDER,
    presets: [],
  };
}

export function toolsPackageText(
  options: { version?: string; id?: string; analyzerProfiles?: string[] } = {},
): string {
  return JSON.stringify({
    manifest: {
      id: options.id ?? TOOLS_PACKAGE_ID,
      version: options.version ?? '1.0.0',
      protocolVersion: 4,
      appVersionRange: '>=2.0.0 <3.0.0',
      name: 'Example tools',
      publisher: 'Example',
      license: 'MIT',
      contributions: [
        {
          kind: 'analyzer',
          id: 'doctor',
          name: 'Doctor',
          profiles: options.analyzerProfiles ?? ['studio-webgl2/v1', 'wallpaper-web/v1'],
        },
        {
          kind: 'assetTool',
          id: 'pack',
          name: 'Pack',
          workflow: 'texture-utilities/v1',
          inputs: ['image'],
          outputs: ['image'],
        },
        {
          kind: 'assetTool',
          id: 'palette',
          name: 'Palette',
          workflow: 'palette-studio/v1',
          inputs: ['image'],
          outputs: ['palette'],
        },
        {
          kind: 'projectTemplate',
          id: 'trails',
          name: 'Trails',
          description: 'A feedback buffer smearing its own last frame.',
          difficulty: 'intermediate',
          notes: ['Feedback reads the frame a buffer drew last tick.'],
          provenance: { author: 'Example', license: 'CC0-1.0' },
        },
      ],
    },
    code: TOOL_WORKER_CODE,
    templates: { trails: feedbackTemplate() },
  });
}

/** Stand-in panels: they only show that a session reached them. */
@Component({
  selector: 'app-test-analyzer-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<p data-testid="analyzer-panel">
    {{ session().packageId }}/{{ session().contributionId }}
  </p>`,
})
export class TestAnalyzerPanel {
  readonly session = input.required<ToolSession>();
}

@Component({
  selector: 'app-test-asset-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<p data-testid="asset-panel">{{ session().contributionId }}</p>`,
})
export class TestAssetPanel {
  readonly session = input.required<ToolSession>();
}

export const testAnalyzerAdapter: AnalyzerToolAdapter = {
  kind: 'analyzer',
  command: { label: 'plugins.title', icon: 'health_and_safety' },
  panel: TestAnalyzerPanel,
  needsProject: true,
};

/** Accepts `{ mode }` only: anything else is refused before it can reach a Worker. */
export const testTextureAdapter: AssetToolAdapter = {
  kind: 'assetTool',
  workflow: 'texture-utilities/v1',
  command: { label: 'plugins.title', icon: 'texture' },
  panel: TestAssetPanel,
  needsProject: false,
  validateSettings(operation, settings) {
    if (operation !== 'pack') return fail(`Unknown operation "${operation}"`);
    const record = settings as Record<string, unknown>;
    const extra = Object.keys(record).find((key) => key !== 'mode');
    if (extra) return fail(`settings.${extra} is not a known setting`);
    return ok({ mode: typeof record['mode'] === 'string' ? record['mode'] : 'invert' });
  },
};

export interface SandboxRecord {
  sent: {
    method: string;
    params: unknown;
    transfer: Transferable[];
    timeoutMs: number | undefined;
    maxResultBytes: number | undefined;
  }[];
  terminated: (string | undefined)[];
  starts: number;
}

export const newRecord = (): SandboxRecord => ({ sent: [], terminated: [], starts: 0 });

/**
 * A `PluginHost` start function that runs the package's code in-process behind
 * the real wire (`encodeLikePrelude` → `decodeResult` under the call's own
 * limit) and the real sandbox's two endings: a call that is not answered in
 * time terminates the Worker and rejects, and `terminate` rejects whatever is
 * pending with its reason. Every request is recorded.
 */
export function recordingStart(
  plugin: PluginPackage,
  record: SandboxRecord,
): NonNullable<PluginHostOptions['start']> {
  return async () => {
    record.starts++;
    const handlers = new Map<string, (params: unknown) => unknown>();
    new Function('shaderStudio', plugin.code!)({
      handle: (method: string, fn: (params: unknown) => unknown) => handlers.set(method, fn),
      notify: () => undefined,
    });
    let stop: (error: Error) => void = () => undefined;
    const stopped = new Promise<never>((_, reject) => (stop = reject));
    stopped.catch(() => undefined);
    const handle: SandboxHandle = {
      async call(method, params, options) {
        record.sent.push({
          method,
          params: structuredClone(params),
          transfer: options?.transfer ?? [],
          timeoutMs: options?.timeoutMs,
          maxResultBytes: options?.maxResultBytes,
        });
        const timer = setTimeout(
          () => stop(new Error(`Plugin did not answer ${method} in time`)),
          options?.timeoutMs,
        );
        const copy = structuredClone(params, { transfer: options?.transfer ?? [] });
        const value = Promise.resolve().then(() => handlers.get(method)!(copy));
        try {
          const result = await Promise.race([value, stopped]);
          return decodeResult(encodeLikePrelude(result), options?.maxResultBytes ?? Infinity);
        } finally {
          clearTimeout(timer);
        }
      },
      async terminate(reason) {
        record.terminated.push(reason instanceof Error ? reason.message : reason);
        stop(reason instanceof Error ? reason : new Error(reason));
      },
    };
    return handle;
  };
}
