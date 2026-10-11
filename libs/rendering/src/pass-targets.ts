import type * as THREE from 'three';

import type { PassResolution, TextureFilterMode, TextureWrapMode } from '@shadergrove/shared';
import type { GlContext } from './gl-context';

/**
 * The textures the buffer passes render into.
 *
 * Every buffer owns *two* render targets, not one. A buffer that samples its own
 * previous frame — a trail, a fluid, a reaction-diffusion — is reading and
 * writing the same logical image in the same draw call, which no GPU allows. So
 * it reads one target and writes the other, and they trade places at the end of
 * the frame: the classic ping-pong. `front` is always the frame just finished
 * and `back` is always the one being drawn into.
 *
 * The other half of the job is the bookkeeping that a pair of GPU allocations per
 * pass makes unavoidable. Targets are created when a buffer appears, resized only
 * when their size genuinely changes (a resize reallocates the texture and throws
 * its contents away — for a feedback buffer that is the loss of its entire
 * history, so doing it on every `ResizeObserver` tick would be catastrophic),
 * and disposed when the buffer is deleted or the engine is.
 *
 * Everything allocated here is tagged with the owning `GlContext`, exactly as the
 * rest of the renderer's GPU resources are: a target from another context would
 * be silently re-uploaded by three and then freed out from under whoever else
 * held it.
 */

/** What the pipeline needs to know about a buffer to give it targets. */
export interface TargetSpec {
  id: string;
  resolution: PassResolution;
  filter: TextureFilterMode;
  wrap: TextureWrapMode;
}

export interface Viewport {
  width: number;
  height: number;
}

export const RGBA16F_BYTES_PER_PIXEL = 8;
export const RENDER_TARGETS_PER_BUFFER = 2;

export interface BufferAllocation {
  id: string;
  width: number;
  height: number;
  bytes: number;
}

interface Entry {
  targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  /** Index into `targets` of the frame most recently finished. */
  front: 0 | 1;
  width: number;
  height: number;
  filter: TextureFilterMode;
  wrap: TextureWrapMode;
}

/** The size a buffer's target should be, given the canvas it is rendering for. */
export function targetSize(resolution: PassResolution, viewport: Viewport): Viewport {
  const width = Math.max(1, Math.floor(viewport.width));
  const height = Math.max(1, Math.floor(viewport.height));

  switch (resolution.mode) {
    case 'fixed':
      return { width: resolution.width, height: resolution.height };
    case 'scaled':
      return {
        width: Math.max(1, Math.round(width * resolution.scale)),
        height: Math.max(1, Math.round(height * resolution.scale)),
      };
    case 'viewport':
    default:
      return { width, height };
  }
}

export class BufferTargets {
  private readonly entries = new Map<string, Entry>();

  /**
   * The texture each buffer held at the *start* of the current frame.
   *
   * Snapshotted rather than looked up on demand, because "the previous frame" has
   * to mean the same thing to every pass in the frame regardless of whether the
   * buffer it names has already been redrawn by the time they ask. Without this,
   * a feedback channel would read last frame's image or this one's depending on
   * where its owner happened to fall in the render order — which is exactly the
   * kind of bug that only shows up in the one project that reorders its buffers.
   */
  private previousFrame = new Map<string, THREE.Texture>();

  private viewport: Viewport = { width: 1, height: 1 };

  constructor(private readonly context: GlContext) {}

  /**
   * Bring the pool in line with the passes that now exist: create targets for
   * new buffers, resize the ones whose size changed, retune sampling on the ones
   * whose settings changed, and free the ones whose pass is gone.
   */
  sync(specs: readonly TargetSpec[], viewport: Viewport): void {
    this.viewport = viewport;

    const live = new Set(specs.map((spec) => spec.id));
    for (const [id, entry] of this.entries) {
      if (live.has(id)) continue;
      this.disposeEntry(entry);
      this.entries.delete(id);
      this.previousFrame.delete(id);
    }

    for (const spec of specs) {
      const size = targetSize(spec.resolution, viewport);
      const existing = this.entries.get(spec.id);

      if (!existing) {
        this.entries.set(spec.id, this.createEntry(spec, size));
        continue;
      }

      if (existing.width !== size.width || existing.height !== size.height) {
        // Reallocates, and so clears. Unavoidable, and the reason this is
        // guarded rather than done unconditionally.
        for (const target of existing.targets) target.setSize(size.width, size.height);
        existing.width = size.width;
        existing.height = size.height;
      }

      if (existing.filter !== spec.filter || existing.wrap !== spec.wrap) {
        for (const target of existing.targets) this.applySampling(target.texture, spec);
        existing.filter = spec.filter;
        existing.wrap = spec.wrap;
      }
    }
  }

  private createEntry(spec: TargetSpec, size: Viewport): Entry {
    const targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] = [
      this.createTarget(spec, size),
      this.createTarget(spec, size),
    ];

    return {
      targets,
      front: 0,
      width: size.width,
      height: size.height,
      filter: spec.filter,
      wrap: spec.wrap,
    };
  }

  /**
   * Half-float, not the default 8-bit. A feedback buffer feeds its own output
   * back in every frame, so any quantisation it suffers is applied again on the
   * next frame, and again on the next: 8 bits per channel turns a slow-decaying
   * trail into visible banding within a second or two, and makes any buffer used
   * for simulation rather than colour (positions, velocities, densities) useless.
   */
  private createTarget(spec: TargetSpec, size: Viewport): THREE.WebGLRenderTarget {
    const T = this.context.three;

    const target = this.context.own(
      new T.WebGLRenderTarget(size.width, size.height, {
        depthBuffer: false,
        stencilBuffer: false,
        type: T.HalfFloatType,
      }),
    );

    this.applySampling(target.texture, spec);
    return target;
  }

  private applySampling(texture: THREE.Texture, spec: TargetSpec): void {
    const T = this.context.three;

    const wrap =
      spec.wrap === 'repeat'
        ? T.RepeatWrapping
        : spec.wrap === 'mirror'
          ? T.MirroredRepeatWrapping
          : T.ClampToEdgeWrapping;

    texture.wrapS = wrap;
    texture.wrapT = wrap;
    texture.magFilter = spec.filter === 'nearest' ? T.NearestFilter : T.LinearFilter;
    texture.minFilter = texture.magFilter;
    texture.generateMipmaps = false;
  }

  /** Take the snapshot every feedback channel in this frame will read from. */
  beginFrame(): void {
    this.previousFrame.clear();
    for (const [id, entry] of this.entries) {
      this.previousFrame.set(id, entry.targets[entry.front].texture);
    }
  }

  /** The most recently finished frame of a buffer: what a plain binding samples. */
  front(id: string): THREE.Texture | null {
    const entry = this.entries.get(id);
    return entry ? entry.targets[entry.front].texture : null;
  }

  /** The frame before this one: what a feedback binding samples. */
  previous(id: string): THREE.Texture | null {
    return this.previousFrame.get(id) ?? this.front(id);
  }

  /** The target a buffer draws into this frame — never the one it is sampling. */
  write(id: string): THREE.WebGLRenderTarget | null {
    const entry = this.entries.get(id);
    return entry ? entry.targets[entry.front === 0 ? 1 : 0] : null;
  }

  /** Promote what was just drawn to be the buffer's current frame. */
  swap(id: string): void {
    const entry = this.entries.get(id);
    if (entry) entry.front = entry.front === 0 ? 1 : 0;
  }

  size(id: string): Viewport | null {
    const entry = this.entries.get(id);
    return entry ? { width: entry.width, height: entry.height } : null;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  allocations(): readonly BufferAllocation[] {
    const result: BufferAllocation[] = [];
    for (const [id, entry] of this.entries) {
      result.push({
        id,
        width: entry.width,
        height: entry.height,
        bytes: entry.width * entry.height * RGBA16F_BYTES_PER_PIXEL * RENDER_TARGETS_PER_BUFFER,
      });
    }
    return result;
  }

  /**
   * The GPU state died with the context: the targets are husks. Rebuild them at
   * the size they had, so a restored context comes back with the same pipeline
   * rather than a missing one. The *contents* are gone — a feedback buffer starts
   * its history again, which is the one thing a context loss genuinely costs.
   */
  invalidate(specs: readonly TargetSpec[]): void {
    for (const entry of this.entries.values()) this.disposeEntry(entry);
    this.entries.clear();
    this.previousFrame.clear();
    this.sync(specs, this.viewport);
  }

  dispose(): void {
    for (const entry of this.entries.values()) this.disposeEntry(entry);
    this.entries.clear();
    this.previousFrame.clear();
  }

  private disposeEntry(entry: Entry): void {
    for (const target of entry.targets) target.dispose();
  }
}
