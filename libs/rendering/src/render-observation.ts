import type * as THREE from 'three';

import type { GlContext } from './gl-context';
import {
  CAPTURE_BUDGET_BYTES,
  FrameCaptureError,
  HALF_ABSOLUTE,
  HALF_MAX,
  HALF_RELATIVE,
  assertComplete,
  drainGlErrors,
  glOf,
  replayTexture,
  type FrameSnapshot,
  type Gl,
} from './render-inspection';

/**
 * One frozen GPU variable measurement.
 *
 * The accepted fragment of one captured pass is replayed, with the catalogue's
 * capture block inserted after one verified statement, over the full viewport
 * of that pass, from the inputs the snapshot froze: never the live renderer,
 * material, uniforms or targets, and never a newer draft. Three programs are
 * drawn one after another into one owned float32 target:
 *
 *   preserved  the insertion only, no output change: held against the snapshot's
 *              raw image of the pass, so a modified program that no longer draws
 *              what the original drew is visibly distrusted;
 *   hit        publishes whether the capture ran (alpha 0 = nothing was written,
 *              i.e. the invocation discarded);
 *   value      publishes the captured value, which is read back as raw FLOAT.
 *
 * The result is a modified-program measurement. Agreement of the preserved
 * output with the original is evidence about that output only; it never
 * certifies the intermediate (`certifiesIntermediates` is always false).
 *
 * Cancellation: abort, timeout, supersession and every capture invalidation
 * are checked between stages, after yielding a task. A draw or readback that
 * has been submitted cannot be interrupted; it finishes, its result is dropped,
 * and nothing is published.
 */

export type ObservationType = 'float' | 'vec2' | 'vec3' | 'vec4';
export type ObservationPrecision = 'lowp' | 'mediump' | 'highp';

export const OBSERVATION_COMPONENTS: Readonly<Record<ObservationType, number>> = {
  float: 1,
  vec2: 2,
  vec3: 3,
  vec4: 4,
};

/**
 * Preserved output against the Image pass's float replay: the same GPU runs
 * the same arithmetic, so this is only allowance for compiler reassociation.
 * A buffer pass is held to its half-float live target, so half-float rounding.
 */
export const FLOAT_RELATIVE = 2 ** -16;
export const FLOAT_ABSOLUTE = 2 ** -20;

/** Texels per readback band: bounds the CPU copy, whatever the viewport. */
export const BAND_TEXELS = 1 << 18;
const FLOAT_TEXEL_BYTES = 16;

export interface ObservationRequest {
  /** Index of the captured pass whose accepted fragment is measured. */
  readonly passIndex: number;
  /** Bottom-left origin, like every other image read. */
  readonly pixel: { readonly x: number; readonly y: number };
  readonly visit: number;
  readonly type: ObservationType;
  readonly precision: ObservationPrecision;
  /** The generated `uniform mediump int` the capture block compares its counter with. */
  readonly visitTarget: string;
  /** The ESSL the analysis assumed in front of the fragment: three's actual prefix must equal it. */
  readonly prefix: string;
  /** Fragments as given to three (the prefix removed). */
  readonly programs: {
    readonly preserved: string;
    readonly hit: string;
    readonly value: string;
  };
}

export type ObservationAvailability = 'available' | 'unvisited' | 'discarded';

export interface ObservationFidelity {
  readonly status: 'match' | 'mismatch' | 'unverified';
  readonly reference: 'image-raw-replay' | 'buffer-live-target' | null;
  readonly tolerance: { readonly relative: number; readonly absolute: number };
  readonly comparedTexels: number;
  /** Distinct texels with at least one mismatched component. */
  readonly mismatchedTexels: number;
  /** Mismatched RGBA components (a texel has four). */
  readonly mismatchedComponents: number;
  readonly maxDelta: number;
  /** Distinct texels with a component that was non-finite in the same way on both sides: no numeric equality exists to check. */
  readonly skippedNonFinite: number;
  /** The same skipped comparisons, counted per RGBA component. */
  readonly skippedComponents: number;
  readonly reason: string | null;
  /** Agreement of a final colour is never evidence about an intermediate. */
  readonly certifiesIntermediates: false;
}

export interface ObservationResult {
  readonly measurement: 'modified-program';
  readonly passIndex: number;
  readonly pixel: { readonly x: number; readonly y: number };
  readonly visit: number;
  readonly type: ObservationType;
  /** What the source declared. */
  readonly declaredPrecision: ObservationPrecision;
  /** What this GPU's fragment stage gives that precision for float. */
  readonly effectivePrecision: {
    readonly bits: number;
    readonly rangeMin: number;
    readonly rangeMax: number;
  };
  /** Never conflated with the value: unavailable is not zero. */
  readonly availability: ObservationAvailability;
  /** Raw float32 components as the GPU wrote them (negative, HDR, NaN, ±Infinity kept); null unless available. */
  readonly components: readonly number[] | null;
  readonly fidelity: ObservationFidelity;
  /** True only when the preserved output matched its reference. */
  readonly trusted: boolean;
  readonly budget: { readonly bytes: number; readonly limit: number };
}

export interface ObservationControl {
  /** Aborted with a `FrameCaptureError` as its reason, by the caller, a timeout or an invalidation. */
  readonly signal: AbortSignal;
}

// -----------------------------------------------------------------------------
// Budget
// -----------------------------------------------------------------------------

export interface ObservationFootprint {
  readonly retained: number;
  readonly target: number;
  readonly geometry: number;
  readonly textures: number;
  readonly bands: number;
  readonly total: number;
}

/** The bytes one observation adds to what the snapshot already retains. Exact; nothing is estimated down. */
export function observationFootprint(input: {
  snapshotBytes: number;
  width: number;
  height: number;
  geometryBytes: number;
  textureBytes: number;
}): ObservationFootprint {
  const { snapshotBytes, width, height } = input;
  const target = width * height * FLOAT_TEXEL_BYTES;
  const rows = Math.min(height, Math.max(1, Math.floor(BAND_TEXELS / width)));
  // The band read from the target, and the band read from the snapshot to compare it with.
  const bands = 2 * rows * width * FLOAT_TEXEL_BYTES;
  const total = snapshotBytes + target + input.geometryBytes + input.textureBytes + bands;
  return {
    retained: snapshotBytes,
    target,
    geometry: input.geometryBytes,
    textures: input.textureBytes,
    bands,
    total,
  };
}

// -----------------------------------------------------------------------------
// Comparison
// -----------------------------------------------------------------------------

export interface BandComparison {
  readonly maxDelta: number;
  /** RGBA components that disagree. */
  readonly mismatched: number;
  /** RGBA components with no numeric comparison (equal NaN / same infinity). */
  readonly skipped: number;
  /** Distinct texels with at least one mismatched component. */
  readonly mismatchedTexels: number;
  /** Distinct texels with at least one skipped component. */
  readonly skippedTexels: number;
}

/**
 * Held against a reference: finite values within `max(|reference| · relative,
 * absolute)`; NaN against NaN is skipped, never matched; NaN against a number is
 * a mismatch; a non-finite reference is skipped only when the replay agrees in
 * sign (and, for a half-float reference that saturates, reaches the half range).
 */
export function compareBand(
  observed: ArrayLike<number>,
  reference: ArrayLike<number>,
  tolerance: { relative: number; absolute: number },
  halfReference: boolean,
): BandComparison {
  let maxDelta = 0;
  let mismatched = 0;
  let skipped = 0;
  let mismatchedTexels = 0;
  let skippedTexels = 0;
  let lastMismatchTexel = -1;
  let lastSkipTexel = -1;
  const mismatch = (index: number): void => {
    mismatched++;
    if (lastMismatchTexel !== index >> 2) {
      lastMismatchTexel = index >> 2;
      mismatchedTexels++;
    }
  };
  const skip = (index: number): void => {
    skipped++;
    if (lastSkipTexel !== index >> 2) {
      lastSkipTexel = index >> 2;
      skippedTexels++;
    }
  };
  for (let index = 0; index < observed.length; index++) {
    const live = reference[index];
    const seen = observed[index];
    const liveNaN = Number.isNaN(live);
    if (liveNaN !== Number.isNaN(seen)) {
      maxDelta = Infinity;
      mismatch(index);
      continue;
    }
    if (liveNaN) {
      skip(index);
      continue;
    }
    if (!Number.isFinite(live)) {
      // A float reference is exact: only the same infinity agrees. A half reference saturates, so
      // a finite value at the half range (or beyond) of the same sign agrees too.
      const agrees = halfReference
        ? Math.sign(live) === Math.sign(seen) && Math.abs(seen) >= HALF_MAX
        : seen === live;
      if (agrees) skip(index);
      else {
        maxDelta = Infinity;
        mismatch(index);
      }
      continue;
    }
    const delta = Math.abs(seen - live);
    maxDelta = Math.max(maxDelta, delta);
    // False for an infinite observation too, which is the point.
    if (!(delta <= Math.max(Math.abs(live) * tolerance.relative, tolerance.absolute))) {
      mismatch(index);
    }
  }
  return { maxDelta, mismatched, skipped, mismatchedTexels, skippedTexels };
}

/**
 * The verdict of a whole comparison. A real mismatch stays a mismatch; a skipped
 * component was never numerically checked, so it can never certify the output.
 */
export function judgeFidelity(compared: {
  mismatchedComponents: number;
  skippedComponents: number;
  skippedTexels: number;
}): { status: 'match' | 'mismatch' | 'unverified'; reason: string | null } {
  if (compared.mismatchedComponents > 0) return { status: 'mismatch', reason: null };
  if (compared.skippedComponents > 0) {
    return {
      status: 'unverified',
      reason: `${compared.skippedComponents} component(s) in ${compared.skippedTexels} texel(s) are non-finite and were not compared numerically.`,
    };
  }
  return { status: 'match', reason: null };
}

// -----------------------------------------------------------------------------
// The measurement
// -----------------------------------------------------------------------------

const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function abortReason(signal: AbortSignal): FrameCaptureError {
  const reason: unknown = signal.reason;
  return reason instanceof FrameCaptureError
    ? reason
    : new FrameCaptureError('aborted', 'The observation was aborted.');
}

/** Compiled fragment source of a drawn material: what the driver was really given. */
function compiledFragment(
  renderer: THREE.WebGLRenderer,
  gl: Gl,
  material: THREE.ShaderMaterial,
): string | null {
  const properties = renderer.properties.get(material) as {
    currentProgram?: { program?: WebGLProgram };
  };
  const program = properties.currentProgram?.program;
  if (!program) return null;
  for (const shader of gl.getAttachedShaders(program) ?? []) {
    if (gl.getShaderParameter(shader, gl.SHADER_TYPE) === gl.FRAGMENT_SHADER) {
      return gl.getShaderSource(shader);
    }
  }
  return null;
}

/**
 * Three's real prefix and the analysed one say the same things in different bytes:
 * indentation and blank lines, `#define OPAQUE`, the material's `SHADER_NAME` and the
 * sign of a zero in an identity matrix. Those are normalised away and nothing else is,
 * so a different define, precision or helper still refuses.
 */
function normalizePrefix(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter(
      (line) => line !== '' && line !== '#define OPAQUE' && !/^#define SHADER_NAME\b/.test(line),
    )
    .join('\n')
    .replace(/-0\.0000/g, '0.0000');
}

/** The driver's source is the analysed prefix (up to the above) followed by exactly the fragment given. */
function sameProgram(actual: string | null, prefix: string, fragment: string): boolean {
  if (actual === null || !actual.endsWith(fragment)) return false;
  const seen = actual.slice(0, actual.length - fragment.length);
  return normalizePrefix(seen) === normalizePrefix(prefix);
}

function geometryBytes(geometry: THREE.BufferGeometry): number {
  let bytes = geometry.index?.array.byteLength ?? 0;
  for (const attribute of Object.values(geometry.attributes)) bytes += attribute.array.byteLength;
  return bytes;
}

/**
 * Measures one point. Refuses — never degrades — when the frame, the GPU or the
 * budget cannot do it exactly. Owns and disposes the target, the textures and
 * every material it creates, on every exit.
 */
export async function observeFrozenPoint(
  context: GlContext,
  snapshot: FrameSnapshot,
  request: ObservationRequest,
  control: ObservationControl,
): Promise<ObservationResult> {
  const { signal } = control;
  const check = (): void => {
    if (signal.aborted) throw abortReason(signal);
    if (snapshot.released) {
      throw new FrameCaptureError('released', 'This frame capture was released.');
    }
    if (context.status() !== 'live') {
      throw new FrameCaptureError('context', 'The WebGL context is not live.');
    }
  };
  const boundary = async (): Promise<void> => {
    await macrotask();
    check();
  };
  check();

  const captured = snapshot.passes.find((pass) => pass.index === request.passIndex);
  if (!captured) {
    throw new FrameCaptureError('source', `The capture has no pass ${request.passIndex}.`);
  }
  if (
    !Number.isInteger(request.visit) ||
    request.visit < 1 ||
    request.visit > 128 ||
    !(request.type in OBSERVATION_COMPONENTS)
  ) {
    throw new FrameCaptureError('unsupported', 'A visit is a whole number from 1 to 128.');
  }

  const referenceId = captured.output.rawImageId;
  const reference = referenceId ? snapshot.image(referenceId) : null;
  const width = reference?.width ?? captured.resolution.width;
  const height = reference?.height ?? captured.resolution.height;
  if (
    !(request.pixel.x >= 0 && request.pixel.x < width && request.pixel.x === (request.pixel.x | 0))
  ) {
    throw new FrameCaptureError(
      'unsupported',
      `Pixel x is outside the ${width}×${height} viewport.`,
    );
  }
  if (
    !(request.pixel.y >= 0 && request.pixel.y < height && request.pixel.y === (request.pixel.y | 0))
  ) {
    throw new FrameCaptureError(
      'unsupported',
      `Pixel y is outside the ${width}×${height} viewport.`,
    );
  }

  const inputs = snapshot.replayInputs(request.passIndex);
  const textureBytes = inputs.textures.reduce(
    (sum, texture) => sum + (texture.data?.byteLength ?? 4),
    0,
  );
  const footprint = observationFootprint({
    snapshotBytes: snapshot.bytes,
    width,
    height,
    geometryBytes: geometryBytes(inputs.geometry),
    textureBytes,
  });
  if (footprint.total > CAPTURE_BUDGET_BYTES) {
    throw new FrameCaptureError(
      'budget',
      `Measuring this point needs ${footprint.total} bytes with the capture (${footprint.retained} retained, ${footprint.target} target, ${footprint.textures} textures, ${footprint.bands} readback), over the ${CAPTURE_BUDGET_BYTES}-byte limit. Nothing was measured or downsampled.`,
    );
  }

  const T = context.three;
  const renderer = context.renderer;
  const gl = glOf(renderer);
  const owned: { dispose(): void }[] = [];
  const clearColour = new T.Color();
  renderer.getClearColor(clearColour);
  const clearAlpha = renderer.getClearAlpha();
  const previousTarget = renderer.getRenderTarget();
  /** Gives the renderer back to the live engine: the observer's target and clear colour never outlive its draw. */
  const restoreLiveState = (): void => {
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(clearColour, clearAlpha);
  };

  try {
    await boundary();

    const target = context.own(
      new T.WebGLRenderTarget(width, height, {
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
    const textures = new Map<number, THREE.DataTexture>();
    for (const texture of inputs.textures) {
      const made = replayTexture(context, texture.meta, texture.data, texture.sampling);
      owned.push(made);
      textures.set(texture.channel, made);
    }
    const scene = new T.Scene();

    /** Draws one program into the cleared target; every draw gets fresh uniform clones. */
    const draw = (fragment: string, label: string, replayClear = false): void => {
      const uniforms: Record<string, { value: unknown }> = {};
      const fresh = snapshot.replayInputs(request.passIndex);
      for (const [name, value] of Object.entries(fresh.uniforms)) uniforms[name] = { value };
      for (const [channel, texture] of textures) {
        uniforms[`iChannel${channel}`] = { value: texture };
      }
      uniforms[request.visitTarget] = { value: request.visit };
      const material = context.own(
        new T.ShaderMaterial({
          vertexShader: captured.accepted.vertex,
          fragmentShader: fragment,
          uniforms,
        }),
      );
      const mesh = new T.Mesh(fresh.geometry, material);
      mesh.frustumCulled = false;
      scene.add(mesh);

      const failures: string[] = [];
      const previousHandler = renderer.debug.onShaderError;
      renderer.debug.onShaderError = (g, program, _vertex, fragmentShader) => {
        failures.push(
          (g.getShaderInfoLog(fragmentShader) ?? '').trim() ||
            (g.getProgramInfoLog(program) ?? '').trim() ||
            'The program failed to link.',
        );
      };
      try {
        drainGlErrors(gl);
        renderer.setRenderTarget(target);
        // The preserved draw is compared with the replay texel for texel, so a discarded texel must
        // hold what the replay's clear left there; the marker draws need a clear that reads as unwritten.
        if (replayClear) renderer.setClearColor(clearColour, clearAlpha);
        else renderer.setClearColor(0x000000, 0);
        assertComplete(gl, `${label} observation`);
        if (
          gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) !== gl.FLOAT ||
          gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) !== gl.RGBA
        ) {
          throw new FrameCaptureError(
            'unsupported',
            'This GPU cannot read a float RGBA attachment back as FLOAT, so the value would be quantized; it is refused instead.',
          );
        }
        renderer.render(scene, fresh.camera);
        if (failures.length > 0) {
          throw new FrameCaptureError(
            'compile',
            `The instrumented ${label} program did not compile: ${failures[0]}`,
          );
        }
        const actual = compiledFragment(renderer, gl, material);
        if (!sameProgram(actual, request.prefix, fragment)) {
          throw new FrameCaptureError(
            'source',
            'The program the driver was given differs from the prepared source the point was mapped on (three.js’s ESSL prefix is not the analysed one), so the point cannot be located exactly.',
          );
        }
      } finally {
        // Readbacks name the target themselves, so nothing of the observer stays applied after the draw;
        // a live frame drawn at any later point (a yield, or inside a readback) cannot land in it.
        restoreLiveState();
        renderer.debug.onShaderError = previousHandler;
        scene.remove(mesh);
        material.dispose();
      }
    };

    const readError = (what: string): void => {
      const error = gl.getError();
      if (error !== gl.NO_ERROR) {
        throw new FrameCaptureError('readback', `The ${what} failed with GL error ${error}.`);
      }
    };

    // --- preserved output, held against the frozen reference ------------------
    draw(request.programs.preserved, 'preserved-output', true);
    const tolerance =
      reference?.format === 'rgba32f'
        ? { relative: FLOAT_RELATIVE, absolute: FLOAT_ABSOLUTE }
        : { relative: HALF_RELATIVE, absolute: HALF_ABSOLUTE };
    let comparedTexels = 0;
    let mismatchedTexels = 0;
    let mismatchedComponents = 0;
    let skippedTexels = 0;
    let skippedComponents = 0;
    let maxDelta = 0;
    let unverified: string | null = null;
    if (!reference || !referenceId) {
      unverified = 'This pass has no raw reference image in the capture.';
    } else if (reference.format === 'rgba8') {
      unverified = 'The reference is 8-bit; it cannot verify a float output.';
    }
    if (!unverified) {
      const rows = Math.min(height, Math.max(1, Math.floor(BAND_TEXELS / width)));
      const band = new Float32Array(rows * width * 4);
      for (let y = 0; y < height; y += rows) {
        const count = Math.min(rows, height - y);
        const view = count === rows ? band : band.subarray(0, count * width * 4);
        renderer.readRenderTargetPixels(target, 0, y, width, count, view);
        readError('preserved-output readback');
        const expected = snapshot.read(referenceId!, { x: 0, y, width, height: count }).data;
        const result = compareBand(view, expected, tolerance, reference!.format === 'rgba16f');
        comparedTexels += count * width;
        mismatchedTexels += result.mismatchedTexels;
        mismatchedComponents += result.mismatched;
        skippedTexels += result.skippedTexels;
        skippedComponents += result.skipped;
        maxDelta = Math.max(maxDelta, result.maxDelta);
        await boundary();
      }
    }
    const verdict = unverified
      ? { status: 'unverified' as const, reason: unverified }
      : judgeFidelity({ mismatchedComponents, skippedComponents, skippedTexels });
    const fidelity: ObservationFidelity = {
      status: verdict.status,
      reference: unverified
        ? null
        : reference!.format === 'rgba32f'
          ? 'image-raw-replay'
          : 'buffer-live-target',
      tolerance,
      comparedTexels,
      mismatchedTexels,
      mismatchedComponents,
      maxDelta,
      skippedNonFinite: skippedTexels,
      skippedComponents,
      reason: verdict.reason,
      certifiesIntermediates: false,
    };
    await boundary();

    const pixelOf = (label: string): Float32Array => {
      const out = new Float32Array(4);
      renderer.readRenderTargetPixels(target, request.pixel.x, request.pixel.y, 1, 1, out);
      readError(`${label} readback`);
      return out;
    };

    // --- did the capture run? --------------------------------------------------
    draw(request.programs.hit, 'hit');
    const hit = pixelOf('hit');
    await boundary();
    let availability: ObservationAvailability;
    if (hit[3] === 0) availability = 'discarded';
    else if (hit[3] === 1 && hit[0] === 0) availability = 'unvisited';
    else if (hit[3] === 1 && hit[0] === 1) availability = 'available';
    else {
      throw new FrameCaptureError(
        'readback',
        'The hit marker read back as neither written nor clear.',
      );
    }

    let components: number[] | null = null;
    if (availability === 'available') {
      draw(request.programs.value, 'value');
      components = Array.from(pixelOf('value').subarray(0, OBSERVATION_COMPONENTS[request.type]));
      await boundary();
    }

    const format = gl.getShaderPrecisionFormat(
      gl.FRAGMENT_SHADER,
      request.precision === 'highp'
        ? gl.HIGH_FLOAT
        : request.precision === 'mediump'
          ? gl.MEDIUM_FLOAT
          : gl.LOW_FLOAT,
    );
    return {
      measurement: 'modified-program',
      passIndex: request.passIndex,
      pixel: { ...request.pixel },
      visit: request.visit,
      type: request.type,
      declaredPrecision: request.precision,
      effectivePrecision: {
        bits: format?.precision ?? 0,
        rangeMin: format?.rangeMin ?? 0,
        rangeMax: format?.rangeMax ?? 0,
      },
      availability,
      components,
      fidelity,
      trusted: fidelity.status === 'match',
      budget: { bytes: footprint.total, limit: CAPTURE_BUDGET_BYTES },
    };
  } finally {
    restoreLiveState();
    for (const resource of owned) resource.dispose();
    // The geometry belongs to the snapshot, but the clone given to this run is shared; it is not disposed here.
  }
}
