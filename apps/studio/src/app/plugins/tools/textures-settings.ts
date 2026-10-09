/**
 * Texture Utilities' operation settings, their validation and the panel's
 * text keys: what the tool's adapter needs at startup, kept apart from the
 * requests, tiling and image bridge the panel loads with itself.
 */
import { TOOL_LIMITS, type ImageUsage } from '@shadergrove/shared/plugin';
import { fail, ok, validateName, type Result } from '@shadergrove/shared/validate';

import type { TranslationKey } from '../../i18n/keys';

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

// --- Host text --------------------------------------------------------------------

/**
 * The panel's translation keys (`textures.<name>`), all in `TRANSLATION_KEYS`.
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

/** A panel key; the compiler checks that every one is a `TranslationKey`. */
export const textureKey = (name: TextureKeyName): TranslationKey => `textures.${name}` as const;
