/**
 * Palette Studio — the Worker side of `palette-studio/v1`.
 *
 * The host decodes and samples the picked image (straight alpha, sRGB-encoded
 * bytes, at most 256×256), validates every setting and the palette, draws the
 * panel and applies effects. This code only computes, deterministically: the
 * same plane, palette and settings always give the same answer.
 *
 * Operations (settings are validated by the host adapter before they arrive):
 *
 * - `extract` — `{ count: 4–8, alphaThreshold: 1–255 }` on one plane. Pixels
 *   whose alpha is below the threshold are ignored; the others count with
 *   weight `alpha / 255`. Distinct colours are clustered in Oklab by weighted
 *   k-means: seeded greedily (the heaviest colour first, then each time the
 *   colour with the largest `weight × squared distance` to its nearest seed;
 *   ties go to the colour seen first in row order), then at most 32 Lloyd
 *   iterations (ties go to the lower cluster), stopping as soon as no colour
 *   changes cluster. An image with fewer distinct visible colours gives fewer
 *   colours. The palette is unordered: `colors` lists clusters by weight,
 *   heaviest first (equal weights: darker first). The gradient is a
 *   *suggestion*: the same colours by Oklab lightness, evenly spaced,
 *   interpolated in Oklab.
 * - `effect` — `{ name, strength: 0–1, adjustments: ("contrast" | "shift")[] }`
 *   with a palette that has a gradient. Returns a custom effect (API v1) that
 *   maps each pixel's luminance onto the gradient, with the stops embedded in
 *   the GLSL (no texture, no extra sampler), and controls `strength` plus the
 *   chosen adjustments. Its metadata carries the stops in the interpolation
 *   space and 33 CPU samples of the gradient — the same arithmetic as the GLSL.
 *
 * Colour handling, stated once and used by both the CPU and the GLSL code:
 *
 * - Bytes and `#rrggbb` are sRGB-encoded. `linear` is the IEC 61966-2-1 decode
 *   (`c < 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ^ 2.4`), encoding is its
 *   inverse (breakpoint 0.0031308).
 * - Oklab is computed from linear sRGB with the matrices of the reference
 *   implementation.
 * - Gradients interpolate componentwise in the chosen space (`srgb`: encoded
 *   values, `linear`: linear RGB, `oklab`: L, a, b). Gamut policy: a colour
 *   is clipped per channel to 0–1 in linear RGB, then encoded (for `srgb`, the
 *   encoded value is clipped). Never hue-preserving, always deterministic.
 * - Stops are sorted by the host; equal positions make a hard edge: the stop
 *   listed first ends the part below, the one listed later starts the part above.
 * - The effect reads `color.rgb` as sRGB-encoded display values, clipped to
 *   0–1. `t = cbrt(Y)` with `Y = 0.2126 R + 0.7152 G + 0.0722 B` of the linear
 *   colour — the Oklab lightness of a grey of that luminance. `contrast`
 *   scales `t` about 0.5, `shift` adds to it, and the result is clamped to 0–1.
 *   `strength` mixes the encoded input and gradient colours; alpha is kept.
 *
 * Provenance and licences:
 * - sRGB transfer function: IEC 61966-2-1:1999.
 * - Oklab: Björn Ottosson, "A perceptual color space for image processing"
 *   (2020), https://bottosson.github.io/posts/oklab/ — matrix constants from
 *   its reference code, which the author placed in the public domain (or, at
 *   your option, the MIT licence).
 * - Luminance weights: ITU-R BT.709.
 * - Clustering: Lloyd's k-means (S. P. Lloyd, 1957/1982), seeded like
 *   k-means++ (Arthur & Vassilvitskii, 2007) without its randomness.
 * The code itself is this package's, Apache-2.0.
 */
import type { AssetToolInput, GradientStop, PaletteData } from '@shadergrove/shared/plugin';

type Vec3 = [number, number, number];
type Space = 'srgb' | 'linear' | 'oklab';

interface ExtractSettings {
  count: number;
  alphaThreshold: number;
}

interface EffectSettings {
  name: string;
  strength: number;
  adjustments: ('contrast' | 'shift')[];
}

const MAX_ITERATIONS = 32;
const SAMPLES = 33;

// --- Colour -----------------------------------------------------------------------

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const toLinear = (c: number): number => (c < 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const encode = (c: number): number => {
  const v = clamp01(c);
  return v < 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
};

function linearToOklab([r, g, b]: Vec3): Vec3 {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToLinear([L, a, b]: Vec3): Vec3 {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const fromHex = (hex: string): Vec3 =>
  [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255) as Vec3;
const toHex = (encoded: Vec3): string =>
  `#${encoded
    .map((v) =>
      Math.round(clamp01(v) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;

/** Into the interpolation space from encoded sRGB, and back to encoded sRGB (clipped). */
const SPACES: Record<Space, { from: (rgb: Vec3) => Vec3; to: (value: Vec3) => Vec3 }> = {
  srgb: { from: (rgb) => rgb, to: (v) => v.map(clamp01) as Vec3 },
  linear: {
    from: (rgb) => rgb.map(toLinear) as Vec3,
    to: (v) => v.map(encode) as Vec3,
  },
  oklab: {
    from: (rgb) => linearToOklab(rgb.map(toLinear) as Vec3),
    to: (v) => oklabToLinear(v).map(encode) as Vec3,
  },
};

const distance2 = (a: Vec3, b: Vec3): number =>
  (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

// --- Extraction -------------------------------------------------------------------

function extract(input: AssetToolInput, settings: ExtractSettings) {
  const plane = input.planes[0];
  if (!plane || input.planes.length !== 1) throw new Error('extract takes exactly one image');
  const bytes = new Uint8Array(plane.rgba);
  const linear = Array.from({ length: 256 }, (_, byte) => toLinear(byte / 255));

  // Distinct visible colours, in first-seen order, each with its summed alpha weight.
  const seen = new Map<number, number>();
  const points: { lab: Vec3; weight: number }[] = [];
  let visible = 0;
  for (let index = 0; index < bytes.length; index += 4) {
    const alpha = bytes[index + 3]!;
    if (alpha < settings.alphaThreshold) continue;
    visible++;
    const [r, g, b] = [bytes[index]!, bytes[index + 1]!, bytes[index + 2]!];
    const key = (r << 16) | (g << 8) | b;
    let at = seen.get(key);
    if (at === undefined) {
      at = points.length;
      seen.set(key, at);
      points.push({ lab: linearToOklab([linear[r]!, linear[g]!, linear[b]!]), weight: 0 });
    }
    points[at]!.weight += alpha / 255;
  }
  if (points.length === 0) {
    throw new Error('No visible pixels: every pixel is more transparent than the alpha threshold.');
  }

  // Seeds: the heaviest colour, then greedily the one farthest (weighted) from every seed.
  const k = Math.min(settings.count, points.length);
  let first = 0;
  points.forEach((point, index) => {
    if (point.weight > points[first]!.weight) first = index;
  });
  const centres: Vec3[] = [[...points[first]!.lab]];
  const nearest = points.map((point) => distance2(point.lab, centres[0]!));
  while (centres.length < k) {
    let best = -1;
    let score = 0;
    points.forEach((point, index) => {
      const value = point.weight * nearest[index]!;
      if (value > score) [best, score] = [index, value];
    });
    if (best < 0) break;
    const seed: Vec3 = [...points[best]!.lab];
    centres.push(seed);
    points.forEach((point, index) => {
      nearest[index] = Math.min(nearest[index]!, distance2(point.lab, seed));
    });
  }

  // Lloyd iterations on the weighted colours.
  const cluster = new Int32Array(points.length).fill(-1);
  let iterations = 0;
  while (iterations < MAX_ITERATIONS) {
    iterations++;
    let changed = false;
    points.forEach((point, index) => {
      let best = 0;
      for (let c = 1; c < centres.length; c++) {
        if (distance2(point.lab, centres[c]!) < distance2(point.lab, centres[best]!)) best = c;
      }
      if (cluster[index] !== best) [cluster[index], changed] = [best, true];
    });
    if (!changed) break;
    const sums = centres.map(() => [0, 0, 0, 0]);
    points.forEach((point, index) => {
      const sum = sums[cluster[index]!]!;
      for (let axis = 0; axis < 3; axis++) sum[axis]! += point.lab[axis]! * point.weight;
      sum[3]! += point.weight;
    });
    // A cluster left empty keeps its centre.
    sums.forEach((sum, c) => {
      if (sum[3]! > 0) centres[c] = [sum[0]! / sum[3]!, sum[1]! / sum[3]!, sum[2]! / sum[3]!];
    });
  }

  const weights = centres.map(() => 0);
  points.forEach((point, index) => (weights[cluster[index]!]! += point.weight));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const entries = centres
    .map((lab, index) => ({ lab, weight: weights[index]!, hex: toHex(SPACES.oklab.to(lab)) }))
    .sort((a, b) => b.weight - a.weight || a.lab[0] - b.lab[0])
    .filter((entry, index, all) => all.findIndex((other) => other.hex === entry.hex) === index);

  const byLightness = [...entries].sort((a, b) => a.lab[0] - b.lab[0]);
  if (byLightness.length === 1) byLightness.push(byLightness[0]!);
  const stops: GradientStop[] = byLightness.map((entry, index) => ({
    position: Math.round((index / (byLightness.length - 1)) * 10000) / 10000,
    color: entry.hex,
  }));

  const palette: PaletteData = {
    format: 'shadergrove-palette/v1',
    name: 'Extracted palette',
    colors: entries.map((entry) => entry.hex),
    gradient: { interpolation: 'oklab', stops },
  };
  return {
    kind: 'palette',
    palette,
    metadata: {
      weights: entries.map((entry) => Math.round((entry.weight / total) * 10000) / 10000),
      visiblePixels: visible,
      ignoredPixels: bytes.length / 4 - visible,
      distinctColors: points.length,
      iterations,
    },
  };
}

// --- Effect -----------------------------------------------------------------------

/** Six decimals, as the GLSL literal and the CPU value alike, so both compute the same. */
const round6 = (value: number): number => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return rounded === 0 ? 0 : rounded;
};
const literal = (value: number): string => round6(value).toFixed(6);
const vec3 = (value: Vec3): string => `vec3(${value.map(literal).join(', ')})`;

interface Stop {
  position: number;
  value: Vec3;
}

/** The CPU twin of the GLSL `pgGradient`: the value in the interpolation space at `t`. */
function gradientAt(stops: readonly Stop[], t: number): Vec3 {
  if (t <= stops[0]!.position) return stops[0]!.value;
  for (let index = 1; index < stops.length; index++) {
    const [a, b] = [stops[index - 1]!, stops[index]!];
    if (b.position > a.position && t <= b.position) {
      const f = (t - a.position) / (b.position - a.position);
      return a.value.map((v, axis) => v + (b.value[axis]! - v) * f) as Vec3;
    }
  }
  return stops.at(-1)!.value;
}

const GLSL_LINEAR = `vec3 pgLinear(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}`;

const GLSL_ENCODE = `vec3 pgEncode(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}`;

const GLSL_OKLAB = `vec3 pgOklabToLinear(vec3 lab) {
  float l = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
  float m = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
  float s = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
  l = l * l * l;
  m = m * m * m;
  s = s * s * s;
  return vec3(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}`;

const GLSL_OUT: Record<Space, string> = {
  srgb: 'vec3 pgOut(vec3 v) { return clamp(v, 0.0, 1.0); }',
  linear: 'vec3 pgOut(vec3 v) { return pgEncode(v); }',
  oklab: 'vec3 pgOut(vec3 v) { return pgEncode(pgOklabToLinear(v)); }',
};

/** The palette as one line of ASCII JSON, kept in the effect as its authoring source. */
const asciiJson = (palette: PaletteData): string =>
  JSON.stringify(palette).replace(
    /[^\x20-\x7e]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

function effectSource(
  palette: PaletteData,
  space: Space,
  stops: readonly Stop[],
  settings: EffectSettings,
): string {
  const segments = stops.flatMap((stop, index) => {
    const before = stops[index - 1];
    if (!before)
      return [`  if (t <= ${literal(stop.position)}) return pgOut(${vec3(stop.value)});`];
    if (stop.position <= before.position) return [];
    return [
      `  if (t <= ${literal(stop.position)}) return pgOut(mix(${vec3(before.value)}, ${vec3(stop.value)}, (t - ${literal(before.position)}) / ${literal(stop.position - before.position)}));`,
    ];
  });
  const adjust = [
    ...(settings.adjustments.includes('contrast') ? ['  t = (t - 0.5) * u_contrast + 0.5;'] : []),
    ...(settings.adjustments.includes('shift') ? ['  t += u_shift;'] : []),
  ];
  return [
    '// Palette Studio luminance map. Generated: edit the palette, not this code.',
    `// ${asciiJson(palette)}`,
    `// Interpolation: ${space}. t = cbrt(Y), Y = BT.709 luminance of the linearised sRGB input.`,
    GLSL_LINEAR,
    GLSL_ENCODE,
    ...(space === 'oklab' ? [GLSL_OKLAB] : []),
    GLSL_OUT[space],
    'vec3 pgGradient(float t) {',
    ...segments,
    `  return pgOut(${vec3(stops.at(-1)!.value)});`,
    '}',
    'vec4 effect(vec4 color, vec2 uv) {',
    '  float t = pow(max(dot(pgLinear(color.rgb), vec3(0.2126, 0.7152, 0.0722)), 0.0), 1.0 / 3.0);',
    ...adjust,
    '  vec3 mapped = pgGradient(clamp(t, 0.0, 1.0));',
    '  return vec4(mix(color.rgb, mapped, u_strength), color.a);',
    '}',
    '',
  ].join('\n');
}

function effect(input: AssetToolInput, settings: EffectSettings) {
  const palette = input.palette;
  const gradient = palette?.gradient;
  if (!palette || !gradient) throw new Error('The effect needs a palette with a gradient');
  const space = gradient.interpolation;
  const stops: Stop[] = gradient.stops.map((stop) => ({
    position: round6(stop.position),
    value: SPACES[space].from(fromHex(stop.color)).map(round6) as Vec3,
  }));
  const named: PaletteData = { ...palette, name: settings.name };
  const controls = [
    {
      key: 'strength',
      label: 'Strength',
      type: 'number',
      min: 0,
      max: 1,
      step: 0.01,
      default: settings.strength,
    },
    ...(settings.adjustments.includes('contrast')
      ? [
          {
            key: 'contrast',
            label: 'Contrast',
            type: 'number',
            min: 0,
            max: 4,
            step: 0.01,
            default: 1,
          },
        ]
      : []),
    ...(settings.adjustments.includes('shift')
      ? [{ key: 'shift', label: 'Shift', type: 'number', min: -1, max: 1, step: 0.01, default: 0 }]
      : []),
  ];
  return {
    kind: 'effect',
    effect: {
      name: settings.name,
      source: effectSource(named, space, stops, settings),
      controls,
      values: Object.fromEntries(controls.map((control) => [control.key, control.default])),
    },
    metadata: {
      interpolation: space,
      stops: stops.map((stop) => ({ position: stop.position, value: stop.value })),
      samples: Array.from({ length: SAMPLES }, (_, index) =>
        toHex(SPACES[space].to(gradientAt(stops, index / (SAMPLES - 1)))),
      ),
    },
  };
}

shaderStudio.handle('assetTool:palette-studio', (params) => {
  const input = params as AssetToolInput;
  if (input.operation === 'extract')
    return extract(input, input.settings as unknown as ExtractSettings);
  if (input.operation === 'effect')
    return effect(input, input.settings as unknown as EffectSettings);
  throw new Error(`Unknown operation "${input.operation}"`);
});
