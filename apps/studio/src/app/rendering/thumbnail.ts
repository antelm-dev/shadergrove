import { THUMBNAIL_HEIGHT, THUMBNAIL_WIDTH } from '@shadergrove/shared/model';
import type { ThumbnailUpload } from '../api/shader-api';

/**
 * Encoding a preview out of the frame that is already on screen.
 *
 * Re-rendering the shader off-screen would give a constant framing, but it
 * would also mean a second WebGL context — the one thing the engine cannot
 * have. So the preview is the live canvas, centre-cropped to 16:9 and scaled
 * down: whatever the window's shape, the thumbnail is what the user was
 * looking at when they saved.
 */

/** The largest centred region of a `width`×`height` canvas with the target's aspect ratio. */
export function coverCrop(
  width: number,
  height: number,
  aspect = THUMBNAIL_WIDTH / THUMBNAIL_HEIGHT,
): { x: number; y: number; width: number; height: number } {
  if (width <= 0 || height <= 0) return { x: 0, y: 0, width: 0, height: 0 };

  if (width / height > aspect) {
    // Too wide: keep the full height, trim the sides.
    const cropped = height * aspect;
    return { x: (width - cropped) / 2, y: 0, width: cropped, height };
  }

  const cropped = width / aspect;
  return { x: 0, y: (height - cropped) / 2, width, height: cropped };
}

/**
 * Scales a captured frame down to a thumbnail.
 *
 * WebP is worth a lot here (a preview is ~10× smaller than the same PNG), but
 * `toBlob` silently falls back to PNG where WebP encoding is unsupported — so
 * the *blob* decides the extension, never the request.
 */
export async function encodeThumbnail(frame: Blob): Promise<ThumbnailUpload | null> {
  const encoded = await scaleFrame(frame);
  if (!encoded) return null;

  const ext = encoded.type === 'image/webp' ? 'webp' : 'png';
  return { ext, bytes: new Uint8Array(await encoded.arrayBuffer()) };
}

/** The cropping and encoding behind `encodeThumbnail`, at any size, as a WebP (or PNG) blob. */
export async function scaleFrame(
  frame: Blob,
  size: { width: number; height: number } = { width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT },
): Promise<Blob | null> {
  const bitmap = await createImageBitmap(frame);
  try {
    const crop = coverCrop(bitmap.width, bitmap.height, size.width / size.height);
    if (crop.width === 0) return null;

    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;

    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(
      bitmap,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      size.width,
      size.height,
    );

    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.82));
  } finally {
    bitmap.close();
  }
}
