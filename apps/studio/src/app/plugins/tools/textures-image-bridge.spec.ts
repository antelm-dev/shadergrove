import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_CHANNELS, type ShaderRecord } from '@shadergrove/shared/model';
import { LIMITS } from '@shadergrove/shared/validate';

import type { ShaderStore } from '../../workspace/shader-store';
import {
  alphaPlane,
  fixturePlane,
  rampPlane,
  readFixturePng,
  solidPlane,
} from './textures-fixtures';
import {
  IMAGE_BRIDGE_LIMITS,
  IMAGE_SIDECAR_FORMAT,
  ImageBridgeError,
  alphaOf,
  assignPngToChannel,
  channelTarget,
  decodeImageFile,
  encodePng,
  fitWithin,
  fromToolImage,
  imageSidecar,
  previewImage,
  resampleImage,
  safeFileName,
} from './textures-image-bridge';

/**
 * The shared image bridge (decode → resample → encode → sidecar → assign) with
 * explicit colour and alpha handling. Pixel decoding needs a browser (WebGL 2);
 * it is covered end to end in `plugin-textures.spec.ts`. Here: its refusals,
 * and every step that is plain arithmetic.
 */
describe('image bridge', () => {
  describe('decode', () => {
    it('refuses what it does not read before decoding anything', async () => {
      const bitmap = vi.fn();
      vi.stubGlobal('createImageBitmap', bitmap);
      try {
        await expect(
          decodeImageFile(new File(['GIF89a'], 'a.gif', { type: 'image/gif' }), 'color'),
        ).rejects.toThrow(/PNG, JPEG or WebP/);
        const huge = {
          name: 'huge.png',
          type: 'image/png',
          size: IMAGE_BRIDGE_LIMITS.fileBytes + 1,
        };
        await expect(decodeImageFile(huge as unknown as File, 'data')).rejects.toBeInstanceOf(
          ImageBridgeError,
        );
        expect(bitmap).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('asks for the stored samples: no colour conversion, no premultiplication', async () => {
      const close = vi.fn();
      const bitmap = vi.fn(async () => ({ width: 8192, height: 1, close }));
      vi.stubGlobal('createImageBitmap', bitmap);
      try {
        await expect(
          decodeImageFile(new File(['x'], 'wide.png', { type: 'image/png' }), 'color'),
        ).rejects.toThrow(/at most 4096×4096/);
        expect(bitmap).toHaveBeenCalledWith(expect.any(File), {
          colorSpaceConversion: 'none',
          premultiplyAlpha: 'none',
          imageOrientation: 'from-image',
        });
        expect(close).toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('calls an image with any alpha below 255 straight', () => {
      expect(alphaOf(solidPlane(2, 2, [1, 2, 3, 255]).rgba)).toBe('opaque');
      expect(alphaOf(alphaPlane().rgba)).toBe('straight');
    });
  });

  describe('resample', () => {
    it('fits within a bound, keeping the aspect, never enlarging', () => {
      expect(fitWithin(2048, 1024, 1024)).toEqual({ width: 1024, height: 512 });
      expect(fitWithin(100, 4000, 256)).toEqual({ width: 6, height: 256 });
      expect(fitWithin(3, 2, 256)).toEqual({ width: 3, height: 2 });
      expect(fitWithin(5000, 1, 256)).toEqual({ width: 256, height: 1 });
    });

    it('copies at the same size, whatever the filter', () => {
      const image = alphaPlane();
      const copy = resampleImage(image, 4, 2, 'linear');
      expect(copy.rgba).toEqual(image.rgba);
      expect(copy.rgba).not.toBe(image.rgba);
    });

    it('nearest picks exact source texels by texel centre', () => {
      const image = fixturePlane(4, 1, (x) => [x * 10, 0, 0, 255]);
      expect([...resampleImage(image, 2, 1, 'nearest').rgba].filter((_, i) => i % 4 === 0)).toEqual(
        [10, 30],
      );
      expect([...resampleImage(image, 8, 1, 'nearest').rgba].filter((_, i) => i % 4 === 0)).toEqual(
        [0, 0, 10, 10, 20, 20, 30, 30],
      );
    });

    it('linear interpolates stored bytes with clamped edges and no gamma step', () => {
      const image = fixturePlane(2, 1, (x) => [x === 0 ? 0 : 255, 0, 0, 255]);
      // Centres at -0.25, 0.25, 0.75, 1.25 in source texels: clamped, 25%, 75%, clamped.
      expect([...resampleImage(image, 4, 1, 'linear').rgba].filter((_, i) => i % 4 === 0)).toEqual([
        0, 64, 191, 255,
      ]);
      // A mid-grey average stays 128: an sRGB-aware filter would give about 188.
      const half = resampleImage(image, 1, 1, 'linear');
      expect(half.rgba[0]).toBe(128);
    });

    it('weights colour by straight alpha so transparent texels do not bleed; data stays per channel', () => {
      const image = fixturePlane(2, 1, (x) => (x === 0 ? [255, 0, 0, 255] : [0, 0, 255, 0]), {
        usage: 'color',
      });
      expect([...resampleImage(image, 1, 1, 'linear').rgba]).toEqual([255, 0, 0, 128]);
      const data = { ...image, usage: 'data' as const };
      expect([...resampleImage(data, 1, 1, 'linear').rgba]).toEqual([128, 0, 128, 128]);
      const invisible = fixturePlane(2, 1, (x) => [x * 200, 0, 0, 0], { usage: 'color' });
      expect([...resampleImage(invisible, 1, 1, 'linear').rgba]).toEqual([100, 0, 0, 0]);
    });

    it('makes a preview no larger than 256 and never touches the source', () => {
      const image = rampPlane(1024, 512);
      const before = image.rgba.slice(0, 64);
      const preview = previewImage(image, 'linear');
      expect([preview.width, preview.height]).toEqual([256, 128]);
      expect(image.rgba.slice(0, 64)).toEqual(before);
      expect(() => resampleImage({ ...image, alpha: 'premultiplied' }, 1, 1, 'linear')).toThrow(
        ImageBridgeError,
      );
    });
  });

  describe('encode and sidecar', () => {
    it('writes a PNG whose bytes are exactly the plane, colour under zero alpha included', async () => {
      const image = alphaPlane();
      const png = await encodePng(image);
      expect(png.type).toBe('image/png');
      const read = await readFixturePng(png);
      expect([read.width, read.height]).toEqual([4, 2]);
      expect(read.rgba).toEqual(image.rgba);
    });

    it('writes rows top-first, flipping a bottom-left plane', async () => {
      const image = fixturePlane(1, 2, (_x, y) => [y, 0, 0, 255], { orientation: 'bottom-left' });
      const read = await readFixturePng(await encodePng(image));
      expect([read.rgba[0], read.rgba[4]]).toEqual([1, 0]);
    });

    it('refuses premultiplied data rather than guessing', async () => {
      await expect(encodePng({ ...alphaPlane(), alpha: 'premultiplied' })).rejects.toThrow(
        ImageBridgeError,
      );
    });

    it('describes the PNG: size, rows, alpha, usage and how to read a byte', () => {
      const color = imageSidecar(alphaPlane(), 'a.png', { operation: 'pack' });
      expect(color).toEqual({
        format: IMAGE_SIDECAR_FORMAT,
        file: 'a.png',
        width: 4,
        height: 2,
        orientation: 'top-left',
        alpha: 'straight',
        usage: 'color',
        encoding: 'srgb',
        operation: 'pack',
      });
      expect(
        imageSidecar({ ...rampPlane(2, 2), orientation: 'bottom-left' }, 'n.png', {}),
      ).toMatchObject({
        orientation: 'top-left',
        usage: 'data',
        encoding: 'none',
      });
    });

    it('turns a tool’s image label into a safe file name, never a path', () => {
      expect(safeFileName('Packed ORM', 'texture')).toBe('Packed-ORM');
      expect(safeFileName('../../etc/passwd', 'texture')).toBe('etc-passwd');
      expect(safeFileName('C:\\Windows\\x.png', 'texture')).toBe('C-Windows-x-png');
      expect(safeFileName('a/b?c*d', 'texture')).toBe('a-b-c-d');
      expect(safeFileName('...', 'texture')).toBe('texture');
      expect(safeFileName('CON', 'texture')).toBe('texture');
      expect(safeFileName('a'.repeat(80), 'texture')).toHaveLength(48);
    });

    it('reads a returned image as a view on its buffer', () => {
      const rgba = new Uint8Array([1, 2, 3, 4]).buffer;
      const image = fromToolImage({
        name: 'x',
        width: 1,
        height: 1,
        orientation: 'top-left',
        alpha: 'straight',
        usage: 'data',
        rgba,
      });
      expect(image).toEqual({
        width: 1,
        height: 1,
        orientation: 'top-left',
        alpha: 'straight',
        usage: 'data',
        rgba: new Uint8Array([1, 2, 3, 4]),
      });
      expect(image.rgba.buffer).toBe(rgba);
    });
  });

  describe('assign', () => {
    const record = (id: string, ext: string | null = null) =>
      ({
        id,
        name: id,
        channels: DEFAULT_CHANNELS.map((channel) => ({ ...channel, ext })),
      }) as unknown as ShaderRecord;

    const storeWith = (
      current: ShaderRecord | null,
      onSet?: (channel: number, file: File) => ShaderRecord | null,
    ) => {
      const value = signal(current);
      const setTextureImage = vi.fn(async (channel: number, file: File) => {
        const next = onSet?.(channel, file);
        if (next) value.set(next);
      });
      return {
        store: { record: value, setTextureImage } as unknown as ShaderStore,
        value,
        setTextureImage,
      };
    };

    it('aims at the open shader and one slot as they are now', () => {
      const { store, value } = storeWith(record('a'));
      const target = channelTarget(store, 2)!;
      expect(target.shaderId).toBe('a');
      expect(channelTarget(store, 2)).toEqual(target);
      expect(channelTarget(store, 1)).not.toEqual(target);
      value.set(record('a', 'png'));
      expect(channelTarget(store, 2)).not.toEqual(target);
      value.set(null);
      expect(channelTarget(store, 2)).toBeNull();
    });

    it('writes a PNG file through the texture API after the guard passes, and confirms it', async () => {
      const { store, setTextureImage } = storeWith(record('a'), () => record('a', 'png'));
      const check = vi.fn();
      await assignPngToChannel(store, 3, new Blob(['png'], { type: 'image/png' }), 'n.png', check);
      expect(check).toHaveBeenCalledTimes(1);
      const [channel, file] = setTextureImage.mock.calls[0]!;
      expect(channel).toBe(3);
      expect([file.name, file.type]).toEqual(['n.png', 'image/png']);
    });

    it('writes nothing when the guard throws, and reports a refused write', async () => {
      const { store, setTextureImage } = storeWith(record('a'), () => null);
      const stale = vi.fn(() => {
        throw new Error('stale');
      });
      await expect(assignPngToChannel(store, 0, new Blob(['png']), 'n.png', stale)).rejects.toThrow(
        'stale',
      );
      expect(setTextureImage).not.toHaveBeenCalled();
      await expect(
        assignPngToChannel(store, 0, new Blob(['png']), 'n.png', () => undefined),
      ).rejects.toThrow(/not assigned/);
    });

    it('refuses a PNG over the texture size limit before writing', async () => {
      const { store, setTextureImage } = storeWith(record('a'));
      const big = new Blob([new Uint8Array(LIMITS.textureBytes + 1)]);
      await expect(assignPngToChannel(store, 0, big, 'n.png', () => undefined)).rejects.toThrow(
        /larger/,
      );
      expect(setTextureImage).not.toHaveBeenCalled();
    });
  });
});
