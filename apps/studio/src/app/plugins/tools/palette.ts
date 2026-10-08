/**
 * Palette Studio (`palette-studio/v1`): the host's half of the workflow,
 * without the panel — operation settings and their validation (what reaches
 * the Worker), the requests, the gradient editor's stop rules, palette JSON in
 * and out, and the guarded Apply.
 *
 * The Worker (`plugins/official/palette-studio`) does the colour arithmetic:
 * extraction, conversions and the generated GLSL. The host never converts
 * colours; it samples the picked image through the shared image bridge, keeps
 * the user's palette as `shadergrove-palette/v1` data (the authoring source of
 * every effect made from it) and adopts effects through `EffectAdoption`.
 */
import {
  PALETTE_FORMAT,
  TOOL_LIMITS,
  validateEffectCandidate,
  validatePalette,
  type AssetToolOutput,
  type EffectCandidate,
  type AssetToolRequest,
  type GradientInterpolation,
  type GradientStop,
  type PaletteData,
} from '@shadergrove/shared/plugin';
import { fail, ok, validateName, type Result } from '@shadergrove/shared/validate';

import type { TranslationKey } from '../../i18n/keys';
import type { AdoptionResult } from '../effect-adoption';
import type { ToolDelivery, ToolSession } from '../plugin-tools';
import type { BridgeImage } from './textures-image-bridge';

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

// --- Requests ---------------------------------------------------------------------

/** How many pixels of a plane are at least as opaque as the threshold. */
export function visiblePixels(plane: BridgeImage, threshold: number): number {
  let count = 0;
  for (let index = 3; index < plane.rgba.length; index += 4) {
    if (plane.rgba[index]! >= threshold) count++;
  }
  return count;
}

/** Extraction runs on the bounded sample (`previewImage`, ≤ 256×256) the panel made on pick. */
export function extractRequest(sample: BridgeImage, settings: ExtractSettings): AssetToolRequest {
  return { operation: 'extract', preview: true, planes: [sample], settings: { ...settings } };
}

export function effectRequest(palette: PaletteData, settings: EffectSettings): AssetToolRequest {
  return {
    operation: 'effect',
    palette,
    settings: {
      name: palette.name,
      strength: settings.strength,
      adjustments: [...settings.adjustments],
    },
  };
}

// --- Gradient editing -------------------------------------------------------------

const roundPosition = (value: number) =>
  Math.round(Math.min(1, Math.max(0, value)) * 10000) / 10000;

/**
 * Stops in position order. The sort is stable: stops at one position keep
 * the order they were listed in, and the first of them ends the part of the
 * gradient below that position, the next starts the part above (a hard edge).
 */
export const sortStops = (stops: readonly GradientStop[]): GradientStop[] =>
  stops
    .map((stop, index) => ({ stop, index }))
    .sort((a, b) => a.stop.position - b.stop.position || a.index - b.index)
    .map(({ stop }) => stop);

/** Colours as evenly spaced stops, in the order given (one colour fills both ends). */
export function evenStops(colors: readonly string[]): GradientStop[] {
  const list = colors.length === 1 ? [colors[0]!, colors[0]!] : colors;
  return list
    .slice(0, TOOL_LIMITS.paletteColors)
    .map((color, index, all) => ({ position: roundPosition(index / (all.length - 1)), color }));
}

export function setStopPosition(stops: readonly GradientStop[], index: number, position: number) {
  if (!Number.isFinite(position)) return [...stops];
  return sortStops(
    stops.map((stop, at) => (at === index ? { ...stop, position: roundPosition(position) } : stop)),
  );
}

export function setStopColor(stops: readonly GradientStop[], index: number, color: string) {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return [...stops];
  return stops.map((stop, at) => (at === index ? { ...stop, color: color.toLowerCase() } : stop));
}

/** Reordering swaps colours with the neighbour; positions stay where they are, so the order holds. */
export function moveStop(stops: readonly GradientStop[], index: number, by: -1 | 1) {
  const other = index + by;
  if (other < 0 || other >= stops.length) return [...stops];
  return stops.map((stop, at) =>
    at === index
      ? { ...stop, color: stops[other]!.color }
      : at === other
        ? { ...stop, color: stops[index]!.color }
        : stop,
  );
}

export function removeStop(stops: readonly GradientStop[], index: number) {
  return stops.length <= 2 ? [...stops] : stops.filter((_, at) => at !== index);
}

/** A new stop in the middle of the widest gap, with the colour of the stop before it. */
export function addStop(stops: readonly GradientStop[]) {
  if (stops.length >= TOOL_LIMITS.paletteColors) return [...stops];
  let gap = 1;
  for (let at = 2; at < stops.length; at++) {
    if (
      stops[at]!.position - stops[at - 1]!.position >
      stops[gap]!.position - stops[gap - 1]!.position
    ) {
      gap = at;
    }
  }
  const [before, after] = [stops[gap - 1]!, stops[gap]!];
  const added = {
    position: roundPosition((before.position + after.position) / 2),
    color: before.color,
  };
  return [...stops.slice(0, gap), added, ...stops.slice(gap)];
}

/** The gradient as CSS, interpolated in the same space the effect uses (for display only). */
export function gradientCss(gradient: NonNullable<PaletteData['gradient']>): string {
  const space = { oklab: 'oklab', linear: 'srgb-linear', srgb: 'srgb' }[gradient.interpolation];
  const stops = gradient.stops.map((stop) => `${stop.color} ${stop.position * 100}%`);
  return `linear-gradient(in ${space} to right, ${stops.join(', ')})`;
}

// --- Palette JSON -----------------------------------------------------------------

export const DEFAULT_PALETTE: PaletteData = {
  format: PALETTE_FORMAT,
  name: 'Palette',
  colors: [],
  gradient: {
    interpolation: 'oklab',
    stops: [
      { position: 0, color: '#000000' },
      { position: 1, color: '#ffffff' },
    ],
  },
};

/** A palette file read back: validated, and given evenly spaced stops if it has no gradient. */
export function parsePaletteJson(text: string): Result<PaletteData> {
  if (text.length > PALETTE_FILE_BYTES) return fail('The file is too large to be a palette.');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail('The file is not JSON.');
  }
  const palette = validatePalette(json);
  if (!palette.ok) return palette;
  return ok(
    palette.value.gradient
      ? palette.value
      : {
          ...palette.value,
          gradient: { interpolation: 'oklab', stops: evenStops(palette.value.colors) },
        },
  );
}

/** The file a palette is saved as: exactly what `validatePalette` accepts, nothing else. */
export function paletteJson(palette: PaletteData): Result<string> {
  const valid = validatePalette(palette);
  return valid.ok ? ok(`${JSON.stringify(valid.value, null, 2)}\n`) : valid;
}

/** The CPU gradient samples an effect result carries, if they are what they claim to be. */
export function gradientSamples(output: AssetToolOutput | undefined): string[] | null {
  if (output?.kind !== 'effect') return null;
  const samples = output.metadata['samples'];
  return Array.isArray(samples) &&
    samples.length >= 2 &&
    samples.length <= 256 &&
    samples.every((sample) => typeof sample === 'string' && /^#[0-9a-f]{6}$/.test(sample))
    ? (samples as string[])
    : null;
}

// --- Apply ------------------------------------------------------------------------

/**
 * Copy the session's effect into the open shader, only if the result still
 * holds: revalidated here, then probed and copied by `adopt` (`EffectAdoption`)
 * with nothing awaited in between. The shader keeps the copy, whatever then
 * happens to the plugin.
 */
export function applyPaletteEffect(
  session: ToolSession,
  adopt: (candidate: EffectCandidate) => AdoptionResult,
): Promise<ToolDelivery<{ result: AdoptionResult; name: string }>> {
  return session.deliver(async (value, check) => {
    if (!('kind' in value) || value.kind !== 'effect')
      throw new Error('This result is not an effect');
    const candidate = validateEffectCandidate(value.effect);
    if (!candidate.ok) throw new Error(candidate.errors[0] ?? 'The effect is invalid');
    check();
    return { result: adopt(candidate.value), name: candidate.value.name };
  });
}

// --- Host text --------------------------------------------------------------------

/**
 * The panel's translation keys (`palette.<name>`). The coordinator adds them to
 * `TRANSLATION_KEYS` and the dictionaries; until then a lookup shows the key.
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

/** A panel key, typed as one the coordinator will add (see `PALETTE_KEYS`). */
export const paletteKey = (name: PaletteKeyName): TranslationKey =>
  `palette.${name}` as TranslationKey;
