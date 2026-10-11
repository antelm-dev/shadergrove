import type { ShaderParams } from '@shadergrove/shared/model';
import type { ShaderEngine } from '@shadergrove/rendering';

/**
 * Renders exactly one frame offscreen and hands back a PNG, without leaving
 * any trace on the live session.
 *
 * Reuses the same `beginOffline`/`renderAt`/`endOffline` contract
 * `frame-capture.ts` uses for video export: the clock, the pointer and any
 * ripples are frozen and restored, and the drawing buffer is put back to the
 * canvas's live size on the way out. What this adds on top is optional,
 * temporary parameter overrides — applied just before the draw, restored
 * immediately after `endOffline` hands the clock back, so the resumed live
 * loop never draws a frame with somebody else's uniform values.
 */

const DEFAULT_WIDTH = 512;
const DEFAULT_HEIGHT = 512;

export interface RenderFrameOptions {
  time?: number;
  width?: number;
  height?: number;
  params?: ShaderParams;
}

export interface RenderedFrame {
  blob: Blob;
  width: number;
  height: number;
  time: number;
}

export async function renderFrame(
  engine: ShaderEngine,
  liveParams: ShaderParams,
  options: RenderFrameOptions = {},
): Promise<RenderedFrame> {
  if (engine.capturing) {
    throw new Error('The engine is already capturing (a video export is in progress).');
  }

  const time = options.time ?? 0;
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const overrides = options.params;

  if (overrides) engine.setParams({ ...liveParams, ...overrides });

  engine.beginOffline(width, height);
  try {
    engine.renderAt(time);
    const blob = await new Promise<Blob | null>((resolve) =>
      engine.surface.toBlob(resolve, 'image/png'),
    );
    if (!blob) throw new Error('The shader failed to produce a frame.');
    return { blob, width, height, time };
  } finally {
    engine.endOffline();
    if (overrides) engine.setParams(liveParams);
  }
}
