import type { TexelFormat, UniformValue } from '../../rendering/render-inspection';

/**
 * The inspector's arithmetic, kept free of Angular and the DOM so it can be tested
 * on its own: where a pointer landed in the captured image, how a raw component is
 * written down, and how a texel becomes a labelled display colour.
 *
 * Texel coordinates are the drawing buffer's: integers, origin at the bottom-left,
 * `y` growing upward, exactly as `gl_FragCoord - 0.5` addresses them.
 */

export interface TexelSize {
  readonly width: number;
  readonly height: number;
}

export interface Texel {
  readonly x: number;
  readonly y: number;
}

export interface ScreenRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The texel under a pointer. `rect` is the image element's *rendered* box, so CSS
 * size, zoom, device pixel ratio and a scaled render target all fall out of the
 * ratio — none of them is assumed. The screen's y grows downward; the texel's does
 * not. Outside the image is `null`: a pick is rejected, never snapped to an edge.
 */
export function pickTexel(
  rect: ScreenRect,
  clientX: number,
  clientY: number,
  size: TexelSize,
): Texel | null {
  if (!(rect.width > 0 && rect.height > 0) || !(size.width > 0 && size.height > 0)) return null;
  const fx = ((clientX - rect.left) / rect.width) * size.width;
  const fy = ((clientY - rect.top) / rect.height) * size.height;
  if (!(fx >= 0 && fx < size.width && fy >= 0 && fy < size.height)) return null;
  return { x: Math.floor(fx), y: size.height - 1 - Math.floor(fy) };
}

/** A typed coordinate: a whole number inside `0 … max - 1`, otherwise `null`. */
export function parseCoordinate(text: string, size: number): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value < size ? value : null;
}

/** One keyboard step, kept on the image: arrow keys move, the edge stops. */
export function stepTexel(texel: Texel, dx: number, dy: number, size: TexelSize): Texel {
  return {
    x: Math.min(Math.max(texel.x + dx, 0), size.width - 1),
    y: Math.min(Math.max(texel.y + dy, 0), size.height - 1),
  };
}

/** `gl_FragCoord` of a texel's centre. */
export function fragCoord(texel: Texel): readonly [number, number] {
  return [texel.x + 0.5, texel.y + 0.5];
}

export const ZOOM_LEVELS: readonly number[] = [0.25, 0.5, 1, 2, 4, 8, 16, 32];

/** The next zoom level in a direction, or the same one at either end. `null` is "fit". */
export function stepZoom(current: number | null, direction: 1 | -1): number {
  const from = current ?? 1;
  const index = ZOOM_LEVELS.findIndex((level) => level >= from);
  const here = index === -1 ? ZOOM_LEVELS.length - 1 : index;
  const next = direction === 1 ? (ZOOM_LEVELS[here] > from ? here : here + 1) : here - 1;
  return ZOOM_LEVELS[Math.min(Math.max(next, 0), ZOOM_LEVELS.length - 1)];
}

// -----------------------------------------------------------------------------
// Raw values
// -----------------------------------------------------------------------------

export type ComponentClass = 'nan' | 'posInf' | 'negInf' | 'negative' | 'hdr' | 'normal';

/** What is unusual about a raw component, so it is never mistaken for an ordinary one. */
export function classifyComponent(value: number, format: TexelFormat): ComponentClass {
  if (Number.isNaN(value)) return 'nan';
  if (value === Infinity) return 'posInf';
  if (value === -Infinity) return 'negInf';
  if (format === 'rgba8') return 'normal';
  if (value < 0) return 'negative';
  return value > 1 ? 'hdr' : 'normal';
}

/**
 * A component exactly as stored. Floats are written with every digit a double
 * needs (a half or float32 widens into one exactly), never rounded for display.
 */
export function formatRaw(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Infinity';
  if (value === -Infinity) return '-Infinity';
  return Object.is(value, -0) ? '-0' : String(value);
}

export function formatUniform(value: UniformValue): string {
  if (Array.isArray(value)) return `[${value.map((item) => formatUniform(item)).join(', ')}]`;
  return typeof value === 'number' ? formatRaw(value) : String(value);
}

// -----------------------------------------------------------------------------
// Visualization: a display transform, never the data
// -----------------------------------------------------------------------------

export type VisualChannel = 'rgb' | 'r' | 'g' | 'b' | 'a';
export type VisualTransform = 'linear' | 'srgb';

export interface VisualOptions {
  readonly channel: VisualChannel;
  readonly transform: VisualTransform;
  /** Stops of exposure applied before the transform: the value is scaled by 2^exposure. */
  readonly exposure: number;
}

export const EXPOSURE_LIMITS = { min: -16, max: 16 } as const;

export const DEFAULT_VISUAL: VisualOptions = { channel: 'rgb', transform: 'linear', exposure: 0 };

export function clampExposure(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, EXPOSURE_LIMITS.min), EXPOSURE_LIMITS.max);
}

export function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
}

const NAN_COLOR = [255, 0, 255] as const;
const POS_INF_COLOR = [255, 255, 255] as const;
const NEG_INF_COLOR = [0, 255, 255] as const;

function component(value: number, options: VisualOptions): number {
  const scaled = Math.min(Math.max(value * 2 ** options.exposure, 0), 1);
  const encoded = options.transform === 'srgb' ? linearToSrgb(scaled) : scaled;
  return Math.round(encoded * 255);
}

const CHANNEL_INDEX: Record<Exclude<VisualChannel, 'rgb'>, number> = { r: 0, g: 1, b: 2, a: 3 };

/**
 * The colour one texel is drawn with. Non-finite components are drawn as their own
 * colours (NaN magenta, +∞ white, −∞ cyan) rather than clamped into a plausible
 * value; everything else is exposure → clamp → transform.
 */
export function visualizeTexel(
  rgba: ArrayLike<number>,
  offset: number,
  format: TexelFormat,
  options: VisualOptions,
  out: Uint8ClampedArray,
  at: number,
): void {
  const scale = format === 'rgba8' ? 1 / 255 : 1;
  const shown =
    options.channel === 'rgb'
      ? [rgba[offset] * scale, rgba[offset + 1] * scale, rgba[offset + 2] * scale]
      : [rgba[offset + CHANNEL_INDEX[options.channel]] * scale];

  let special: readonly number[] | null = null;
  for (const value of shown) {
    if (Number.isNaN(value)) {
      special = NAN_COLOR;
      break;
    }
    if (value === Infinity) special = POS_INF_COLOR;
    else if (value === -Infinity && special !== POS_INF_COLOR) special = NEG_INF_COLOR;
  }

  if (special) {
    out[at] = special[0];
    out[at + 1] = special[1];
    out[at + 2] = special[2];
  } else if (shown.length === 1) {
    const grey = component(shown[0], options);
    out[at] = grey;
    out[at + 1] = grey;
    out[at + 2] = grey;
  } else {
    out[at] = component(shown[0], options);
    out[at + 1] = component(shown[1], options);
    out[at + 2] = component(shown[2], options);
  }
  out[at + 3] = 255;
}

/**
 * Paints `rows` bottom-up texel rows (`data`, GL order) into canvas pixels (top-down),
 * starting at texel row `firstRow` of an image `height` tall. Returns the canvas row
 * the band's top edge lands on.
 */
export function visualizeBand(
  data: ArrayLike<number>,
  width: number,
  rows: number,
  firstRow: number,
  height: number,
  format: TexelFormat,
  options: VisualOptions,
  out: Uint8ClampedArray,
): number {
  for (let row = 0; row < rows; row++) {
    // The band's top texel row is drawn first so the whole band is a single top-down block.
    const source = rows - 1 - row;
    for (let x = 0; x < width; x++) {
      visualizeTexel(data, (source * width + x) * 4, format, options, out, (row * width + x) * 4);
    }
  }
  return height - firstRow - rows;
}
