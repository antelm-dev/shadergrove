/**
 * The host's image bridge for `assetTool` workflows: everything between a file
 * the user picked and an RGBA8 plane a tool Worker gets, and between a plane a
 * tool returned and a PNG on disk or in a texture slot. Texture Utilities and
 * Palette Studio both use it; neither decodes, resamples or encodes on its own.
 *
 * Colour and alpha are explicit at every step, never left to a browser default:
 *
 * - **Decode** (`decodeImageFile`) reads a PNG, JPEG or WebP at its own size with
 *   `colorSpaceConversion: "none"` and `premultiplyAlpha: "none"`, and reads the
 *   pixels back through WebGL 2 (a 2D canvas would premultiply and lose the
 *   colour under low alpha). The bytes are the file's stored samples: no ICC
 *   profile, gamma chunk or display conversion is applied. Rows are top-first
 *   (`orientation: "top-left"`), alpha is straight (`"opaque"` when every alpha
 *   byte is 255). `usage` is the caller's statement of what the bytes mean —
 *   `color` (sRGB-encoded picture) or `data` (numbers) — and changes no byte.
 * - **Resample** (`resampleImage`) maps texel centres (`(x + ½)·src/dst − ½`)
 *   and clamps at the edges. `nearest` copies source texels exactly. `linear` is
 *   bilinear on the stored bytes, rounded to nearest: no sRGB↔linear conversion
 *   (the same arithmetic a GPU applies to an RGBA8 texture). For `color` with
 *   straight alpha, colour is weighted by alpha so transparent texels do not
 *   bleed (where all weights are transparent the plain average is kept); `data`
 *   and opaque images interpolate each channel on its own. Same size = copy.
 *   Downscaling is bilinear, not area-averaged: fine detail can alias.
 * - **Encode** (`encodePng`) writes the bytes exactly: 8-bit RGBA, straight
 *   alpha, no gamma/ICC chunk, rows top-first (a `bottom-left` plane is flipped).
 * - **Sidecar** (`imageSidecar`) records size, orientation, alpha, usage and
 *   encoding, plus the tool's own conventions, beside a downloaded PNG.
 * - **Assign** (`channelTarget`, `assignPngToChannel`) writes a PNG to one
 *   texture slot of the open shader through the existing texture API, only
 *   after the caller's guard (`ToolSession.deliver`'s `check`) passes. The
 *   texture is sampled exactly as any uploaded PNG is now; usage is not stored.
 *
 * A plugin-supplied image name is a label, never a path: `safeFileName` makes a
 * download name of it, falling back to host text.
 */
import { LIMITS, extFromMime } from '@shadergrove/shared/validate';
import type { ChannelIndex } from '@shadergrove/shared/project';
import {
  TOOL_LIMITS,
  sourceFingerprint,
  type AssetImageOutput,
  type ImageAlpha,
  type ImageUsage,
  type RgbaDescriptor,
} from '@shadergrove/shared/plugin';

import type { ShaderStore } from '../../workspace/shader-store';
import type { ToolSource } from '../plugin-tools';

/** A plane the host owns: `rgba` is exactly `width × height × 4` bytes. Usable as an `RgbaSource`. */
export interface BridgeImage extends RgbaDescriptor {
  rgba: Uint8Array;
}

/** A decoded file: always `top-left`, never `premultiplied`. */
export interface DecodedImage extends BridgeImage {
  /** The file's name, for the panel only. */
  name: string;
  format: 'png' | 'jpg' | 'webp';
}

export type ResampleFilter = 'nearest' | 'linear';

export const IMAGE_BRIDGE_LIMITS = {
  /** Largest file the bridge decodes. */
  fileBytes: 32 * 1024 * 1024,
  /** Largest side of a decoded file; tools then resample to their own bounds. */
  decodeDimension: LIMITS.textureDimension,
} as const;

/** A refusal the panel can show as is. */
export class ImageBridgeError extends Error {}

// --- Decode -----------------------------------------------------------------------

/**
 * Decode one image file to exact RGBA8 bytes. Refuses anything but PNG, JPEG
 * and WebP, files over `IMAGE_BRIDGE_LIMITS.fileBytes` and images larger than
 * `decodeDimension` on a side — before decoding pixels where it can.
 */
export async function decodeImageFile(
  file: Blob & { name?: string },
  usage: ImageUsage,
): Promise<DecodedImage> {
  const name = file.name ?? 'image';
  const format = extFromMime(file.type) as DecodedImage['format'] | null;
  if (!format) throw new ImageBridgeError(`“${name}” must be a PNG, JPEG or WebP image`);
  if (file.size > IMAGE_BRIDGE_LIMITS.fileBytes) {
    throw new ImageBridgeError(`“${name}” is larger than 32 MB`);
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
      imageOrientation: 'from-image',
    });
  } catch {
    throw new ImageBridgeError(`“${name}” is not a readable image`);
  }
  try {
    const { width, height } = bitmap;
    const max = IMAGE_BRIDGE_LIMITS.decodeDimension;
    if (width > max || height > max) {
      throw new ImageBridgeError(`“${name}” is ${width}×${height}; at most ${max}×${max} is read`);
    }
    const rgba = readPixels(bitmap);
    return {
      name,
      format,
      width,
      height,
      orientation: 'top-left',
      alpha: alphaOf(rgba),
      usage,
      rgba,
    };
  } finally {
    bitmap.close();
  }
}

let gl: WebGL2RenderingContext | null = null;

/** The bitmap's bytes through one shared WebGL 2 context: no premultiply, no colour conversion, no flip. */
function readPixels(bitmap: ImageBitmap): Uint8Array {
  if (!gl || gl.isContextLost()) {
    gl =
      typeof OffscreenCanvas === 'undefined'
        ? null
        : new OffscreenCanvas(1, 1).getContext('webgl2', {
            alpha: true,
            premultipliedAlpha: false,
            antialias: false,
            depth: false,
            stencil: false,
          });
  }
  const context = gl;
  if (!context) throw new ImageBridgeError('Reading images exactly needs WebGL 2');
  const texture = context.createTexture();
  const framebuffer = context.createFramebuffer();
  try {
    context.bindTexture(context.TEXTURE_2D, texture);
    context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, false);
    context.pixelStorei(context.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    context.pixelStorei(context.UNPACK_COLORSPACE_CONVERSION_WEBGL, context.NONE);
    context.texImage2D(
      context.TEXTURE_2D,
      0,
      context.RGBA8,
      context.RGBA,
      context.UNSIGNED_BYTE,
      bitmap,
    );
    context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
    context.framebufferTexture2D(
      context.FRAMEBUFFER,
      context.COLOR_ATTACHMENT0,
      context.TEXTURE_2D,
      texture,
      0,
    );
    if (context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE) {
      throw new ImageBridgeError('This image could not be read');
    }
    const out = new Uint8Array(bitmap.width * bitmap.height * 4);
    context.pixelStorei(context.PACK_ALIGNMENT, 1);
    // Texture row 0 is the bitmap's top row (no flip), and readPixels starts at row 0.
    context.readPixels(0, 0, bitmap.width, bitmap.height, context.RGBA, context.UNSIGNED_BYTE, out);
    return out;
  } finally {
    context.bindFramebuffer(context.FRAMEBUFFER, null);
    context.deleteFramebuffer(framebuffer);
    context.deleteTexture(texture);
  }
}

/** `opaque` when every alpha byte is 255, `straight` otherwise. */
export function alphaOf(rgba: Uint8Array): ImageAlpha {
  for (let index = 3; index < rgba.length; index += 4) if (rgba[index] !== 255) return 'straight';
  return 'opaque';
}

// --- Resample ---------------------------------------------------------------------

/** The largest size within `max × max` with the same aspect ratio; at least 1×1, never enlarged. */
export function fitWithin(
  width: number,
  height: number,
  max: number,
): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.min(max, Math.round(width * scale))),
    height: Math.max(1, Math.min(max, Math.round(height * scale))),
  };
}

/** A new plane of `width × height` (see the module notes for the exact policy). */
export function resampleImage(
  image: BridgeImage,
  width: number,
  height: number,
  filter: ResampleFilter,
): BridgeImage {
  if (image.alpha === 'premultiplied') {
    throw new ImageBridgeError('Premultiplied images are not resampled');
  }
  const { width: sw, height: sh, rgba: src } = image;
  // Only the plane's own fields: a decoded file's name and format are not part of a plane.
  const plane = (rgba: Uint8Array): BridgeImage => ({
    width,
    height,
    orientation: image.orientation,
    alpha: image.alpha,
    usage: image.usage,
    rgba,
  });
  if (sw === width && sh === height) return plane(src.slice());
  const out = new Uint8Array(width * height * 4);
  if (filter === 'nearest') {
    for (let y = 0; y < height; y++) {
      const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / height));
      for (let x = 0; x < width; x++) {
        const sx = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / width));
        out.set(src.subarray((sy * sw + sx) * 4, (sy * sw + sx) * 4 + 4), (y * width + x) * 4);
      }
    }
    return plane(out);
  }
  const weighted = image.usage === 'color' && image.alpha === 'straight';
  const axis = (target: number, size: number, count: number) => {
    const s = ((target + 0.5) * size) / count - 0.5;
    const lower = Math.floor(s);
    return {
      a: Math.min(size - 1, Math.max(0, lower)),
      b: Math.min(size - 1, Math.max(0, lower + 1)),
      f: s - lower,
    };
  };
  for (let y = 0; y < height; y++) {
    const v = axis(y, sh, height);
    for (let x = 0; x < width; x++) {
      const u = axis(x, sw, width);
      const taps = [
        [(v.a * sw + u.a) * 4, (1 - u.f) * (1 - v.f)],
        [(v.a * sw + u.b) * 4, u.f * (1 - v.f)],
        [(v.b * sw + u.a) * 4, (1 - u.f) * v.f],
        [(v.b * sw + u.b) * 4, u.f * v.f],
      ] as const;
      const index = (y * width + x) * 4;
      let alpha = 0;
      for (const [at, w] of taps) alpha += w * src[at + 3]!;
      out[index + 3] = Math.round(alpha);
      for (let channel = 0; channel < 3; channel++) {
        let sum = 0;
        let plain = 0;
        for (const [at, w] of taps) {
          sum += w * src[at + 3]! * src[at + channel]!;
          plain += w * src[at + channel]!;
        }
        out[index + channel] = Math.round(weighted && alpha > 0 ? sum / alpha : plain);
      }
    }
  }
  return plane(out);
}

/** The plane a preview job sends: fitted within `TOOL_LIMITS.previewDimension`. */
export function previewImage(
  image: BridgeImage,
  filter: ResampleFilter,
  max: number = TOOL_LIMITS.previewDimension,
): BridgeImage {
  const size = fitWithin(image.width, image.height, max);
  return resampleImage(image, size.width, size.height, filter);
}

/** A tool's returned image as a bridge plane (a view on the returned buffer, not a copy). */
export function fromToolImage(image: AssetImageOutput): BridgeImage {
  const { name: _name, rgba, ...descriptor } = image;
  return { ...descriptor, rgba: new Uint8Array(rgba) };
}

// --- Encode -----------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index++) out[4 + index] = type.charCodeAt(index);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** zlib-wrapped deflate, by the platform's `CompressionStream`. */
async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream('deflate');
  const writer = stream.writable.getWriter();
  const [, out] = await Promise.all([
    writer.write(bytes as Uint8Array<ArrayBuffer>).then(() => writer.close()),
    new Response(stream.readable).arrayBuffer(),
  ]);
  return new Uint8Array(out);
}

/** The image as an exact 8-bit RGBA PNG. */
export async function encodePng(image: BridgeImage): Promise<Blob> {
  if (image.alpha === 'premultiplied') {
    throw new ImageBridgeError('Premultiplied images are not encoded');
  }
  const { width, height, rgba } = image;
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let row = 0; row < height; row++) {
    const from = image.orientation === 'top-left' ? row : height - 1 - row;
    // Filter type 0 (none) per row: every byte is stored as is.
    raw.set(rgba.subarray(from * stride, from * stride + stride), row * (stride + 1) + 1);
  }
  const zlib = await deflate(raw);
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8); // 8 bits, RGBA, deflate, adaptive filtering, no interlace
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new Blob(
    [signature, chunk('IHDR', header), chunk('IDAT', zlib), chunk('IEND', new Uint8Array())].map(
      (part) => part.slice().buffer,
    ),
    { type: 'image/png' },
  );
}

// --- Sidecar and names ------------------------------------------------------------

export const IMAGE_SIDECAR_FORMAT = 'shadergrove-image/v1';

/**
 * The JSON written beside a downloaded PNG. `encoding` says how to read a byte:
 * `srgb` for colour (sRGB-encoded), `none` for data (`byte / 255`, no transfer
 * function). `details` is the tool's own record (operation, settings, conventions).
 */
export function imageSidecar(
  image: RgbaDescriptor,
  file: string,
  details: Record<string, unknown>,
): Record<string, unknown> {
  return {
    format: IMAGE_SIDECAR_FORMAT,
    file,
    width: image.width,
    height: image.height,
    // The PNG itself: rows are always written top-first.
    orientation: 'top-left',
    alpha: image.alpha,
    usage: image.usage,
    encoding: image.usage === 'color' ? 'srgb' : 'none',
    ...details,
  };
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * A download name from a label nobody vetted: letters, digits, `-` and `_`
 * only, at most 48 characters, never a reserved device name; `fallback` (host
 * text, already safe) when nothing usable is left. No extension is kept.
 */
export function safeFileName(label: string, fallback: string): string {
  const stem = label
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 48)
    .replace(/[-_]+$/, '');
  return stem === '' || RESERVED.test(stem) ? fallback : stem;
}

/** Offer `blob` as a download named `fileName` (already safe). */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// --- Display ----------------------------------------------------------------------

export type ChannelView = 'rgba' | 'rgb' | 'r' | 'g' | 'b' | 'a';

/**
 * Draw a plane into a canvas for looking at only — never read back. `view`
 * shows one channel's raw bytes as grey, or the colour without (`rgb`) or with
 * alpha. `tiles` repeats it `tiles × tiles` times, top-first.
 */
export function drawImage(
  canvas: HTMLCanvasElement,
  image: BridgeImage,
  view: ChannelView = 'rgba',
  tiles = 1,
): void {
  const { width, height } = image;
  canvas.width = width * tiles;
  canvas.height = height * tiles;
  const context = canvas.getContext('2d');
  if (!context) return;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const offset = { r: 0, g: 1, b: 2, a: 3 } as Record<ChannelView, number>;
  for (let row = 0; row < height; row++) {
    const from = image.orientation === 'top-left' ? row : height - 1 - row;
    for (let x = 0; x < width; x++) {
      const at = (from * width + x) * 4;
      const to = (row * width + x) * 4;
      if (view === 'rgba' || view === 'rgb') {
        pixels.set(image.rgba.subarray(at, at + 3), to);
        pixels[to + 3] = view === 'rgba' ? image.rgba[at + 3]! : 255;
      } else {
        pixels.fill(image.rgba[at + offset[view]]!, to, to + 3);
        pixels[to + 3] = 255;
      }
    }
  }
  const data = new ImageData(pixels, width, height);
  for (let y = 0; y < tiles; y++) {
    for (let x = 0; x < tiles; x++) context.putImageData(data, x * width, y * height);
  }
}

// --- Assign -----------------------------------------------------------------------

/**
 * What an assignment to `channel` of the open shader is aimed at: the shader and
 * that slot's texture as they are now. `null` when no shader is open. Pass it
 * as `ToolSession.deliver`'s target `expected`, and this same function as its
 * `current`, so an assignment stops if the shader or the slot changed since.
 */
export function channelTarget(store: ShaderStore, channel: ChannelIndex): ToolSource | null {
  const record = store.record();
  if (!record) return null;
  return {
    shaderId: record.id,
    fingerprint: sourceFingerprint({ channel, texture: record.channels[channel] }),
  };
}

/**
 * Write a PNG to one slot of the open shader with the existing texture API —
 * after `check()` passes, with nothing awaited in between — and confirm the
 * slot now holds it. Throws when it could not (the store has also said why).
 */
export async function assignPngToChannel(
  store: ShaderStore,
  channel: ChannelIndex,
  png: Blob,
  fileName: string,
  check: () => void,
): Promise<void> {
  if (png.size > LIMITS.textureBytes) {
    throw new ImageBridgeError(
      `The PNG is larger than the ${LIMITS.textureBytes / (1024 * 1024)} MB a texture may be`,
    );
  }
  const file = new File([png], fileName, { type: 'image/png' });
  check();
  const before = store.record();
  await store.setTextureImage(channel, file);
  const after = store.record();
  if (!before || !after || after === before || after.id !== before.id) {
    throw new ImageBridgeError('The texture was not assigned');
  }
}
