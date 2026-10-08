/**
 * Texture Utilities — the Worker side of `texture-utilities/v1`.
 *
 * The host decodes, resamples and validates; this code only does arithmetic on
 * the RGBA8 planes it is sent and returns one new plane. It never sees a file,
 * never encodes one and never touches a texture slot. Every operation is pure
 * and deterministic: the same planes and settings give the same bytes.
 *
 * Operations (settings are validated by the host adapter before they arrive):
 *
 * - `pack` — `{ width, height, usage, name, channels: [R, G, B, A] }`, each
 *   channel `{ plane, channel }` (copy that plane's byte) or `{ constant }`
 *   (0–255). Every plane must already be `width × height`; values are copied
 *   exactly, never scaled, blended or gamma-converted. Alpha is `opaque` when
 *   A is the constant 255, otherwise `straight` (A is a fourth stored value).
 * - `normal` — `{ channel, strength, green, edges, name }` on one plane. The
 *   height is `byte / 255`; `strength` is how many texels high a full step
 *   (0 → 255) stands. Central differences, `edges: "wrap"` reads across the
 *   opposite edge (tileable), `"clamp"` repeats the edge texel. The normal is
 *   `normalize(-strength·∂h/∂x, -strength·∂h/∂y, 1)` with +X right and +Y up
 *   the image (`green: "up"`, OpenGL); `green: "down"` (DirectX) negates Y.
 *   Each component is stored as `round((n · 0.5 + 0.5) · 255)`, so a flat
 *   height gives (128, 128, 255). Output is `data`, `opaque`.
 */
import type { AssetToolInput, RgbaPlane } from '@shadergrove/shared/plugin';

type Channel = 'r' | 'g' | 'b' | 'a';
type ChannelSource = { plane: number; channel: Channel } | { constant: number };

interface PackSettings {
  width: number;
  height: number;
  usage: 'color' | 'data';
  name: string;
  channels: ChannelSource[];
}

interface NormalSettings {
  channel: Channel;
  strength: number;
  green: 'up' | 'down';
  edges: 'wrap' | 'clamp';
  name: string;
}

const OFFSET: Record<Channel, number> = { r: 0, g: 1, b: 2, a: 3 };

function pack(input: AssetToolInput, settings: PackSettings) {
  const { width, height } = settings;
  for (const plane of input.planes) {
    if (plane.width !== width || plane.height !== height) {
      throw new Error(`every plane must be ${width}×${height}; resample them first`);
    }
    if (plane.orientation !== input.planes[0]!.orientation) {
      throw new Error('every plane must have the same orientation');
    }
  }
  const sources = input.planes.map((plane) => new Uint8Array(plane.rgba));
  const out = new Uint8Array(width * height * 4);
  settings.channels.forEach((source, target) => {
    if ('constant' in source) {
      for (let index = target; index < out.length; index += 4) out[index] = source.constant;
      return;
    }
    const from = sources[source.plane];
    if (!from) throw new Error(`channel ${target} reads plane ${source.plane}, which was not sent`);
    const offset = OFFSET[source.channel];
    for (let index = 0; index < out.length; index += 4) out[index + target] = from[index + offset]!;
  });
  const alpha = settings.channels[3]!;
  return image(settings.name, width, height, input.planes[0]?.orientation ?? 'top-left', out, {
    usage: settings.usage,
    alpha: 'constant' in alpha && alpha.constant === 255 ? 'opaque' : 'straight',
  });
}

function normal(input: AssetToolInput, settings: NormalSettings) {
  const plane = input.planes[0];
  if (!plane || input.planes.length !== 1) throw new Error('normal takes exactly one height plane');
  const { width, height } = plane;
  const bytes = new Uint8Array(plane.rgba);
  const offset = OFFSET[settings.channel];
  const wrap = settings.edges === 'wrap';
  const at = (x: number, y: number): number => {
    const cx = wrap ? (x + width) % width : Math.min(width - 1, Math.max(0, x));
    const cy = wrap ? (y + height) % height : Math.min(height - 1, Math.max(0, y));
    return bytes[(cy * width + cx) * 4 + offset]! / 255;
  };
  // Row 0 is the top in `top-left` data, the bottom in `bottom-left` data: "up" follows the picture.
  const up = plane.orientation === 'top-left' ? -1 : 1;
  const ySign = settings.green === 'up' ? 1 : -1;
  const out = new Uint8Array(width * height * 4);
  const encode = (value: number) => Math.round((value * 0.5 + 0.5) * 255);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) / 2;
      const dy = (at(x, y + up) - at(x, y - up)) / 2;
      const nx = -settings.strength * dx;
      const ny = -settings.strength * dy * ySign;
      const length = Math.hypot(nx, ny, 1);
      const index = (y * width + x) * 4;
      out[index] = encode(nx / length);
      out[index + 1] = encode(ny / length);
      out[index + 2] = encode(1 / length);
      out[index + 3] = 255;
    }
  }
  return image(settings.name, width, height, plane.orientation, out, {
    usage: 'data',
    alpha: 'opaque',
  });
}

function image(
  name: string,
  width: number,
  height: number,
  orientation: RgbaPlane['orientation'],
  rgba: Uint8Array,
  descriptor: Pick<RgbaPlane, 'usage' | 'alpha'>,
) {
  return { name, width, height, orientation, ...descriptor, rgba: rgba.buffer };
}

shaderStudio.handle('assetTool:texture-utilities', (params) => {
  const input = params as AssetToolInput;
  const settings = input.settings as unknown;
  const output =
    input.operation === 'pack'
      ? pack(input, settings as PackSettings)
      : input.operation === 'normal'
        ? normal(input, settings as NormalSettings)
        : null;
  if (!output) throw new Error(`Unknown operation "${input.operation}"`);
  return {
    kind: 'image',
    images: [output],
    metadata: { operation: input.operation, settings: input.settings },
  };
});
