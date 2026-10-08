// Exact little PNGs for the image-tool journeys (Texture Utilities, Palette
// Studio): written and read here in Node, so a test knows every byte it hands
// the browser and every byte it gets back. 8-bit RGBA, no gamma or colour
// chunk, filter 0 — the same shape the app's `encodePng` writes, which is all
// `readPng` reads.

import { crc32, deflateSync, inflateSync } from 'node:zlib';

export type Texel = readonly [number, number, number, number];

export interface Rgba {
  width: number;
  height: number;
  /** Row-major, top row first. */
  rgba: Uint8Array;
}

export function plane(width: number, height: number, texel: (x: number, y: number) => Texel): Rgba {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) rgba.set(texel(x, y), (y * width + x) * 4);
  }
  return { width, height, rgba };
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

export function writePng({ width, height, rgba }: Rgba): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row++) {
    raw.set(rgba.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array()),
  ]);
}

/** Read an 8-bit RGBA, non-interlaced, filter-0 PNG; anything else throws. */
export function readPng(png: Buffer): Rgba {
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  const chunks: string[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    chunks.push(type);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error('not 8-bit RGBA');
    }
    if (type === 'IDAT') idat.push(data);
    offset += 12 + length;
  }
  // No gAMA, cHRM, sRGB or iCCP: nothing tells a reader to convert the bytes.
  if (chunks.some((type) => ['gAMA', 'cHRM', 'sRGB', 'iCCP'].includes(type))) {
    throw new Error(`colour chunks present: ${chunks.join(', ')}`);
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rgba = new Uint8Array(stride * height);
  for (let row = 0; row < height; row++) {
    if (raw[row * (stride + 1)] !== 0) throw new Error('only filter 0 is read');
    rgba.set(raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1)), row * stride);
  }
  return { width, height, rgba };
}

/** One channel of every texel, top row first. */
export const channel = (image: Rgba, index: 0 | 1 | 2 | 3): number[] =>
  Array.from({ length: image.width * image.height }, (_, texel) => image.rgba[texel * 4 + index]!);

/**
 * Four 4×2 sources whose bytes differ per image and channel, with alpha below
 * 255 — down to 0 — in the bottom row, where a premultiplying or colour-managed
 * decode would change the colour bytes.
 */
export const SOURCES: readonly Rgba[] = [0, 1, 2, 3].map((image) =>
  plane(4, 2, (x, y) => [
    (image * 60 + x * 17 + y * 5) % 256,
    (image * 31 + x * 41 + y * 3 + 7) % 256,
    (image * 13 + x * 29 + y * 11 + 101) % 256,
    y === 0 ? 255 : [200, 64, 1, 0][x]!,
  ]),
);
