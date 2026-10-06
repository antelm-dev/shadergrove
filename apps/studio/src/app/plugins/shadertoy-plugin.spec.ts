import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  APP_VERSION,
  isPluginCompatible,
  parsePluginPackage,
  type PluginPackage,
  type ProjectCandidate,
} from '@shadergrove/shared';
import {
  importShadertoyShader,
  type ShadertoyFetchResponse,
} from '@shadergrove/shared/shadertoy-api';
import type { SourceProvider } from './host-adapters';
import { PluginHost, type SandboxHandle } from './plugin-host';
import { resolveProjectCandidate } from './project-import';
import { inProcessStart } from './testing/in-process-sandbox';

/**
 * The Shadertoy package as the catalogue ships it — the generated
 * `.sgplugin.json` — run through the real `PluginHost` with an in-process
 * stand-in for the Worker, then resolved by the host exactly as the Plugins
 * page does. The built-in importer (kept for the HTTP/IPC endpoint) is the
 * parity reference.
 */
const root = resolve(import.meta.dirname, '../../../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const parsed = parsePluginPackage(
  read('apps/studio/src/plugins/dev.shadergrove.shadertoy-1.0.1.sgplugin.json'),
);
if (!parsed.ok) throw new Error(parsed.errors.join('; '));
const plugin: PluginPackage = parsed.value;
const fixture = JSON.parse(read('plugins/official/shadertoy/fixtures/multipass.json')) as unknown;

/** A 4x2 PNG header — all `decodeImage` reads. */
function png(): Uint8Array {
  const bytes = new Uint8Array(29);
  bytes.set([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
  new DataView(bytes.buffer).setUint32(16, 4);
  new DataView(bytes.buffer).setUint32(20, 2);
  return bytes;
}

const assets: Record<string, Uint8Array> = { '/media/a/noise.png': png() };

function recordingHost(): { host: PluginHost; sent: unknown[] } {
  const sent: unknown[] = [];
  const start = inProcessStart(plugin.code!);
  return {
    sent,
    host: new PluginHost(plugin, {
      start: async () => {
        const inner = await start();
        const handle: SandboxHandle = {
          call: (method, params, options) => {
            sent.push(structuredClone(params));
            return inner.call(method, params, options);
          },
          terminate: (reason) => inner.terminate(reason),
        };
        return handle;
      },
    }),
  };
}

const provider: SourceProvider = {
  id: 'shadertoy-api/v1',
  fields: [],
  fetchSource: async () => ({ sourceId: 'ParFix', source: fixture }),
  fetchAsset: async (asset) => {
    const bytes = assets[asset];
    if (!bytes) throw new Error('request failed (404)');
    return bytes;
  },
};

/** Pass ids are generated; compare structure with ids replaced by their pass names. */
function shape(passes: ProjectCandidate['project']['passes']) {
  const names = new Map(passes.map((pass) => [pass.id, pass.name]));
  return passes.map((pass) => ({
    ...pass,
    id: pass.name,
    channels: pass.channels.map((binding) =>
      binding.kind === 'buffer' ? { ...binding, passId: names.get(binding.passId) } : binding,
    ),
  }));
}

describe('the Shadertoy plugin package', () => {
  it('is a protocol-2 project importer for this app, using the shadertoy-api/v1 provider', () => {
    expect(isPluginCompatible(plugin.manifest, APP_VERSION)).toBe(true);
    expect(plugin.manifest.contributions).toEqual([
      expect.objectContaining({
        kind: 'projectImporter',
        id: 'shadertoy',
        modes: ['provider', 'paste'],
        provider: 'shadertoy-api/v1',
      }),
    ]);
  });

  it('converts a provider document in the Worker with no credential in any request', async () => {
    const { host, sent } = recordingHost();
    const source = await provider.fetchSource(
      { idOrUrl: 'ParFix', apiKey: 'secret' },
      new AbortController().signal,
    );
    const candidate = await host.importProject('shadertoy', {
      mode: 'provider',
      provider: 'shadertoy-api/v1',
      ...source,
    });
    expect(JSON.stringify(sent)).not.toContain('secret');
    expect(candidate.credits).toEqual({
      author: 'fixture-author',
      sourceUrl: 'https://www.shadertoy.com/view/ParFix',
    });
    expect(candidate.textures.map((request) => request.asset)).toEqual([
      '/media/a/noise.png',
      '/media/a/rock.jpg',
    ]);
  });

  it('matches the built-in importer: passes, feedback, textures, samplers and warnings', async () => {
    const { host } = recordingHost();
    const candidate = await host.importProject('shadertoy', {
      mode: 'provider',
      provider: 'shadertoy-api/v1',
      sourceId: 'ParFix',
      source: fixture,
    });
    const resolved = await resolveProjectCandidate(candidate, provider, {
      idSuffix: 'ParFix',
      signal: new AbortController().signal,
    });

    const legacy = await importShadertoyShader('ParFix', 'key', {
      fetch: async (url): Promise<ShadertoyFetchResponse> => {
        const path = new URL(url).pathname;
        const body = path.startsWith('/api/')
          ? new TextEncoder().encode(JSON.stringify(fixture))
          : assets[path];
        return {
          ok: !!body,
          status: body ? 200 : 404,
          json: async () => fixture,
          arrayBuffer: async () => (body ?? new Uint8Array()).slice().buffer as ArrayBuffer,
        };
      },
    });

    const shader = resolved.bundle.shader;
    expect(shader.id).toBe(legacy.payload.id);
    expect(shader.name).toBe(legacy.payload.name);
    expect(shader.author).toBe('fixture-author');
    expect(shape(shader.project.passes)).toEqual(shape(legacy.payload.project.passes));
    expect(shader.channels).toEqual(legacy.payload.channels);
    expect(resolved.warnings).toEqual(legacy.warnings);

    const image = shader.project.passes.find((pass) => pass.kind === 'image')!;
    const bufferA = shader.project.passes.find((pass) => pass.name === 'Buffer A')!;
    expect(bufferA.channels[0]).toEqual({ kind: 'buffer', passId: bufferA.id, feedback: true });
    expect(bufferA.channels[1]).toEqual({ kind: 'texture', slot: 0 });
    expect(image.channels[2]).toEqual({ kind: 'texture', slot: 0 });
    expect(image.channels[1]).toEqual({ kind: 'none' });
    expect(shader.channels[0]).toMatchObject({
      ext: 'png',
      wrap: 'clamp',
      filter: 'nearest',
      flipY: false,
    });
    expect(resolved.warnings.some((w) => w.includes('sound pass "Sound"'))).toBe(true);
    expect(resolved.warnings.some((w) => w.includes('"keyboard" inputs'))).toBe(true);
    expect(
      resolved.warnings.some((w) => w.includes('Failed to download a texture for "Image"')),
    ).toBe(true);
  });

  it('imports a pasted Image pass, and refuses source without mainImage', async () => {
    const { host } = recordingHost();
    const candidate = await host.importProject('shadertoy', {
      mode: 'paste',
      name: 'Pasted',
      text: 'void mainImage(out vec4 c, in vec2 p) { c = vec4(p, 0.0, 1.0); }',
    });
    expect(candidate.name).toBe('Pasted');
    const image = candidate.project.passes.find((pass) => pass.kind === 'image')!;
    expect(image.source).toContain('mainImage(shadertoyColor, gl_FragCoord.xy)');
    await expect(
      host.importProject('shadertoy', { mode: 'paste', name: 'Bad', text: 'void main() {}' }),
    ).rejects.toThrow(/mainImage/);
  });

  it('leaves nothing half-imported when the provider refuses a texture path', async () => {
    const { host } = recordingHost();
    const candidate = await host.importProject('shadertoy', {
      mode: 'provider',
      provider: 'shadertoy-api/v1',
      sourceId: 'ParFix',
      source: fixture,
    });
    const controller = new AbortController();
    const pending = resolveProjectCandidate(
      candidate,
      {
        ...provider,
        fetchAsset: async () => {
          controller.abort(new Error('cancelled'));
          throw new Error('aborted');
        },
      },
      { signal: controller.signal },
    );
    await expect(pending).rejects.toThrow(/cancelled/);
  });
});
