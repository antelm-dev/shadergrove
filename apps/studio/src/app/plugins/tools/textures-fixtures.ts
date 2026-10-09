/**
 * Image fixtures for specs of the image bridge and the tools that use it
 * (Texture Utilities, Palette Studio). Small, exact planes whose every byte is
 * known, a reader for the PNGs `encodePng` writes, and the official Texture
 * Utilities package as the catalogue ships it. Specs only.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { parsePluginPackage, type PluginPackage } from '@shadergrove/shared/plugin';

import type { BridgeImage } from './textures-image-bridge';

/** A `top-left`, `data` plane whose texel (x, y) is `texel(x, y)` (four bytes). */
export function fixturePlane(
  width: number,
  height: number,
  texel: (x: number, y: number) => readonly [number, number, number, number],
  descriptor: Partial<Pick<BridgeImage, 'alpha' | 'usage' | 'orientation'>> = {},
): BridgeImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) rgba.set(texel(x, y), (y * width + x) * 4);
  }
  return {
    width,
    height,
    orientation: 'top-left',
    alpha: rgba.every((value, index) => index % 4 !== 3 || value === 255) ? 'opaque' : 'straight',
    usage: 'data',
    ...descriptor,
    rgba,
  };
}

/** Every texel the same. */
export const solidPlane = (
  width: number,
  height: number,
  texel: readonly [number, number, number, number],
) => fixturePlane(width, height, () => texel);

/** A horizontal ramp in every colour channel: x = 0 is 0, the last column is 255. Opaque. */
export const rampPlane = (width: number, height: number) =>
  fixturePlane(width, height, (x) => {
    const value = Math.round((x * 255) / (width - 1));
    return [value, value, value, 255];
  });

/**
 * A 4×2 colour image with alpha: an opaque top row (red, green, blue, white)
 * and a bottom row at alpha 128, 64, 1 and 0 whose colour must survive exactly
 * (the colour under alpha 0 included). For alpha handling in decode/encode and
 * alpha-weighted extraction.
 */
export const alphaPlane = () =>
  fixturePlane(
    4,
    2,
    (x, y) =>
      y === 0
        ? (
            [
              [255, 0, 0, 255],
              [0, 255, 0, 255],
              [0, 0, 255, 255],
              [255, 255, 255, 255],
            ] as const
          )[x]!
        : (
            [
              [200, 100, 50, 128],
              [10, 20, 30, 64],
              [250, 5, 125, 1],
              [77, 88, 99, 0],
            ] as const
          )[x]!,
    { usage: 'color' },
  );

/** A blob's bytes, under jsdom too (whose `Blob` has no `arrayBuffer`). */
export function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * Read a PNG written by `encodePng` back to its bytes (8-bit RGBA, no
 * interlace; filter 0 only, which is all `encodePng` writes). A spec's check,
 * not a general decoder.
 */
export async function readFixturePng(
  png: Blob,
): Promise<{ width: number; height: number; rgba: Uint8Array }> {
  const bytes = await blobBytes(png);
  const view = new DataView(bytes.buffer);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error('not 8-bit RGBA');
    }
    if (type === 'IDAT') idat.push(data);
    offset += 12 + length;
  }
  const inflate = new DecompressionStream('deflate');
  const writer = inflate.writable.getWriter();
  const [, inflated] = await Promise.all([
    (async () => {
      for (const part of idat) await writer.write(part.slice());
      await writer.close();
    })(),
    new Response(inflate.readable).arrayBuffer(),
  ]);
  const raw = new Uint8Array(inflated);
  const stride = width * 4;
  const rgba = new Uint8Array(stride * height);
  for (let row = 0; row < height; row++) {
    if (raw[row * (stride + 1)] !== 0) throw new Error('only filter 0 is read');
    rgba.set(raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1)), row * stride);
  }
  return { width, height, rgba };
}

export const TEXTURE_UTILITIES_ID = 'dev.shadergrove.texture-utilities';
export const TEXTURE_UTILITIES_FILE = `${TEXTURE_UTILITIES_ID}-1.0.0.sgplugin.json`;

/** The official Texture Utilities package text, as `pnpm gen:plugins` writes it. */
export function textureUtilitiesText(): string {
  // Bundled with the importing spec, `import.meta.dirname` is that spec's folder: walk up.
  for (let dir = import.meta.dirname; dir !== dirname(dir); dir = dirname(dir)) {
    const file = resolve(dir, 'src/plugins', TEXTURE_UTILITIES_FILE);
    if (existsSync(file)) return readFileSync(file, 'utf8');
  }
  throw new Error(`No generated ${TEXTURE_UTILITIES_FILE} above ${import.meta.dirname}`);
}

export function textureUtilitiesPackage(): PluginPackage {
  const parsed = parsePluginPackage(textureUtilitiesText());
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return parsed.value;
}
