import { describe, expect, it } from 'vitest';

import {
  TOOL_LIMITS,
  type AssetToolOutput,
  type AssetToolRequest,
} from '@shadergrove/shared/plugin';

import { PluginHost } from '../plugin-host';
import { inProcessStart } from '../testing/in-process-sandbox';
import {
  SelectionError,
  buildTextureRequest,
  edgeDifferences,
  textureSidecarDetails,
  validateTextureSettings,
  type TextureSelection,
} from './textures';
import { fixturePlane, rampPlane, solidPlane, textureUtilitiesPackage } from './textures-fixtures';
import { fromToolImage, type BridgeImage } from './textures-image-bridge';

/**
 * AC-TEXTURES for the workflow's own logic and the official package's Worker
 * code, run through the real `PluginHost` (in-process: jsdom has no Worker) —
 * the shipped bundle, the real input/output validators, exact bytes.
 */
const plugin = textureUtilitiesPackage();
const host = () => new PluginHost(plugin, { start: inProcessStart(plugin.code!) });

async function run(request: AssetToolRequest): Promise<BridgeImage & { name: string }> {
  const output: AssetToolOutput = await host().runAssetTool('texture-utilities', request);
  if (output.kind !== 'image') throw new Error('expected an image');
  expect(output.images).toHaveLength(1);
  return { ...fromToolImage(output.images[0]!), name: output.images[0]!.name };
}

const texels = (image: BridgeImage) =>
  Array.from({ length: image.width * image.height }, (_, index) => [
    ...image.rgba.subarray(index * 4, index * 4 + 4),
  ]);

const selection = (patch: Partial<TextureSelection> = {}): TextureSelection => ({
  operation: 'pack',
  images: [null, null, null, null],
  width: 2,
  height: 1,
  filter: 'nearest',
  usage: 'data',
  channels: [{ constant: 0 }, { constant: 0 }, { constant: 0 }, { constant: 255 }],
  normal: { channel: 'r', strength: 2, green: 'up', edges: 'clamp' },
  name: 'out',
  ...patch,
});

describe('texture utilities settings', () => {
  const pack = {
    width: 4,
    height: 4,
    usage: 'data',
    name: ' packed ',
    channels: [
      { plane: 0, channel: 'r' },
      { plane: 1, channel: 'a' },
      { constant: 0 },
      { constant: 255 },
    ],
  };
  const normal = { channel: 'g', strength: 2, green: 'down', edges: 'wrap', name: 'n' };

  it('accepts the two operations and returns fresh, trimmed copies', () => {
    const parsed = validateTextureSettings('pack', pack);
    expect(parsed).toEqual({ ok: true, value: { ...pack, name: 'packed' } });
    expect(parsed.ok && parsed.value['channels']).not.toBe(pack.channels);
    expect(validateTextureSettings('normal', normal)).toEqual({ ok: true, value: normal });
  });

  it.each([
    ['an unknown operation', 'blur', {}],
    ['an unknown setting', 'pack', { ...pack, gamma: 2.2 }],
    ['an oversize output', 'pack', { ...pack, width: 1025 }],
    ['a zero side', 'pack', { ...pack, height: 0 }],
    ['a fractional side', 'pack', { ...pack, height: 1.5 }],
    ['three channels', 'pack', { ...pack, channels: pack.channels.slice(0, 3) }],
    [
      'a constant above 255',
      'pack',
      { ...pack, channels: [{ constant: 256 }, ...pack.channels.slice(1)] },
    ],
    [
      'a fifth plane',
      'pack',
      { ...pack, channels: [{ plane: 4, channel: 'r' }, ...pack.channels.slice(1)] },
    ],
    [
      'a channel name',
      'pack',
      { ...pack, channels: [{ plane: 0, channel: 'x' }, ...pack.channels.slice(1)] },
    ],
    [
      'a source with both',
      'pack',
      { ...pack, channels: [{ plane: 0, channel: 'r', constant: 1 }, ...pack.channels.slice(1)] },
    ],
    ['a usage', 'pack', { ...pack, usage: 'linear' }],
    ['a control character in the name', 'pack', { ...pack, name: 'a\u0000b' }],
    ['no strength', 'normal', { ...normal, strength: 0 }],
    ['an infinite strength', 'normal', { ...normal, strength: Infinity }],
    ['a green direction', 'normal', { ...normal, green: 'left' }],
    ['an edge mode', 'normal', { ...normal, edges: 'mirror' }],
  ])('refuses %s', (_label, operation, settings) => {
    expect(validateTextureSettings(operation, settings).ok).toBe(false);
  });
});

describe('texture requests', () => {
  it('resamples mismatched inputs to the output size and sends only the slots channels read', () => {
    const small = solidPlane(1, 1, [9, 8, 7, 255]);
    const large = { ...rampPlane(4, 2), name: 'large.png', format: 'png' as const };
    const request = buildTextureRequest(
      selection({
        images: [null, large, null, small],
        width: 2,
        height: 2,
        channels: [
          { plane: 3, channel: 'r' },
          { plane: 1, channel: 'g' },
          { constant: 5 },
          { constant: 255 },
        ],
      }),
      false,
    );
    expect(request.planes!.map((plane) => [plane.width, plane.height])).toEqual([
      [2, 2],
      [2, 2],
    ]);
    // Slots 1 and 3 become planes 0 and 1, in slot order.
    expect((request.settings as { channels: unknown[] }).channels).toEqual([
      { plane: 1, channel: 'r' },
      { plane: 0, channel: 'g' },
      { constant: 5 },
      { constant: 255 },
    ]);
    // Planes carry only plane fields, whatever else a decoded image has (name, format).
    expect(Object.keys(request.planes![0]!).sort()).toEqual([
      'alpha',
      'height',
      'orientation',
      'rgba',
      'usage',
      'width',
    ]);
    // The picked images themselves are left as they were.
    expect([large.width, small.width]).toEqual([4, 1]);
  });

  it('fits a preview within the preview bound and keeps the output aspect', () => {
    const request = buildTextureRequest(
      selection({
        images: [rampPlane(8, 8), null, null, null],
        width: 1024,
        height: 512,
        channels: [{ plane: 0, channel: 'r' }, { constant: 0 }, { constant: 0 }, { constant: 255 }],
      }),
      true,
    );
    expect(request.preview).toBe(true);
    expect([request.planes![0]!.width, request.planes![0]!.height]).toEqual([
      TOOL_LIMITS.previewDimension,
      TOOL_LIMITS.previewDimension / 2,
    ]);
    expect(request.settings).toMatchObject({ width: 256, height: 128 });
  });

  it('names the missing image instead of sending a request', () => {
    expect(() =>
      buildTextureRequest(
        selection({
          channels: [{ plane: 2, channel: 'r' }, { constant: 0 }, { constant: 0 }, { constant: 0 }],
        }),
        false,
      ),
    ).toThrow(SelectionError);
    expect(() => buildTextureRequest(selection({ operation: 'normal' }), true)).toThrow(
      SelectionError,
    );
  });

  it('sends a height map as data, whatever the pack usage says', () => {
    const request = buildTextureRequest(
      selection({
        operation: 'normal',
        usage: 'color',
        images: [rampPlane(4, 4), null, null, null],
      }),
      false,
    );
    expect(request.planes![0]!.usage).toBe('data');
    expect(request.settings).toEqual({
      channel: 'r',
      strength: 2,
      green: 'up',
      edges: 'clamp',
      name: 'out',
    });
  });
});

describe('the Texture Utilities Worker', () => {
  const a = fixturePlane(2, 1, (x) => (x === 0 ? [10, 20, 30, 40] : [50, 60, 70, 80]));
  const b = fixturePlane(2, 1, (x) => (x === 0 ? [1, 2, 3, 4] : [5, 6, 7, 8]));
  const packSettings = (alpha: { plane: number; channel: 'g' } | { constant: number }) => ({
    width: 2,
    height: 1,
    usage: 'data',
    name: 'packed',
    channels: [{ plane: 1, channel: 'a' }, { plane: 0, channel: 'r' }, { constant: 7 }, alpha],
  });

  it('packs exact bytes and constants, and says alpha is stored, not implied', async () => {
    const out = await run({
      operation: 'pack',
      planes: [a, b],
      settings: packSettings({ plane: 1, channel: 'g' }),
    });
    expect(texels(out)).toEqual([
      [4, 10, 7, 2],
      [8, 50, 7, 6],
    ]);
    expect(out).toMatchObject({
      width: 2,
      height: 1,
      usage: 'data',
      alpha: 'straight',
      orientation: 'top-left',
      name: 'packed',
    });
  });

  it('declares opaque output only when alpha is the constant 255', async () => {
    const out = await run({
      operation: 'pack',
      planes: [a, b],
      settings: packSettings({ constant: 255 }),
    });
    expect(out.alpha).toBe('opaque');
    expect(texels(out).map((texel) => texel[3])).toEqual([255, 255]);
    const zero = await run({
      operation: 'pack',
      planes: [a, b],
      settings: packSettings({ constant: 0 }),
    });
    expect(zero.alpha).toBe('straight');
  });

  it('keeps the colour usage the host chose, and leaves the inputs attached and unchanged', async () => {
    const before = a.rgba.slice();
    const out = await run({
      operation: 'pack',
      planes: [a, b],
      settings: { ...packSettings({ constant: 255 }), usage: 'color' },
    });
    expect(out.usage).toBe('color');
    expect(a.rgba).toEqual(before);
  });

  it('refuses planes of different sizes: the host resamples, the Worker never guesses', async () => {
    await expect(
      run({
        operation: 'pack',
        planes: [a, solidPlane(1, 1, [0, 0, 0, 255])],
        settings: packSettings({ constant: 255 }),
      }),
    ).rejects.toThrow(/resample/);
  });

  it('refuses an operation it does not know', async () => {
    await expect(run({ operation: 'blur', planes: [a], settings: {} })).rejects.toThrow(
      /Unknown operation/,
    );
  });

  const normal = (plane: BridgeImage, patch: Record<string, unknown> = {}) =>
    run({
      operation: 'normal',
      planes: [plane],
      settings: {
        channel: 'r',
        strength: 2,
        green: 'up',
        edges: 'clamp',
        name: 'normal',
        ...patch,
      },
    });

  it('turns a flat height into (128, 128, 255) everywhere, opaque data', async () => {
    const out = await normal(solidPlane(3, 3, [100, 0, 0, 255]), { edges: 'wrap' });
    expect(new Set(texels(out).map(String))).toEqual(new Set(['128,128,255,255']));
    expect(out).toMatchObject({ usage: 'data', alpha: 'opaque' });
  });

  it('tilts away from a rise along +X, with clamped or wrapped edges', async () => {
    // Heights 0, 0, 1: a full step over two texels; strength 2 makes the slope exactly 1.
    const step = fixturePlane(3, 1, (x) => [x === 2 ? 255 : 0, 0, 0, 255]);
    const tilted = [37, 128, 218, 255];
    const flat = [128, 128, 255, 255];
    expect(texels(await normal(step))).toEqual([flat, tilted, tilted]);
    // Wrapped, texel 0 sees the rise behind it, texel 2 sees the same height on both sides.
    expect(texels(await normal(step, { edges: 'wrap' }))).toEqual([
      [218, 128, 218, 255],
      tilted,
      flat,
    ]);
  });

  it('follows the picture for +Y: green up (OpenGL), down (DirectX), and bottom-left rows', async () => {
    // A rise towards the top of the picture.
    const topDown = fixturePlane(1, 3, (_x, y) => [y === 0 ? 255 : 0, 0, 0, 255]);
    expect(texels(await normal(topDown))[1]).toEqual([128, 37, 218, 255]);
    expect(texels(await normal(topDown, { green: 'down' }))[1]).toEqual([128, 218, 218, 255]);
    // The same rows in GL order: row 0 is now the bottom of the picture, so the rise is at the bottom.
    const bottomUp = { ...topDown, orientation: 'bottom-left' as const };
    const flipped = await normal(bottomUp);
    expect(flipped.orientation).toBe('bottom-left');
    expect(texels(flipped)[1]).toEqual([128, 218, 218, 255]);
  });

  it('reads the height from the chosen channel and scales the tilt by strength', async () => {
    const ramp = rampPlane(5, 1);
    const fromAlpha = await normal(
      { ...ramp, rgba: ramp.rgba.map((value, index) => (index % 4 === 3 ? value : 0)) },
      { channel: 'a' },
    );
    // Alpha is 255 everywhere: flat.
    expect(texels(fromAlpha)[2]).toEqual([128, 128, 255, 255]);
    const gentle = texels(await normal(ramp, { strength: 1 }))[2]![0]!;
    const steep = texels(await normal(ramp, { strength: 8 }))[2]![0]!;
    expect(gentle).toBeLessThan(128);
    expect(steep).toBeLessThan(gentle);
  });

  it('runs full-size jobs at the input quota, and refuses one plane more', async () => {
    const side = TOOL_LIMITS.planeDimension;
    const planes = Array.from({ length: 4 }, (_, index) =>
      solidPlane(side, side, [index, 0, 0, 255]),
    );
    const packed = await run({
      operation: 'pack',
      planes,
      settings: {
        width: side,
        height: side,
        usage: 'data',
        name: 'big',
        channels: planes.map((_plane, index) => ({ plane: index, channel: 'r' })),
      },
    });
    expect((await normal(rampPlane(side, side))).width).toBe(side);
    expect(texels({ ...packed, width: 1, height: 1 })).toEqual([[0, 1, 2, 3]]);
    // One more plane is over the quota and refused before any Worker starts.
    await expect(
      run({ operation: 'pack', planes: [...planes, planes[0]!], settings: {} }),
    ).rejects.toThrow(/at most 4 planes/);
  });
});

describe('texture tiling and sidecars', () => {
  it('measures the wrap-around edge differences a 3×3 tiling shows', () => {
    expect(edgeDifferences(solidPlane(4, 4, [1, 2, 3, 255]))).toEqual({
      leftRight: { mean: 0, max: 0 },
      topBottom: { mean: 0, max: 0 },
    });
    const ramp = rampPlane(4, 2);
    expect(edgeDifferences(ramp)).toEqual({
      leftRight: { mean: 255, max: 255 },
      topBottom: { mean: 0, max: 0 },
    });
    const half = fixturePlane(2, 2, (x, y) => [x === 1 && y === 1 ? 100 : 0, 0, 0, 255]);
    expect(edgeDifferences(half)).toEqual({
      leftRight: { mean: 50, max: 100 },
      topBottom: { mean: 50, max: 100 },
    });
  });

  it('records how to read a packed or normal result', () => {
    const packed = textureSidecarDetails(
      selection({
        images: [solidPlane(1, 1, [0, 0, 0, 255]), null, null, null],
        channels: [{ plane: 0, channel: 'g' }, { constant: 3 }, { constant: 0 }, { constant: 255 }],
      }),
    );
    expect(packed).toMatchObject({
      operation: 'pack',
      channels: [
        { output: 'red', image: 1, channel: 'green' },
        { output: 'green', constant: 3 },
        { output: 'blue', constant: 0 },
        { output: 'alpha', constant: 255 },
      ],
      resampling: {
        filter: 'nearest',
        inputs: [{ slot: 1, width: 1, height: 1, alpha: 'opaque' }],
      },
    });
    const normal = textureSidecarDetails(
      selection({
        operation: 'normal',
        normal: { channel: 'r', strength: 3, green: 'down', edges: 'wrap' },
      }),
    );
    expect(normal).toMatchObject({
      operation: 'normal',
      normal: { y: 'down (DirectX, -Y)', strength: 3, edges: 'wrap (opposite edge)' },
    });
  });
});
