/**
 * Texture Utilities (`texture-utilities/v1`): the host's half of the workflow,
 * without the panel — operation settings and their validation (what reaches
 * the Worker; in `textures-settings`, re-exported here), how a request is built from the selected images, the edge
 * differences of a tiled preview, and the sidecar record of a result.
 *
 * The Worker (`plugins/official/texture-utilities`) only does arithmetic on
 * equal-sized planes. The host resamples every selected image to the chosen
 * output size first (`textures-image-bridge`), so mismatched inputs are made to
 * agree here, by the policy the user picked, and never inside the Worker.
 */
import { TOOL_LIMITS, type AssetToolRequest, type ImageUsage } from '@shadergrove/shared/plugin';

import type { TranslationKey } from '../../i18n/keys';
import {
  fitWithin,
  resampleImage,
  type BridgeImage,
  type ResampleFilter,
} from './textures-image-bridge';
import {
  CHANNEL_NAMES,
  textureKey,
  type ChannelName,
  type ChannelSource,
  type NormalSettings,
  type TextureOperation,
} from './textures-settings';

export * from './textures-settings';

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
