import type * as THREE from 'three';

import type { ChannelBinding } from '@shadergrove/shared';

import { CHANNEL_UNIFORMS } from './engine/channel-binder';
import type { PassRuntime } from './engine/pass-compiler';
import { CHANNEL_COUNT, type TextureManager } from './engine/texture-manager';
import type { GlContext, ThreeModule } from './gl-context';
import type { BufferTargets } from './pass-targets';

/**
 * An immutable, bounded snapshot of one actual live frame.
 *
 * ```ts
 * const frame = await engine.captureFrame({ signal });   // the next frame drawn
 * frame.passes[1].inputs[0];                              // what iChannel0 really sampled
 * frame.read(frame.passes[1].output.rawImageId!, { x, y, width: 1, height: 1 });
 * frame.release();                                        // idempotent
 * ```
 *
 * A capture is taken *at the draw boundary*: after a pass's channels are bound
 * and before it is drawn, the texels it is about to sample are copied out, along
 * with a deep copy of every uniform. That is the only moment the answer to "what
 * did this pass see" exists — buffer targets ping-pong and are overwritten in
 * render order, so a lookup after the frame cannot reconstruct it.
 *
 * Nothing here is shared with the renderer afterwards: texels are copied into
 * arrays this snapshot owns, uniforms are cloned, and accepted sources are the
 * compiler's frozen records — a newer draft that failed to compile is never
 * substituted. Typed arrays stay private; `read()` hands out copies.
 *
 * Texel precision is never reduced. Half-float buffers are stored as their raw
 * half bits (`rgba16f`), 8-bit image slots as bytes (`rgba8`), and the replayed
 * raw Image output as 32-bit floats (`rgba32f`). If the driver cannot read that
 * back losslessly the capture fails with `unsupported` rather than substituting
 * RGBA8. Rows are in GL order: y = 0 is the bottom row, as in `gl_FragCoord`.
 *
 * Limits: one retained snapshot, one pending request, 128 MiB of retained plus
 * temporary CPU/GPU payload (preflighted from exact sizes, nothing downsampled),
 * 5 s default timeout. The renderer does no capture work at all while no
 * request is pending.
 */

export const CAPTURE_BUDGET_BYTES = 128 * 1024 * 1024;
export const CAPTURE_TIMEOUT_MS = 5_000;

export type CaptureErrorCode =
  | 'aborted'
  | 'timeout'
  | 'released'
  | 'invalidated'
  | 'busy'
  | 'retained'
  | 'offline'
  | 'context'
  | 'disposed'
  | 'budget'
  | 'unsupported'
  | 'readback'
  | 'precision'
  | 'replay-mismatch'
  | 'no-renderer';

export class FrameCaptureError extends Error {
  constructor(
    readonly code: CaptureErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FrameCaptureError';
  }
}

/** Why a retained or pending capture ended without the caller asking. */
export type InvalidationReason =
  | 'resize'
  | 'context-lost'
  | 'project'
  | 'export'
  | 'disposed'
  | 'active-context';

export interface CaptureOptions {
  signal?: AbortSignal;
  /** Milliseconds to wait for a frame to be drawn. Defaults to `CAPTURE_TIMEOUT_MS`. */
  timeoutMs?: number;
}

// -----------------------------------------------------------------------------
// The snapshot's shape
// -----------------------------------------------------------------------------

export type TexelFormat = 'rgba8' | 'rgba16f' | 'rgba32f';
export type ImageOrigin = 'image-slot' | 'buffer-output' | 'image-raw-replay' | 'canvas-display';

const BYTES_PER_TEXEL: Record<TexelFormat, number> = { rgba8: 4, rgba16f: 8, rgba32f: 16 };
const FLOAT_TEXEL_BYTES = 16;

export type UniformValue = number | boolean | string | readonly UniformValue[];

export interface CapturedImage {
  readonly id: string;
  readonly origin: ImageOrigin;
  readonly width: number;
  readonly height: number;
  readonly format: TexelFormat;
  readonly bytes: number;
}

export interface CapturedSampling {
  readonly wrapS: number;
  readonly wrapT: number;
  readonly minFilter: number;
  readonly magFilter: number;
  readonly wrap: 'clamp' | 'repeat' | 'mirror' | 'unknown';
  readonly filter: 'nearest' | 'linear' | 'unknown';
  readonly flipY: boolean;
  readonly colorSpace: string;
  readonly mipmaps: false;
}

export interface CapturedInput {
  readonly channel: number;
  /** The binding as the project wrote it. */
  readonly binding: ChannelBinding;
  readonly source: 'none' | 'buffer-current' | 'buffer-previous' | 'image-slot';
  readonly state: 'captured' | 'unbound' | 'empty-slot' | 'loading' | 'failed' | 'missing-buffer';
  /** Why there are no texels, or null when there are. */
  readonly reason: string | null;
  /** What the sampler really read: the texels, the shared placeholder, or the renderer's empty texture. */
  readonly effective: 'texels' | 'placeholder-transparent' | 'renderer-empty-texture';
  readonly imageId: string | null;
  readonly sampling: CapturedSampling;
}

export type ReplayComparison =
  | {
      readonly status: 'match';
      readonly maxDelta: number;
      readonly comparedChannels: 3 | 4;
      readonly skippedNonFinite: number;
    }
  | { readonly status: 'not-comparable'; readonly reason: string };

export interface CapturedOutput {
  /** Raw, untransformed data: the buffer's target, or the labelled replay of the Image pass. */
  readonly rawImageId: string | null;
  readonly rawOrigin: 'buffer-target' | 'frozen-replay' | 'unavailable';
  readonly rawUnavailableReason: string | null;
  /** The canvas as displayed, after post-processing and 8-bit quantisation. Image pass only. */
  readonly displayImageId: string | null;
  /** Replay versus the live canvas. Image pass only. */
  readonly comparison: ReplayComparison | null;
}

export interface CapturedAccepted {
  readonly fingerprint: string;
  /** The revision this exact program was last accepted at. */
  readonly revision: number | null;
  /** True when a newer requested revision exists that this program is not. */
  readonly stale: boolean;
  readonly composedFragment: string;
  readonly fragment: string;
  readonly composedVertex: string;
  readonly vertex: string;
  readonly spans: PassRuntime['accepted']['spans'];
}

export interface CapturedPass {
  readonly index: number;
  readonly id: string;
  readonly kind: 'image' | 'buffer';
  readonly accepted: CapturedAccepted;
  /** The target this pass drew into, in device pixels. */
  readonly resolution: { readonly width: number; readonly height: number };
  readonly uniforms: Readonly<Record<string, UniformValue>>;
  readonly inputs: readonly CapturedInput[];
  readonly output: CapturedOutput;
}

export interface FrameIdentity {
  readonly contextId: string;
  /** Bumps each time the context is restored: programs and targets were rebuilt. */
  readonly contextGeneration: number;
  readonly projectId: string | null;
  /** Bumps each time the project changes. */
  readonly projectGeneration: number;
  /** The newest revision asked for, which a failed draft may leave ahead of every pass. */
  readonly requestedRevision: number | null;
}

export interface ImageRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageRead {
  readonly width: number;
  readonly height: number;
  readonly format: TexelFormat;
  /** Bytes for `rgba8`; exactly-widened float32 values for `rgba16f` and `rgba32f`. */
  readonly data: Uint8Array | Float32Array;
}

type StoredData = Uint8Array | Uint16Array | Float32Array;

interface Stored {
  readonly meta: CapturedImage;
  readonly data: StoredData;
}

// -----------------------------------------------------------------------------
// Half-float conversion (exact, or an error)
// -----------------------------------------------------------------------------

const scratchFloat = new Float32Array(1);
const scratchBits = new Uint32Array(scratchFloat.buffer);

export function halfToFloat(half: number): number {
  const sign = half & 0x8000 ? -1 : 1;
  const exponent = (half >> 10) & 0x1f;
  const mantissa = half & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 0x1f) return mantissa ? NaN : sign * Infinity;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

function floatToHalf(value: number): number {
  scratchFloat[0] = value;
  const bits = scratchBits[0];
  const sign = (bits >>> 16) & 0x8000;
  let exponent = (bits >>> 23) & 0xff;
  let mantissa = bits & 0x7fffff;

  if (exponent === 0xff) return sign | 0x7c00 | (mantissa ? 0x200 | (mantissa >>> 13) : 0);

  exponent = exponent - 127 + 15;
  if (exponent >= 0x1f) return sign | 0x7c00;
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    mantissa |= 0x800000;
    return sign | (mantissa >>> (14 - exponent));
  }
  return sign | (exponent << 10) | (mantissa >>> 13);
}

/** Half bits for float32 values that came from a half-float buffer; anything inexact is refused. */
function encodeHalf(source: Float32Array): Uint16Array {
  const out = new Uint16Array(source.length);
  for (let index = 0; index < source.length; index++) {
    const value = source[index];
    const half = floatToHalf(value);
    if (
      !Object.is(halfToFloat(half), value) &&
      !(Number.isNaN(value) && Number.isNaN(halfToFloat(half)))
    ) {
      throw new FrameCaptureError(
        'precision',
        'A half-float texel read back from the GPU is not exactly representable as half.',
      );
    }
    out[index] = half;
  }
  return out;
}

function encodeBytes(source: Float32Array): Uint8Array {
  const out = new Uint8Array(source.length);
  for (let index = 0; index < source.length; index++) out[index] = Math.round(source[index] * 255);
  return out;
}

// -----------------------------------------------------------------------------
// Uniforms: owned copies only
// -----------------------------------------------------------------------------

function cloneUniform(value: unknown, name: string): unknown {
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => cloneUniform(item, name));
  if (ArrayBuffer.isView(value)) return (value as unknown as { slice(): unknown }).slice();
  if (value && typeof value === 'object') {
    if ((value as { isTexture?: boolean }).isTexture) {
      throw new FrameCaptureError(
        'unsupported',
        `Uniform "${name}" is a texture outside iChannel0–3.`,
      );
    }
    const clone = (value as { clone?: () => unknown }).clone;
    if (typeof clone === 'function') return clone.call(value);
  }
  throw new FrameCaptureError('unsupported', `Uniform "${name}" cannot be copied faithfully.`);
}

function serializeUniform(value: unknown, name: string): UniformValue {
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => serializeUniform(item, name));
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record['r'] === 'number' && typeof record['g'] === 'number') {
      return [record['r'], record['g'], record['b'] as number];
    }
    if (typeof record['x'] === 'number') {
      const components = [record['x']];
      for (const key of ['y', 'z', 'w']) {
        if (typeof record[key] === 'number') components.push(record[key] as number);
      }
      return components;
    }
    if (Array.isArray(record['elements'])) return [...(record['elements'] as number[])];
  }
  throw new FrameCaptureError('unsupported', `Uniform "${name}" cannot be recorded faithfully.`);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value) && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// -----------------------------------------------------------------------------
// What a frame holds, described once for the plan and for the capture
// -----------------------------------------------------------------------------

/** Everything a capture needs from the engine, assembled only when a request is pending. */
export interface FrameSource {
  readonly identity: FrameIdentity;
  readonly passes: readonly PassRuntime[];
  readonly targets: BufferTargets;
  readonly textures: TextureManager;
  readonly frameIndex: number;
  readonly time: number;
  readonly pointer: readonly [number, number];
  readonly pointerVelocity: readonly [number, number];
  readonly resolutionScale: number;
  readonly usesComposer: boolean;
  readonly geometry: THREE.BufferGeometry;
  readonly camera: THREE.Camera;
}

interface Described {
  /** Set when texels will be copied. Equal keys share one copy. */
  readonly key: string | null;
  readonly width: number;
  readonly height: number;
  readonly format: TexelFormat;
  readonly source: CapturedInput['source'];
  readonly state: CapturedInput['state'];
  readonly reason: string | null;
  readonly effective: CapturedInput['effective'];
}

const NO_TEXELS = { key: null, width: 0, height: 0, format: 'rgba8' } as const;

/**
 * What a binding resolves to this frame. `drawn` holds the buffers already drawn
 * so far: a plain binding to one of those reads this frame's output (version 1),
 * everything else — including every feedback binding — reads what it held when
 * the frame began (version 0).
 */
function describe(
  three: ThreeModule,
  src: FrameSource,
  binding: ChannelBinding | undefined,
  drawn: ReadonlySet<string>,
  maxTextureSize: number,
): Described {
  switch (binding?.kind) {
    case 'buffer': {
      const size = src.targets.size(binding.passId);
      if (!size) {
        return {
          ...NO_TEXELS,
          source: 'none',
          state: 'missing-buffer',
          reason: `Buffer "${binding.passId}" has no render target, so the placeholder is bound.`,
          effective: 'placeholder-transparent',
        };
      }
      const version = !binding.feedback && drawn.has(binding.passId) ? 1 : 0;
      return {
        key: `buf:${binding.passId}:${version}`,
        width: size.width,
        height: size.height,
        format: 'rgba16f',
        source: binding.feedback ? 'buffer-previous' : 'buffer-current',
        state: 'captured',
        reason: null,
        effective: 'texels',
      };
    }
    case 'texture': {
      const state = src.textures.slotState(binding.slot);
      if (state === 'empty') {
        return {
          ...NO_TEXELS,
          source: 'image-slot',
          state: 'empty-slot',
          reason: `Texture slot ${binding.slot} has no image, so the placeholder is bound.`,
          effective: 'placeholder-transparent',
        };
      }
      if (state === 'loading' || state === 'failed') {
        return {
          ...NO_TEXELS,
          source: 'image-slot',
          state,
          reason:
            state === 'loading'
              ? `Texture slot ${binding.slot} is still decoding; the renderer samples its empty texture.`
              : `Texture slot ${binding.slot} failed to load; the renderer samples its empty texture.`,
          effective: 'renderer-empty-texture',
        };
      }
      const texture = src.textures.resolveSlot(binding.slot);
      const image = texture.image as { width?: number; height?: number } | undefined;
      const width = image?.width ?? 0;
      const height = image?.height ?? 0;
      if (!(width > 0 && height > 0)) {
        throw new FrameCaptureError(
          'unsupported',
          `Texture slot ${binding.slot} has no decoded dimensions to snapshot.`,
        );
      }
      if (Math.max(width, height) > maxTextureSize) {
        throw new FrameCaptureError(
          'unsupported',
          `Texture slot ${binding.slot} (${width}×${height}) exceeds the GPU texture limit ${maxTextureSize}; it would be resampled, not captured.`,
        );
      }
      if (texture.type !== three.UnsignedByteType || texture.format !== three.RGBAFormat) {
        throw new FrameCaptureError(
          'unsupported',
          `Texture slot ${binding.slot} is not RGBA8, which is the only image layout that can be read back exactly.`,
        );
      }
      if (texture.colorSpace !== three.NoColorSpace) {
        throw new FrameCaptureError(
          'unsupported',
          `Texture slot ${binding.slot} is colour-space converted on sampling (${texture.colorSpace}); a raw copy would differ from what the shader reads.`,
        );
      }
      if (
        texture.generateMipmaps ||
        (texture.minFilter !== three.NearestFilter && texture.minFilter !== three.LinearFilter) ||
        (texture.mipmaps?.length ?? 0) > 0
      ) {
        throw new FrameCaptureError(
          'unsupported',
          `Texture slot ${binding.slot} is mipmapped; only level 0 would be captured.`,
        );
      }
      return {
        key: `slot:${binding.slot}`,
        width,
        height,
        format: 'rgba8',
        source: 'image-slot',
        state: 'captured',
        reason: null,
        effective: 'texels',
      };
    }
    case 'none':
    default:
      return {
        ...NO_TEXELS,
        source: 'none',
        state: 'unbound',
        reason: 'The channel is not bound, so the placeholder is bound.',
        effective: 'placeholder-transparent',
      };
  }
}

interface Capabilities {
  readonly maxTextureSize: number;
  readonly width: number;
  readonly height: number;
}

interface Plan {
  readonly retained: number;
  readonly peak: number;
  readonly copyTemp: number;
  readonly replayTemp: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly hasSources: boolean;
}

/** The exact payload of a capture of `src`, before a single byte is allocated. */
function planFrame(three: ThreeModule, src: FrameSource, caps: Capabilities, limit: number): Plan {
  const images = new Map<string, { width: number; height: number; format: TexelFormat }>();
  const drawn = new Set<string>();
  let maxWidth = 0;
  let maxHeight = 0;
  let replayInputs = 0;

  for (const pass of src.passes) {
    const isImage = pass.kind === 'image';
    let passInputs = 0;
    for (let channel = 0; channel < CHANNEL_COUNT; channel++) {
      const input = describe(three, src, pass.channels[channel], drawn, caps.maxTextureSize);
      if (input.key === null) continue;
      if (!images.has(input.key)) images.set(input.key, input);
      passInputs += input.width * input.height * BYTES_PER_TEXEL[input.format];
    }
    if (isImage) replayInputs = passInputs;

    const size = isImage ? null : src.targets.size(pass.id);
    if (!isImage && size) {
      images.set(`buf:${pass.id}:1`, { ...size, format: 'rgba16f' });
      drawn.add(pass.id);
    }
  }

  let retained = 0;
  for (const image of images.values()) {
    if (Math.max(image.width, image.height) > caps.maxTextureSize) {
      throw new FrameCaptureError(
        'unsupported',
        `A ${image.width}×${image.height} capture exceeds the GPU texture limit ${caps.maxTextureSize}.`,
      );
    }
    retained += image.width * image.height * BYTES_PER_TEXEL[image.format];
    maxWidth = Math.max(maxWidth, image.width);
    maxHeight = Math.max(maxHeight, image.height);
  }

  const hasImage = src.passes.some((pass) => pass.kind === 'image');
  let replayTemp = 0;
  if (hasImage) {
    const frame = caps.width * caps.height;
    retained += frame * BYTES_PER_TEXEL.rgba32f + frame * BYTES_PER_TEXEL.rgba8;
    // The replay's own float target, its uploaded copies of the inputs, and the four placeholders.
    replayTemp = frame * FLOAT_TEXEL_BYTES + replayInputs + CHANNEL_COUNT * 4;
  }
  // The float target a texture is drawn into, and the CPU array it is read into.
  const copyTemp = images.size > 0 ? maxWidth * maxHeight * FLOAT_TEXEL_BYTES * 2 : 0;
  const peak = retained + Math.max(copyTemp, replayTemp);

  if (peak > limit) {
    throw new FrameCaptureError(
      'budget',
      `Capturing this frame needs ${peak} bytes of retained and temporary payload, over the ${limit}-byte limit. Nothing was captured or downsampled.`,
    );
  }
  return { retained, peak, copyTemp, replayTemp, maxWidth, maxHeight, hasSources: images.size > 0 };
}

// -----------------------------------------------------------------------------
// Reading a texture back, exactly
// -----------------------------------------------------------------------------

const COPY_VERTEX = 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }';
const COPY_FRAGMENT = `uniform sampler2D tSource;
void main() { gl_FragColor = texelFetch(tSource, ivec2(gl_FragCoord.xy), 0); }`;

type Gl = WebGL2RenderingContext;

function glOf(renderer: THREE.WebGLRenderer): Gl {
  return renderer.getContext() as Gl;
}

function drainGlErrors(gl: Gl): void {
  for (let count = 0; count < 8 && gl.getError() !== gl.NO_ERROR; count++);
}

/** Fail a complete-framebuffer assumption loudly: three does not report one, it just skips the read. */
function assertComplete(gl: Gl, what: string): void {
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    throw new FrameCaptureError(
      'unsupported',
      `The ${what} framebuffer is not complete on this GPU; float data cannot be read back.`,
    );
  }
}

/**
 * Copies a texture into one float32 render target with `texelFetch` — exact, and
 * blind to wrap, filter, flip and mipmaps — then reads the target. The float
 * target is the lossless common denominator: every 8-bit and half-float value
 * widens into it exactly.
 */
class TexelReader {
  private readonly target: THREE.WebGLRenderTarget;
  private readonly material: THREE.ShaderMaterial;
  private readonly scene: THREE.Scene;
  private readonly cpu: Float32Array;

  constructor(
    private readonly context: GlContext,
    geometry: THREE.BufferGeometry,
    private readonly camera: THREE.Camera,
    maxWidth: number,
    maxHeight: number,
  ) {
    const T = context.three;
    this.cpu = new Float32Array(maxWidth * maxHeight * 4);
    this.target = context.own(
      new T.WebGLRenderTarget(maxWidth, maxHeight, {
        type: T.FloatType,
        format: T.RGBAFormat,
        depthBuffer: false,
        stencilBuffer: false,
        minFilter: T.NearestFilter,
        magFilter: T.NearestFilter,
        generateMipmaps: false,
      }),
    );
    this.material = context.own(
      new T.ShaderMaterial({
        vertexShader: COPY_VERTEX,
        fragmentShader: COPY_FRAGMENT,
        uniforms: { tSource: { value: null } },
        depthTest: false,
        depthWrite: false,
      }),
    );
    const mesh = new T.Mesh(geometry, this.material);
    mesh.frustumCulled = false;
    this.scene = new T.Scene();
    this.scene.add(mesh);
  }

  /** A view over a reused array, valid until the next call: convert it before reading again. */
  read(texture: THREE.Texture, width: number, height: number): Float32Array {
    const renderer = this.context.renderer;
    const gl = glOf(renderer);
    if (gl.isContextLost()) throw new FrameCaptureError('context', 'The WebGL context was lost.');

    drainGlErrors(gl);
    const previous = renderer.getRenderTarget();
    this.material.uniforms['tSource'].value = texture;
    this.target.viewport.set(0, 0, width, height);
    try {
      renderer.setRenderTarget(this.target);
      assertComplete(gl, 'capture');
      renderer.render(this.scene, this.camera);
      const out = this.cpu.subarray(0, width * height * 4);
      renderer.readRenderTargetPixels(this.target, 0, 0, width, height, out);
      const error = gl.getError();
      if (error !== gl.NO_ERROR) {
        throw new FrameCaptureError(
          'readback',
          `Reading texels back failed with GL error ${error}.`,
        );
      }
      return out;
    } finally {
      this.material.uniforms['tSource'].value = null;
      renderer.setRenderTarget(previous);
    }
  }

  dispose(): void {
    this.target.dispose();
    this.material.dispose();
  }
}

// -----------------------------------------------------------------------------
// The snapshot
// -----------------------------------------------------------------------------

export class FrameSnapshot {
  readonly images: readonly CapturedImage[];
  /** More than one accepted revision is in play, or the passes lag the requested one. */
  readonly mixedRevisions: boolean;
  readonly bytes: number;
  private store: Map<string, Stored> | null;
  private done = false;

  constructor(
    readonly id: number,
    readonly identity: FrameIdentity,
    readonly frame: {
      readonly index: number;
      readonly time: number;
      readonly pointer: readonly [number, number];
      readonly pointerVelocity: readonly [number, number];
      readonly resolutionScale: number;
      readonly drawingBuffer: { readonly width: number; readonly height: number };
      readonly usesPostProcessing: boolean;
    },
    readonly passes: readonly CapturedPass[],
    store: Map<string, Stored>,
    private readonly onRelease: (snapshot: FrameSnapshot) => void,
  ) {
    // The session keys images by what they hold (for de-duplication); readers ask by id.
    this.store = new Map([...store.values()].map((stored) => [stored.meta.id, stored]));
    this.images = deepFreeze([...store.values()].map((stored) => stored.meta));
    this.bytes = this.images.reduce((sum, image) => sum + image.bytes, 0);
    const revisions = new Set(passes.map((pass) => pass.accepted.revision));
    this.mixedRevisions = revisions.size > 1 || passes.some((pass) => pass.accepted.stale);
    deepFreeze(this.identity);
    deepFreeze(this.frame);
    deepFreeze(this.passes);
  }

  get released(): boolean {
    return this.done;
  }

  image(id: string): CapturedImage {
    return this.stored(id).meta;
  }

  /** A copy of a region (default: the whole image). The caller owns it. */
  read(id: string, region?: ImageRegion): ImageRead {
    const { meta, data } = this.stored(id);
    const { x, y, width, height } = region ?? {
      x: 0,
      y: 0,
      width: meta.width,
      height: meta.height,
    };
    if (
      ![x, y, width, height].every(Number.isInteger) ||
      x < 0 ||
      y < 0 ||
      width < 1 ||
      height < 1 ||
      x + width > meta.width ||
      y + height > meta.height
    ) {
      throw new RangeError(`Region is outside the ${meta.width}×${meta.height} image.`);
    }

    const out =
      meta.format === 'rgba8'
        ? new Uint8Array(width * height * 4)
        : new Float32Array(width * height * 4);
    for (let row = 0; row < height; row++) {
      const from = ((y + row) * meta.width + x) * 4;
      const to = row * width * 4;
      for (let index = 0; index < width * 4; index++) {
        const value = data[from + index];
        out[to + index] = meta.format === 'rgba16f' ? halfToFloat(value) : value;
      }
    }
    return { width, height, format: meta.format, data: out };
  }

  /** One texel as [r, g, b, a], bottom-left origin. */
  pixel(id: string, x: number, y: number): readonly number[] {
    return Array.from(this.read(id, { x, y, width: 1, height: 1 }).data);
  }

  /** Drops every retained array. Idempotent. */
  release(): void {
    if (this.done) return;
    this.done = true;
    this.store = null;
    this.onRelease(this);
  }

  private stored(id: string): Stored {
    if (!this.store) throw new FrameCaptureError('released', 'This frame capture was released.');
    const stored = this.store.get(id);
    if (!stored) throw new RangeError(`This capture has no image "${id}".`);
    return stored;
  }
}

// -----------------------------------------------------------------------------
// One capture, inside one frame
// -----------------------------------------------------------------------------

interface ImagePassState {
  readonly pass: PassRuntime;
  readonly inputs: CapturedInput[];
  readonly clones: Record<string, unknown>;
  readonly size: { width: number; height: number };
}

/**
 * Lives for exactly one `drawFrame`. Every method is a no-op after a failure and
 * none throws: a broken capture must never break the picture. Failure disposes
 * every allocation made so far and rejects the request.
 */
export class CaptureSession {
  private readonly three: ThreeModule;
  private readonly store = new Map<string, Stored>();
  private readonly passes: CapturedPass[] = [];
  private readonly drawn = new Set<string>();
  private reader: TexelReader | null;
  private image: ImagePassState | null = null;
  private retained = 0;
  private temp: number;
  private ended = false;
  private nextImage = 0;

  /** @internal Use `FrameInspector`. */
  constructor(
    private readonly context: GlContext,
    private readonly src: FrameSource,
    private readonly plan: Plan,
    private readonly maxTextureSize: number,
    private readonly limit: number,
    private readonly complete: (session: CaptureSession, store: Map<string, Stored>) => void,
    private readonly fail: (error: unknown) => void,
  ) {
    this.three = context.three;
    this.temp = plan.copyTemp;
    this.reader = plan.hasSources
      ? new TexelReader(context, src.geometry, src.camera, plan.maxWidth, plan.maxHeight)
      : null;
  }

  /** Before a pass is drawn, with its channels bound and its `iResolution` written. */
  beforeDraw(pass: PassRuntime, index: number, size: { width: number; height: number }): void {
    this.guard(() => {
      const inputs: CapturedInput[] = [];
      for (let channel = 0; channel < CHANNEL_COUNT; channel++) {
        const described = describe(
          this.three,
          this.src,
          pass.channels[channel],
          this.drawn,
          this.maxTextureSize,
        );
        const bound = pass.uniforms[CHANNEL_UNIFORMS[channel]]?.value as THREE.Texture | undefined;
        if (!bound) {
          throw new FrameCaptureError(
            'unsupported',
            `Pass "${pass.id}" has no iChannel${channel} uniform.`,
          );
        }
        let imageId: string | null = null;
        if (described.key !== null) {
          imageId = this.capture(
            described.key,
            bound,
            described,
            described.source === 'image-slot' ? 'image-slot' : 'buffer-output',
          );
        }
        inputs.push({
          channel,
          binding: structuredClone(pass.channels[channel] ?? { kind: 'none' }),
          source: described.source,
          state: described.state,
          reason: described.reason,
          effective: described.effective,
          imageId,
          sampling: this.sampling(bound),
        });
      }

      const clones: Record<string, unknown> = {};
      const uniforms: Record<string, UniformValue> = {};
      for (const [name, uniform] of Object.entries(pass.uniforms)) {
        if ((CHANNEL_UNIFORMS as readonly string[]).includes(name)) continue;
        clones[name] = cloneUniform(uniform.value, name);
        uniforms[name] = serializeUniform(clones[name], name);
      }

      const accepted = pass.accepted;
      const requested = this.src.identity.requestedRevision;
      this.passes.push({
        index,
        id: pass.id,
        kind: pass.kind,
        accepted: {
          fingerprint: accepted.fingerprint,
          revision: accepted.revision,
          stale: requested !== null && accepted.revision !== requested,
          composedFragment: accepted.composedFragment,
          fragment: pass.fragment,
          composedVertex: accepted.composedVertex,
          vertex: pass.vertex,
          spans: accepted.spans,
        },
        resolution: { width: size.width, height: size.height },
        uniforms,
        inputs,
        output: {
          rawImageId: null,
          rawOrigin: pass.kind === 'buffer' ? 'buffer-target' : 'unavailable',
          rawUnavailableReason: pass.kind === 'buffer' ? null : 'Replay has not run.',
          displayImageId: null,
          comparison: null,
        },
      });
      if (pass.kind === 'image') this.image = { pass, inputs, clones, size: { ...size } };
    });
  }

  /** After a buffer pass is drawn: what it wrote is raw data, still in its target. */
  afterDraw(pass: PassRuntime, target: THREE.WebGLRenderTarget): void {
    this.guard(() => {
      const key = `buf:${pass.id}:1`;
      const imageId = this.capture(
        key,
        target.texture,
        { width: target.width, height: target.height, format: 'rgba16f' },
        'buffer-output',
      );
      this.drawn.add(pass.id);
      const captured = this.passes[this.passes.length - 1];
      if (captured?.id === pass.id) {
        this.passes[this.passes.length - 1] = {
          ...captured,
          output: { ...captured.output, rawImageId: imageId },
        };
      }
    });
  }

  /** After the frame reached the canvas: the display read, the labelled Image replay, the comparison. */
  finish(): void {
    this.guard(() => {
      const frame = this.frameSize();
      let displayId: string | null = null;
      let display: Uint8Array | null = null;

      if (this.image) {
        display = this.readCanvas(frame);
        displayId = this.add('display', 'canvas-display', frame, 'rgba8', display);
      }

      this.reader?.dispose();
      this.reader = null;
      this.temp = this.plan.replayTemp;

      if (this.image && display && displayId) this.replay(frame, display, displayId);

      this.ended = true;
      this.complete(this, this.store);
    });
  }

  /** Disposes anything still owned; called on every exit. */
  dispose(): void {
    this.ended = true;
    this.reader?.dispose();
    this.reader = null;
  }

  get active(): boolean {
    return !this.ended;
  }

  /** The frame-level facts the snapshot carries. */
  frameFacts(): ConstructorParameters<typeof FrameSnapshot>[2] {
    const { frameIndex, time, pointer, pointerVelocity, resolutionScale, usesComposer } = this.src;
    return {
      index: frameIndex,
      time,
      pointer: [...pointer],
      pointerVelocity: [...pointerVelocity],
      resolutionScale,
      drawingBuffer: this.frameSize(),
      usesPostProcessing: usesComposer,
    };
  }

  identity(): FrameIdentity {
    return this.src.identity;
  }

  finishedPasses(): readonly CapturedPass[] {
    return this.passes;
  }

  // ---------------------------------------------------------------------------

  private guard(run: () => void): void {
    if (this.ended) return;
    try {
      run();
    } catch (error) {
      this.dispose();
      this.fail(error);
    }
  }

  private frameSize(): { width: number; height: number } {
    const gl = glOf(this.context.renderer);
    return { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight };
  }

  private sampling(texture: THREE.Texture): CapturedSampling {
    const T = this.three;
    const wrap = (value: number): CapturedSampling['wrap'] =>
      value === T.RepeatWrapping
        ? 'repeat'
        : value === T.MirroredRepeatWrapping
          ? 'mirror'
          : value === T.ClampToEdgeWrapping
            ? 'clamp'
            : 'unknown';
    return {
      wrapS: texture.wrapS,
      wrapT: texture.wrapT,
      minFilter: texture.minFilter,
      magFilter: texture.magFilter,
      wrap: wrap(texture.wrapS) === wrap(texture.wrapT) ? wrap(texture.wrapS) : 'unknown',
      filter:
        texture.magFilter === T.NearestFilter
          ? 'nearest'
          : texture.magFilter === T.LinearFilter
            ? 'linear'
            : 'unknown',
      flipY: texture.flipY,
      colorSpace: texture.colorSpace,
      mipmaps: false,
    };
  }

  private retain(bytes: number): void {
    if (this.retained + bytes + this.temp > this.limit) {
      throw new FrameCaptureError('budget', 'The capture outgrew its payload budget.');
    }
    this.retained += bytes;
  }

  private add(
    key: string,
    origin: ImageOrigin,
    size: { width: number; height: number },
    format: TexelFormat,
    data: StoredData,
  ): string {
    const id = `${origin}-${this.nextImage++}`;
    const bytes = size.width * size.height * BYTES_PER_TEXEL[format];
    this.store.set(key, {
      meta: { id, origin, width: size.width, height: size.height, format, bytes },
      data,
    });
    return id;
  }

  /** Copies one texture's texels, once per key. */
  private capture(
    key: string,
    texture: THREE.Texture,
    described: { width: number; height: number; format: TexelFormat },
    origin: ImageOrigin,
  ): string {
    const existing = this.store.get(key);
    if (existing) return existing.meta.id;
    if (!this.reader) throw new FrameCaptureError('unsupported', 'No readback target was planned.');

    const { width, height, format } = described;
    this.retain(width * height * BYTES_PER_TEXEL[format]);
    const floats = this.reader.read(texture, width, height);
    const data =
      format === 'rgba8'
        ? encodeBytes(floats)
        : format === 'rgba16f'
          ? encodeHalf(floats)
          : floats.slice();
    return this.add(key, origin, { width, height }, format, data);
  }

  private readCanvas(size: { width: number; height: number }): Uint8Array {
    this.retain(size.width * size.height * BYTES_PER_TEXEL.rgba8);
    const renderer = this.context.renderer;
    const gl = glOf(renderer);
    drainGlErrors(gl);
    const previous = renderer.getRenderTarget();
    const out = new Uint8Array(size.width * size.height * 4);
    try {
      renderer.setRenderTarget(null);
      gl.readPixels(0, 0, size.width, size.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
    } finally {
      renderer.setRenderTarget(previous);
    }
    const error = gl.getError();
    if (error !== gl.NO_ERROR) {
      throw new FrameCaptureError(
        'readback',
        `Reading the canvas back failed with GL error ${error}.`,
      );
    }
    return out;
  }

  /**
   * Draws the accepted Image program again — from owned copies of its inputs and
   * uniforms, into an owned float32 target — because the live Image pass writes
   * 8-bit display values and cannot show HDR. Its program is the accepted one,
   * never a newer draft, and it never touches the live material, uniforms or
   * targets. Where the canvas still holds exactly the Image output (no
   * post-processing) the replay must agree with it, or the capture fails.
   */
  private replay(
    frame: { width: number; height: number },
    display: Uint8Array,
    displayId: string,
  ): void {
    const image = this.image!;
    const T = this.three;
    const renderer = this.context.renderer;
    const gl = glOf(renderer);
    const owned: { dispose(): void }[] = [];
    const captured = this.passes[this.passes.length - 1]!;

    try {
      const uniforms: Record<string, { value: unknown }> = {};
      for (const [name, value] of Object.entries(image.clones)) uniforms[name] = { value };

      for (const input of image.inputs) {
        const stored = input.imageId
          ? [...this.store.values()].find((s) => s.meta.id === input.imageId)
          : null;
        const texture = stored
          ? new T.DataTexture(
              stored.data as Uint8Array | Uint16Array,
              stored.meta.width,
              stored.meta.height,
              T.RGBAFormat,
              stored.meta.format === 'rgba16f' ? T.HalfFloatType : T.UnsignedByteType,
            )
          : new T.DataTexture(new Uint8Array(4), 1, 1, T.RGBAFormat);
        this.context.own(texture);
        owned.push(texture);
        texture.wrapS = input.sampling.wrapS as THREE.Wrapping;
        texture.wrapT = input.sampling.wrapT as THREE.Wrapping;
        texture.magFilter = input.sampling.magFilter as THREE.MagnificationTextureFilter;
        texture.minFilter = input.sampling.minFilter as THREE.MinificationTextureFilter;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;
        uniforms[CHANNEL_UNIFORMS[input.channel]] = { value: texture };
      }

      const material = this.context.own(
        new T.ShaderMaterial({
          vertexShader: image.pass.vertex,
          fragmentShader: image.pass.fragment,
          uniforms,
        }),
      );
      owned.push(material);
      const target = this.context.own(
        new T.WebGLRenderTarget(frame.width, frame.height, {
          type: T.FloatType,
          format: T.RGBAFormat,
          depthBuffer: false,
          stencilBuffer: false,
          minFilter: T.NearestFilter,
          magFilter: T.NearestFilter,
          generateMipmaps: false,
        }),
      );
      owned.push(target);
      const mesh = new T.Mesh(this.src.geometry, material);
      mesh.frustumCulled = false;
      const scene = new T.Scene();
      scene.add(mesh);

      this.retain(frame.width * frame.height * BYTES_PER_TEXEL.rgba32f);
      const raw = new Float32Array(frame.width * frame.height * 4);

      drainGlErrors(gl);
      const previous = renderer.getRenderTarget();
      try {
        renderer.setRenderTarget(target);
        assertComplete(gl, 'Image replay');
        renderer.render(scene, this.src.camera);
        renderer.readRenderTargetPixels(target, 0, 0, frame.width, frame.height, raw);
      } finally {
        renderer.setRenderTarget(previous);
      }
      const error = gl.getError();
      if (error !== gl.NO_ERROR) {
        throw new FrameCaptureError('readback', `The Image replay failed with GL error ${error}.`);
      }

      const rawId = this.add('raw-image', 'image-raw-replay', frame, 'rgba32f', raw);
      const comparison = this.compare(raw, display, gl);
      this.passes[this.passes.length - 1] = {
        ...captured,
        output: {
          rawImageId: rawId,
          rawOrigin: 'frozen-replay',
          rawUnavailableReason: null,
          displayImageId: displayId,
          comparison,
        },
      };
    } finally {
      for (const resource of owned) resource.dispose();
    }
  }

  private compare(raw: Float32Array, display: Uint8Array, gl: Gl): ReplayComparison {
    if (this.src.usesComposer) {
      return {
        status: 'not-comparable',
        reason:
          'Post-processing is active, so the canvas holds the processed output, not the Image pass.',
      };
    }
    // A canvas without an alpha buffer reads back opaque whatever the shader wrote.
    const channels = gl.getContextAttributes()?.alpha === false ? 3 : 4;
    let maxDelta = 0;
    let skipped = 0;
    for (let texel = 0; texel < raw.length / 4; texel++) {
      for (let channel = 0; channel < channels; channel++) {
        const value = raw[texel * 4 + channel];
        if (!Number.isFinite(value) && Number.isNaN(value)) {
          skipped++;
          continue;
        }
        const expected = Math.round(Math.min(Math.max(value, 0), 1) * 255);
        maxDelta = Math.max(maxDelta, Math.abs(expected - display[texel * 4 + channel]));
      }
    }
    if (maxDelta > 1) {
      throw new FrameCaptureError(
        'replay-mismatch',
        `The frozen Image replay differs from the live canvas by ${maxDelta}/255; the raw Image data cannot be trusted.`,
      );
    }
    return { status: 'match', maxDelta, comparedChannels: channels, skippedNonFinite: skipped };
  }
}

// -----------------------------------------------------------------------------
// Lifecycle: one pending request, one retained snapshot
// -----------------------------------------------------------------------------

interface Pending {
  readonly resolve: (snapshot: FrameSnapshot) => void;
  readonly reject: (error: FrameCaptureError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
}

export interface InspectorHost {
  /** Ask for a frame to be drawn even though a paused preview would not. */
  requestFrame(): void;
  /** Told whenever a retained or pending capture is ended by something other than the caller. */
  invalidated(reason: InvalidationReason): void;
}

export class FrameInspector {
  private retained: FrameSnapshot | null = null;
  private pending: Pending | null = null;
  private nextId = 1;
  private disposed = false;

  constructor(
    private readonly context: GlContext,
    private readonly host: InspectorHost,
    private readonly limit = CAPTURE_BUDGET_BYTES,
  ) {}

  get snapshot(): FrameSnapshot | null {
    return this.retained;
  }

  get hasPending(): boolean {
    return this.pending !== null;
  }

  request(options: CaptureOptions = {}): Promise<FrameSnapshot> {
    const refuse = (code: CaptureErrorCode, message: string) =>
      Promise.reject(new FrameCaptureError(code, message));

    if (this.disposed) return refuse('disposed', 'The renderer was disposed.');
    if (this.context.status() !== 'live')
      return refuse('context', 'The WebGL context is not live.');
    if (options.signal?.aborted)
      return refuse('aborted', 'The capture was aborted before it started.');
    if (this.pending) return refuse('busy', 'A frame capture is already pending.');
    if (this.retained)
      return refuse('retained', 'Release the retained capture before taking another.');

    return new Promise<FrameSnapshot>((resolve, reject) => {
      const timeoutMs =
        options.timeoutMs !== undefined &&
        Number.isFinite(options.timeoutMs) &&
        options.timeoutMs > 0
          ? options.timeoutMs
          : CAPTURE_TIMEOUT_MS;
      const onAbort = () =>
        this.settlePending(new FrameCaptureError('aborted', 'The capture was aborted.'));
      const timer = setTimeout(
        () =>
          this.settlePending(
            new FrameCaptureError('timeout', `No frame was drawn within ${timeoutMs} ms.`),
          ),
        timeoutMs,
      );
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending = { resolve, reject, timer, signal: options.signal, onAbort };
      this.host.requestFrame();
    });
  }

  /**
   * Called at the top of every drawn frame. Returns `null` — after one field
   * read — unless a request is pending; otherwise preflights the exact payload
   * and, only if it fits and the GPU can read it back losslessly, starts a session.
   */
  begin(source: () => FrameSource): CaptureSession | null {
    if (!this.pending) return null;
    try {
      if (this.context.status() !== 'live') {
        throw new FrameCaptureError('context', 'The WebGL context is not live.');
      }
      const renderer = this.context.renderer;
      const gl = glOf(renderer);
      if (!gl.getExtension('EXT_color_buffer_float')) {
        throw new FrameCaptureError(
          'unsupported',
          'EXT_color_buffer_float is unavailable, so half-float and float data cannot be read back without precision loss.',
        );
      }
      const src = source();
      const maxTextureSize = renderer.capabilities.maxTextureSize;
      const plan = planFrame(
        this.context.three,
        src,
        { maxTextureSize, width: gl.drawingBufferWidth, height: gl.drawingBufferHeight },
        this.limit,
      );
      return new CaptureSession(
        this.context,
        src,
        plan,
        maxTextureSize,
        this.limit,
        (session, store) => this.complete(session, store),
        (error) => this.settlePending(asCaptureError(error)),
      );
    } catch (error) {
      this.settlePending(asCaptureError(error));
      return null;
    }
  }

  /** Ends the retained snapshot and cancels any pending request. Idempotent. */
  release(): void {
    this.settlePending(new FrameCaptureError('released', 'The capture was released.'));
    this.retained?.release();
  }

  invalidate(reason: InvalidationReason): void {
    const had = this.pending !== null || this.retained !== null;
    this.settlePending(new FrameCaptureError('invalidated', `The capture ended: ${reason}.`));
    this.retained?.release();
    if (had) this.host.invalidated(reason);
  }

  dispose(): void {
    if (this.disposed) return;
    this.invalidate('disposed');
    this.disposed = true;
  }

  private complete(session: CaptureSession, store: Map<string, Stored>): void {
    const pending = this.pending;
    if (!pending) {
      session.dispose();
      return;
    }
    const snapshot = new FrameSnapshot(
      this.nextId++,
      session.identity(),
      session.frameFacts(),
      session.finishedPasses(),
      store,
      (released) => {
        if (this.retained === released) this.retained = null;
      },
    );
    this.retained = snapshot;
    this.clearPending(pending);
    pending.resolve(snapshot);
  }

  private settlePending(error: FrameCaptureError): void {
    const pending = this.pending;
    if (!pending) return;
    this.clearPending(pending);
    pending.reject(error);
  }

  private clearPending(pending: Pending): void {
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener('abort', pending.onAbort);
    this.pending = null;
  }
}

function asCaptureError(error: unknown): FrameCaptureError {
  return error instanceof FrameCaptureError
    ? error
    : new FrameCaptureError('readback', `Capture failed: ${String(error)}`);
}
