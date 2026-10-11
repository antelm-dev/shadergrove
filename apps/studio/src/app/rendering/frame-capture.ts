import type { CaptureFrame, CapturePlan } from '@shadergrove/shared/capture-plan';
import type { ShaderEngine } from '@shadergrove/rendering';

/**
 * Playing a capture plan through the engine and handing the frames to whoever
 * asked for them.
 *
 * This is the only place that knows a captured frame is not simply "what was on
 * the canvas": it may be several draws averaged into one exposure, and it may
 * have been drawn larger than it will be written. Both are things the live
 * renderer cannot do — it has one frame's worth of time and must show whatever
 * it has — and both are the reason an export is worth doing offline.
 *
 * What comes out is a canvas, not a blob: the PNG writer wants to encode it, the
 * video encoder wants to wrap it in a `VideoFrame` without ever encoding a PNG,
 * and neither should pay for the other's format.
 */

/** Raised when the capture was cancelled. Distinguished from a real failure. */
export class CaptureCancelled extends Error {
  constructor() {
    super('The capture was cancelled.');
    this.name = 'CaptureCancelled';
  }
}

export interface CaptureHooks {
  /** Called after each frame, with how many of `plan.loopFrames` are done. */
  onProgress?: (rendered: number, total: number) => void;
  signal?: AbortSignal;
}

/**
 * Receives each frame, in order, exactly once — even when the plan loops, since
 * a loop replays frames rather than redrawing them. Writing the repeats out is
 * the sink's business, not the renderer's.
 */
export type FrameSink = (canvas: HTMLCanvasElement, frame: CaptureFrame) => Promise<void> | void;

function canvasOf(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function contextOf(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  // `alpha: false` would flatten a transparent shader onto black before the PNG
  // ever saw it. Keep the alpha the shader actually produced.
  const context = canvas.getContext('2d', { willReadFrequently: false });
  if (!context) throw new Error('This browser would not give the capture a 2D canvas.');
  return context;
}

/**
 * Averages the shutter samples into one exposure.
 *
 * A running mean, not a sum: the k-th sample is composited at `1/(k+1)`, so what
 * is on the canvas after k samples is already their average. Summing with
 * `lighter` at a fixed `1/n` would round each addition into an 8-bit buffer and
 * let the error grow with the sample count, which shows up as banding in exactly
 * the dark, slow-moving areas motion blur is meant to smooth.
 */
class Exposure {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private samples = 0;

  constructor(width: number, height: number) {
    this.canvas = canvasOf(width, height);
    this.context = contextOf(this.canvas);
  }

  begin(): void {
    this.samples = 0;
    this.context.globalCompositeOperation = 'copy';
  }

  add(source: HTMLCanvasElement): void {
    this.context.globalAlpha = 1 / (this.samples + 1);
    this.context.drawImage(source, 0, 0);

    // The first sample replaces whatever the last frame left behind; every one
    // after it blends into the mean.
    if (this.samples === 0) {
      this.context.globalCompositeOperation = 'source-over';
    }
    this.samples++;
  }

  get result(): HTMLCanvasElement {
    return this.canvas;
  }
}

/**
 * Draws every frame of the plan and feeds it to `sink`.
 *
 * The engine's clock belongs to this function for its duration — and is given
 * back whatever happens, cancellation and failure included. Leaving an engine
 * offline would leave the preview frozen at the last frame filmed, with no loop
 * to thaw it.
 */
export async function captureFrames(
  engine: ShaderEngine,
  plan: CapturePlan,
  sink: FrameSink,
  hooks: CaptureHooks = {},
): Promise<void> {
  const { renderWidth, renderHeight, width, height, frames } = plan;
  const blurred = plan.settings.subframes > 1;
  const scaled = renderWidth !== width || renderHeight !== height;

  const exposure = blurred ? new Exposure(renderWidth, renderHeight) : null;

  const output = canvasOf(width, height);
  const context = contextOf(output);
  context.imageSmoothingEnabled = true;
  // The downsample *is* the anti-aliasing when supersampling. A cheap filter here
  // throws away the extra resolution that was just paid for.
  context.imageSmoothingQuality = 'high';

  engine.beginOffline(renderWidth, renderHeight);

  try {
    for (const frame of frames) {
      if (hooks.signal?.aborted) throw new CaptureCancelled();

      let source: HTMLCanvasElement;
      if (exposure) {
        exposure.begin();
        for (const sample of frame.samples) {
          engine.renderAt(sample);
          exposure.add(engine.surface);
        }
        source = exposure.result;
      } else {
        engine.renderAt(frame.time);
        source = engine.surface;
      }

      if (scaled || exposure) {
        context.globalCompositeOperation = 'copy';
        context.drawImage(source, 0, 0, renderWidth, renderHeight, 0, 0, width, height);
        await sink(output, frame);
      } else {
        // Nothing to composite and nothing to scale: the engine's own canvas is
        // already the frame. Copying it would be a full-resolution memcpy per
        // frame to produce the picture that is already there.
        await sink(engine.surface, frame);
      }

      hooks.onProgress?.(frame.index + 1, frames.length);
    }
  } finally {
    engine.endOffline();
  }
}
