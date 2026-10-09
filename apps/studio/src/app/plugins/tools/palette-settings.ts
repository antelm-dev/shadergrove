/**
 * Palette Studio's operation settings, their validation and the panel's text
 * keys: what the tool's adapter needs at startup, kept apart from the gradient
 * editor, palette JSON and Apply the panel loads with itself.
 */
import type { GradientInterpolation } from '@shadergrove/shared/plugin';
import { fail, ok, validateName, type Result } from '@shadergrove/shared/validate';

import type { TranslationKey } from '../../i18n/keys';

export type PaletteOperation = 'extract' | 'effect';
export const PALETTE_ADJUSTMENTS = ['contrast', 'shift'] as const;
export type PaletteAdjustment = (typeof PALETTE_ADJUSTMENTS)[number];
export const EXTRACT_COUNT = { min: 4, max: 8 } as const;
export const ALPHA_THRESHOLD = { min: 1, max: 255 } as const;
export const INTERPOLATIONS: readonly GradientInterpolation[] = ['oklab', 'linear', 'srgb'];
/** A palette file is a few hundred bytes; anything this large is not one. */
export const PALETTE_FILE_BYTES = 64 * 1024;

export interface ExtractSettings {
  count: number;
  alphaThreshold: number;
}

export interface EffectSettings {
  strength: number;
  adjustments: readonly PaletteAdjustment[];
}

// --- Settings ---------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const extraKey = (record: Record<string, unknown>, known: readonly string[]) =>
  Object.keys(record).find((key) => !known.includes(key));
const isIntIn = (value: unknown, { min, max }: { min: number; max: number }) =>
  Number.isInteger(value) && (value as number) >= min && (value as number) <= max;

/** The workflow's settings schema, strict; what is returned is a fresh object. */
export function validatePaletteSettings(
  operation: string,
  settings: unknown,
): Result<Record<string, unknown>> {
  if (!isRecord(settings)) return fail('settings must be an object');
  if (operation === 'extract') {
    const extra = extraKey(settings, ['count', 'alphaThreshold']);
    if (extra) return fail(`settings.${extra} is not a known setting`);
    const { count, alphaThreshold } = settings;
    if (!isIntIn(count, EXTRACT_COUNT)) {
      return fail(`count must be ${EXTRACT_COUNT.min}–${EXTRACT_COUNT.max}`);
    }
    if (!isIntIn(alphaThreshold, ALPHA_THRESHOLD)) {
      return fail(`alphaThreshold must be ${ALPHA_THRESHOLD.min}–${ALPHA_THRESHOLD.max}`);
    }
    return ok({ count, alphaThreshold });
  }
  if (operation === 'effect') {
    const extra = extraKey(settings, ['name', 'strength', 'adjustments']);
    if (extra) return fail(`settings.${extra} is not a known setting`);
    const name = validateName(settings['name']);
    if (!name.ok) return name;
    const { strength, adjustments } = settings;
    if (
      typeof strength !== 'number' ||
      !Number.isFinite(strength) ||
      strength < 0 ||
      strength > 1
    ) {
      return fail('strength must be 0 to 1');
    }
    if (
      !Array.isArray(adjustments) ||
      new Set(adjustments).size !== adjustments.length ||
      !adjustments.every((item) => PALETTE_ADJUSTMENTS.includes(item as PaletteAdjustment))
    ) {
      return fail(`adjustments must be distinct entries of ${PALETTE_ADJUSTMENTS.join(', ')}`);
    }
    return ok({ name: name.value, strength, adjustments: [...adjustments] });
  }
  return fail(`Unknown operation "${operation}"`);
}

// --- Host text --------------------------------------------------------------------

/**
 * The panel's translation keys (`palette.<name>`), all in `TRANSLATION_KEYS`.
 */
export const PALETTE_KEYS = [
  'command',
  'image',
  'choose',
  'remove',
  'imageInfo',
  'count',
  'alphaThreshold',
  'noVisible',
  'extracting',
  'swatches',
  'unordered',
  'gradient',
  'interpolation',
  'interpOklab',
  'interpLinear',
  'interpSrgb',
  'stop',
  'position',
  'color',
  'moveUp',
  'moveDown',
  'removeStop',
  'addStop',
  'fromSwatches',
  'stopsNote',
  'name',
  'file',
  'exportJson',
  'importJson',
  'exported',
  'imported',
  'effect',
  'strength',
  'adjustContrast',
  'adjustShift',
  'needsShader',
  'previewing',
  'compiles',
  'samples',
  'apply',
  'stale',
  'staleDelivery',
] as const;
export type PaletteKeyName = (typeof PALETTE_KEYS)[number];

/** A panel key; the compiler checks that every one is a `TranslationKey`. */
export const paletteKey = (name: PaletteKeyName): TranslationKey => `palette.${name}` as const;
