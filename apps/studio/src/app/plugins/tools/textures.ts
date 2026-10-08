/**
 * Texture Utilities (`texture-utilities/v1`): the host's half of the workflow,
 * without the panel — operation settings and their validation (what reaches
 * the Worker), how a request is built from the selected images, the edge
 * differences of a tiled preview, and the sidecar record of a result.
 *
 * The Worker (`plugins/official/texture-utilities`) only does arithmetic on
 * equal-sized planes. The host resamples every selected image to the chosen
 * output size first (`textures-image-bridge`), so mismatched inputs are made to
 * agree here, by the policy the user picked, and never inside the Worker.
 */
import { fail, ok, validateName, type Result } from '@shadergrove/shared/validate';
import { TOOL_LIMITS, type AssetToolRequest, type ImageUsage } from '@shadergrove/shared/plugin';

import type { TranslationKey } from '../../i18n/keys';
import {
  fitWithin,
  resampleImage,
  type BridgeImage,
  type ResampleFilter,
} from './textures-image-bridge';

export type TextureOperation = 'pack' | 'normal';
export type ChannelName = 'r' | 'g' | 'b' | 'a';
export const CHANNEL_NAMES: readonly ChannelName[] = ['r', 'g', 'b', 'a'];

/** Where one output channel comes from: a channel of a sent plane, or a constant byte. */
export type ChannelSource = { plane: number; channel: ChannelName } | { constant: number };

export interface PackSettings {
  width: number;
  height: number;
  usage: ImageUsage;
  name: string;
  /** R, G, B, A of the output, in that order. */
  channels: ChannelSource[];
}

export interface NormalSettings {
  channel: ChannelName;
  /** How many texels high a full step (0 → 255) stands. */
  strength: number;
  /** `up`: +Y up the picture (OpenGL); `down`: +Y down (DirectX). */
  green: 'up' | 'down';
  edges: 'wrap' | 'clamp';
  name: string;
}

export const NORMAL_STRENGTH = { min: 0.01, max: 100 } as const;
/** Largest output side: a full job's planes are at most `TOOL_LIMITS.planeDimension`. */
export const OUTPUT_DIMENSION = TOOL_LIMITS.planeDimension;

// --- Settings ---------------------------------------------------------------------

const keysOf = (record: Record<string, unknown>, known: readonly string[]) =>
  Object.keys(record).find((key) => !known.includes(key));

const isByte = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 255;

const isSide = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 1 && (value as number) <= OUTPUT_DIMENSION;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The workflow's settings schema, strict: unknown operations and fields are
 * refused, numbers are bounded, and what is returned is a fresh object. The
 * plane count is checked by the Worker, which sees the planes.
 */
export function validateTextureSettings(
  operation: string,
  settings: unknown,
): Result<Record<string, unknown>> {
  if (!isRecord(settings)) return fail('settings must be an object');
  if (operation === 'pack') {
    const extra = keysOf(settings, ['width', 'height', 'usage', 'name', 'channels']);
    if (extra) return fail(`settings.${extra} is not a known setting`);
    const { width, height, usage, name, channels } = settings;
    if (!isSide(width) || !isSide(height)) {
      return fail(`output size must be 1–${OUTPUT_DIMENSION} on each side`);
    }
    if (usage !== 'color' && usage !== 'data') return fail('usage must be color or data');
    const label = validateName(name);
    if (!label.ok) return label;
    if (!Array.isArray(channels) || channels.length !== 4) {
      return fail('channels must list R, G, B and A');
    }
    const parsed: ChannelSource[] = [];
    for (const source of channels) {
      if (!isRecord(source)) return fail('a channel source must be an object');
      if ('constant' in source) {
        if (keysOf(source, ['constant']) || !isByte(source['constant'])) {
          return fail('a constant must be a whole number from 0 to 255');
        }
        parsed.push({ constant: source['constant'] });
        continue;
      }
      const { plane, channel } = source;
      if (
        keysOf(source, ['plane', 'channel']) ||
        !Number.isInteger(plane) ||
        (plane as number) < 0 ||
        (plane as number) >= TOOL_LIMITS.planes ||
        !CHANNEL_NAMES.includes(channel as ChannelName)
      ) {
        return fail('a channel source must name a plane (0–3) and a channel (r, g, b, a)');
      }
      parsed.push({ plane: plane as number, channel: channel as ChannelName });
    }
    return ok({ width, height, usage, name: label.value, channels: parsed });
  }
  if (operation === 'normal') {
    const extra = keysOf(settings, ['channel', 'strength', 'green', 'edges', 'name']);
    if (extra) return fail(`settings.${extra} is not a known setting`);
    const { channel, strength, green, edges, name } = settings;
    if (!CHANNEL_NAMES.includes(channel as ChannelName))
      return fail('channel must be r, g, b or a');
    if (
      typeof strength !== 'number' ||
      !Number.isFinite(strength) ||
      strength < NORMAL_STRENGTH.min ||
      strength > NORMAL_STRENGTH.max
    ) {
      return fail(`strength must be ${NORMAL_STRENGTH.min} to ${NORMAL_STRENGTH.max}`);
    }
    if (green !== 'up' && green !== 'down') return fail('green must be up or down');
    if (edges !== 'wrap' && edges !== 'clamp') return fail('edges must be wrap or clamp');
    const label = validateName(name);
    if (!label.ok) return label;
    return ok({ channel, strength, green, edges, name: label.value });
  }
  return fail(`Unknown operation "${operation}"`);
}

// --- Requests ---------------------------------------------------------------------

/** What the panel holds: one optional image per slot, plus the operation's settings. */
export interface TextureSelection {
  operation: TextureOperation;
  /** Four slots for `pack`; slot 0 is the height map for `normal`. */
  images: readonly (BridgeImage | null)[];
  width: number;
  height: number;
  filter: ResampleFilter;
  usage: ImageUsage;
  /** Output R, G, B, A; `plane` is a slot index here. */
  channels: readonly ChannelSource[];
  normal: Omit<NormalSettings, 'name'>;
  name: string;
}

/** A refusal of the selection itself, phrased for the panel. */
export class SelectionError extends Error {
  constructor(
    readonly key: TranslationKey,
    readonly params: Record<string, string | number> = {},
  ) {
    super(key);
  }
}

/**
 * The request for the selection, its images resampled to the output size —
 * or, for a preview, to that size fitted within `TOOL_LIMITS.previewDimension`.
 * Pack sends only the slots its channels read, in slot order, and renumbers the
 * channels' planes to match. Throws `SelectionError` when a needed image is missing.
 */
export function buildTextureRequest(
  selection: TextureSelection,
  preview: boolean,
): AssetToolRequest {
  const size = preview
    ? fitWithin(selection.width, selection.height, TOOL_LIMITS.previewDimension)
    : { width: selection.width, height: selection.height };
  const plane = (slot: number) => {
    const image = selection.images[slot];
    if (!image) throw new SelectionError(textureKey('missingImage'), { n: slot + 1 });
    return resampleImage(
      { ...image, usage: selection.operation === 'normal' ? 'data' : selection.usage },
      size.width,
      size.height,
      selection.filter,
    );
  };
  if (selection.operation === 'normal') {
    return {
      operation: 'normal',
      preview,
      planes: [plane(0)],
      settings: { ...selection.normal, name: selection.name },
    };
  }
  const slots = [
    ...new Set(selection.channels.flatMap((source) => ('plane' in source ? [source.plane] : []))),
  ].sort((a, b) => a - b);
  return {
    operation: 'pack',
    preview,
    planes: slots.map(plane),
    settings: {
      width: size.width,
      height: size.height,
      usage: selection.usage,
      name: selection.name,
      channels: selection.channels.map((source) =>
        'plane' in source ? { ...source, plane: slots.indexOf(source.plane) } : source,
      ),
    },
  };
}

// --- Tiling -----------------------------------------------------------------------

export interface EdgeDifference {
  /** Mean and largest per-texel difference (largest over the four channels, 0–255). */
  mean: number;
  max: number;
}

/**
 * How much the image differs across its wrap-around edges — the seams a 3×3
 * tiling shows: the last column against the first, the last row against the
 * first. Zero means those texels match; it does not make a texture seamless.
 */
export function edgeDifferences(image: BridgeImage): {
  leftRight: EdgeDifference;
  topBottom: EdgeDifference;
} {
  const { width, height, rgba } = image;
  const texel = (a: number, b: number) => {
    let most = 0;
    for (let channel = 0; channel < 4; channel++) {
      most = Math.max(most, Math.abs(rgba[a * 4 + channel]! - rgba[b * 4 + channel]!));
    }
    return most;
  };
  const summarize = (values: number[]): EdgeDifference => ({
    mean: Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10,
    max: Math.max(...values),
  });
  const rows = Array.from({ length: height }, (_, y) => texel(y * width, y * width + width - 1));
  const columns = Array.from({ length: width }, (_, x) => texel(x, (height - 1) * width + x));
  return { leftRight: summarize(rows), topBottom: summarize(columns) };
}

// --- Sidecar ----------------------------------------------------------------------

const CHANNEL_WORD: Record<ChannelName, string> = { r: 'red', g: 'green', b: 'blue', a: 'alpha' };

/** The tool's part of a result's sidecar: what produced it and how to read it. */
export function textureSidecarDetails(selection: TextureSelection): Record<string, unknown> {
  const inputs = selection.images.flatMap((image, slot) =>
    image ? [{ slot: slot + 1, width: image.width, height: image.height, alpha: image.alpha }] : [],
  );
  const base = {
    generator: 'dev.shadergrove.texture-utilities/texture-utilities',
    workflow: 'texture-utilities/v1',
    operation: selection.operation,
    resampling: {
      filter: selection.filter,
      policy:
        'inputs resampled to the output size on the host: texel centres, clamped edges, bilinear on stored bytes (no gamma conversion), colour weighted by straight alpha',
      inputs,
    },
  };
  if (selection.operation === 'normal') {
    const { channel, strength, green, edges } = selection.normal;
    return {
      ...base,
      normal: {
        space: 'tangent',
        x: 'right',
        y: green === 'up' ? 'up (OpenGL, +Y)' : 'down (DirectX, -Y)',
        z: 'out of the surface',
        encoding: 'byte = round((n * 0.5 + 0.5) * 255); flat = (128, 128, 255)',
        height: `${CHANNEL_WORD[channel]} channel of image 1, byte / 255`,
        strength,
        derivative: 'central differences, n = normalize(-strength * dh/dx, -strength * dh/dy, 1)',
        edges: edges === 'wrap' ? 'wrap (opposite edge)' : 'clamp (edge texel repeated)',
      },
    };
  }
  return {
    ...base,
    channels: selection.channels.map((source, index) => ({
      output: CHANNEL_WORD[CHANNEL_NAMES[index]!],
      ...('constant' in source
        ? { constant: source.constant }
        : { image: source.plane + 1, channel: CHANNEL_WORD[source.channel] }),
    })),
    values: 'copied byte for byte; never scaled, blended or gamma-converted',
  };
}

// --- Host text --------------------------------------------------------------------

/**
 * The panel's translation keys (`textures.<name>`). The coordinator adds them to
 * `TRANSLATION_KEYS` and the dictionaries; until then a lookup shows the key.
 */
export const TEXTURE_KEYS = [
  'command',
  'operation',
  'opPack',
  'opNormal',
  'images',
  'image',
  'heightMap',
  'choose',
  'remove',
  'imageInfo',
  'resampleNote',
  'outputSize',
  'width',
  'height',
  'filter',
  'filterNearest',
  'filterLinear',
  'usage',
  'usageData',
  'usageColor',
  'output',
  'source',
  'constant',
  'channel',
  'heightChannel',
  'strength',
  'green',
  'greenUp',
  'greenDown',
  'edges',
  'edgesWrap',
  'edgesClamp',
  'name',
  'preview',
  'view',
  'tile',
  'seams',
  'seamsHint',
  'needImages',
  'missingImage',
  'generate',
  'working',
  'stale',
  'cancelled',
  'result',
  'downloadPng',
  'downloadSidecar',
  'downloaded',
  'slot',
  'assign',
  'assigned',
  'assignNeedsShader',
  'staleDelivery',
] as const;
export type TextureKeyName = (typeof TEXTURE_KEYS)[number];

/** A panel key, typed as one the coordinator will add (see `TEXTURE_KEYS`). */
export const textureKey = (name: TextureKeyName): TranslationKey =>
  `textures.${name}` as TranslationKey;
