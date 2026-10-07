import type * as THREE from 'three';

import type { TextureFilterMode, TextureWrapMode } from '@shadergrove/shared';
import type { GlContext } from '../gl-context';

/**
 * The shader's four *image* slots, and every `THREE.Texture` behind them.
 *
 * This is the image half of a pass's channels; the buffer half lives in
 * `BufferTargets` and is deliberately not reachable from here. A `texture`
 * binding names a slot, a slot names a URL plus its sampling settings, and this
 * is what turns that description into something the GPU can sample. Nothing here
 * knows what a pass is, which channel of which pass points at slot 2, or that
 * buffers exist at all — resolving a *binding* stays with the engine, because
 * only the engine can see both halves.
 *
 * Two things make it more than a `Map<string, Texture>`:
 *
 * **Loading is asynchronous and the engine cannot wait for it.** `load()` hands
 * back an empty texture that fills itself in when the image decodes, so binding
 * a channel never blocks a compile on the network. Callers that *do* need to
 * know — a thumbnail, a capture, a cross-fade holding off until the new shader
 * actually looks like itself — get `ready` and `onSettled` instead.
 *
 * **Textures outlive the slots that referenced them, briefly.** Switching
 * shaders replaces all four slots at once, and the textures the old ones used
 * are freed straight away rather than at some later collection — but a decode
 * that was already in flight will still call back, into a key that no longer
 * exists. That callback belongs to a project nobody is looking at any more, and
 * releasing the current transition on it would be a real bug: the status map is
 * the authority, and a key it has forgotten is a callback that is dropped.
 *
 * Every texture is tagged with the owning `GlContext`, as all the renderer's GPU
 * resources are, so one engine can never bind — or free — another's.
 */

/** A channel resolved to something `THREE.TextureLoader` can actually load. */
export interface ChannelSource {
  url: string;
  wrap: TextureWrapMode;
  filter: TextureFilterMode;
  flipY: boolean;
}

export const CHANNEL_COUNT = 4;

const CHANNEL_INDICES = [0, 1, 2, 3] as const;

/** Decode state. Absent means "not ours" — see the note on late callbacks above. */
type LoadStatus = 'loading' | 'settled';

export interface TextureManagerOptions {
  /** Where a failed load is reported, beyond the console. */
  warn?: (message: string) => void;
}

/** Keyed by every input that changes the resulting GPU object, not just the URL. */
function cacheKey(source: ChannelSource): string {
  return `${source.url}|${source.wrap}|${source.filter}|${source.flipY}`;
}

function decodedTextureDimensions(
  texture: THREE.Texture,
): { width: number; height: number } | null {
  const image = texture.image as { width?: number; height?: number } | undefined;
  if (!image || typeof image.width !== 'number' || typeof image.height !== 'number') return null;
  if (image.width <= 0 || image.height <= 0) return null;
  return { width: image.width, height: image.height };
}

export class TextureManager {
  /**
   * A fully transparent 1×1 pixel: what an unassigned iChannel samples, so a
   * shader that declares `uniform sampler2D iChannelN` always compiles and
   * renders sensibly, with or without an image behind it.
   */
  readonly placeholder: THREE.Texture;

  /** Keyed by `url|wrap|filter|flipY`, so swapping settings on the same image gets its own entry. */
  private readonly cache = new Map<string, THREE.Texture>();

  /** Decode state for cached image textures; a transition waits until none are still loading. */
  private readonly status = new Map<string, LoadStatus>();

  /** Keys whose decode failed: settled like any other, but with nothing behind them. */
  private readonly failed = new Set<string>();

  private live: readonly (ChannelSource | null)[] = [null, null, null, null];

  private disposed = false;

  /** Fired when an asynchronously decoded channel either becomes usable or fails. */
  onSettled: (() => void) | null = null;

  constructor(
    private readonly context: GlContext,
    private readonly options: TextureManagerOptions = {},
  ) {
    const T = context.three;

    this.placeholder = context.own(
      new T.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, T.RGBAFormat),
    );
    this.placeholder.needsUpdate = true;
  }

  /** The four slots as they stand. `null` means nothing is assigned. */
  get slots(): readonly (ChannelSource | null)[] {
    return this.live;
  }

  /**
   * Replace all four slots. The only thing that changes the live descriptor set,
   * and so the only thing that prunes: a texture is kept alive by being named by
   * a slot, and freed the moment it stops being.
   */
  setSlots(channels: readonly (ChannelSource | null)[]): void {
    if (this.disposed) return;

    this.live = [
      channels[0] ?? null,
      channels[1] ?? null,
      channels[2] ?? null,
      channels[3] ?? null,
    ];
    this.prune();
  }

  /** The texture for one slot, placeholder included. */
  resolveSlot(index: number): THREE.Texture {
    return this.resolve(this.live[index] ?? null);
  }

  /**
   * Gets or creates the `THREE.Texture` for a resolved channel. `load()`
   * returns synchronously — an empty texture that fills itself in once the
   * image decodes — so binding a channel never blocks a compile on the
   * network or disk, matching the contract the rest of the engine keeps.
   */
  resolve(source: ChannelSource | null): THREE.Texture {
    if (!source || this.disposed) return this.placeholder;

    const key = cacheKey(source);
    const cached = this.cache.get(key);
    if (cached) return cached;

    this.status.set(key, 'loading');
    const texture = this.context.own(
      new this.context.three.TextureLoader().load(
        source.url,
        () => this.settle(key),
        undefined,
        (error) => {
          console.warn(`[shader-engine] failed to load texture "${source.url}":`, error);
          this.options.warn?.(`Failed to load texture "${source.url}": ${String(error)}`);
          this.failed.add(key);
          this.settle(key);
        },
      ),
    );

    this.applySampling(texture, source);

    this.cache.set(key, texture);
    return texture;
  }

  /** What is actually behind a slot: nothing assigned, still decoding, failed, or usable. */
  slotState(index: number): 'empty' | 'loading' | 'failed' | 'ready' {
    const source = this.live[index] ?? null;
    if (!source) return 'empty';
    const key = cacheKey(source);
    if (this.status.get(key) === 'loading') return 'loading';
    return this.failed.has(key) ? 'failed' : 'ready';
  }

  /** True once every image texture used by the current slots has decoded or failed. */
  get ready(): boolean {
    return this.live.every((source) => {
      if (!source) return true;
      return this.status.get(cacheKey(source)) !== 'loading';
    });
  }

  /**
   * Decoded GPU dimensions for uploaded channel textures. Unknown or loading
   * dimensions stay null rather than being guessed.
   */
  textureAllocations(): {
    readonly items: readonly {
      slot: number;
      width: number | null;
      height: number | null;
      bytes: number | null;
    }[];
    readonly totalBytes: number | null;
    readonly estimated: true;
  } {
    const keyBySlot = new Map<number, string>();
    const usedKeys = new Set<string>();

    for (const slot of CHANNEL_INDICES) {
      const source = this.live[slot];
      if (!source) continue;
      const key = cacheKey(source);
      usedKeys.add(key);
      keyBySlot.set(slot, key);
    }

    // Compute unique allocation bytes only once per cached texture.
    const bytesByKey = new Map<string, { width: number; height: number; bytes: number } | null>();
    let incomplete = false;

    for (const key of usedKeys) {
      if (this.status.get(key) === 'loading') {
        bytesByKey.set(key, null);
        incomplete = true;
        continue;
      }

      const texture = this.cache.get(key);
      if (!texture) {
        bytesByKey.set(key, null);
        incomplete = true;
        continue;
      }

      const dimensions = decodedTextureDimensions(texture);
      if (!dimensions) {
        bytesByKey.set(key, null);
        incomplete = true;
        continue;
      }

      const bytes = dimensions.width * dimensions.height * 4;
      bytesByKey.set(key, { width: dimensions.width, height: dimensions.height, bytes });
    }

    const items = CHANNEL_INDICES.map((slot) => {
      const key = keyBySlot.get(slot);
      if (!key) return { slot, width: null, height: null, bytes: null };

      const resolved = bytesByKey.get(key) ?? null;
      if (!resolved) return { slot, width: null, height: null, bytes: null };

      return { slot, width: resolved.width, height: resolved.height, bytes: resolved.bytes };
    });

    // Always-owned transparent 1×1 placeholder (RGBA8).
    const placeholderBytes = 1 * 1 * 4;

    const totalBytes = incomplete
      ? null
      : (() => {
          let sum = placeholderBytes;
          for (const resolved of bytesByKey.values()) {
            if (!resolved) return null;
            sum += resolved.bytes;
          }
          return sum;
        })();

    return { items, totalBytes, estimated: true };
  }

  /**
   * three re-uploads a texture on the next draw, but only if it is told the
   * pixels it holds are new. Nothing survived a context loss on the GPU, so
   * they all are.
   */
  invalidate(): void {
    if (this.disposed) return;

    for (const texture of this.cache.values()) texture.needsUpdate = true;
    this.placeholder.needsUpdate = true;
  }

  /** Frees every texture this manager put on the GPU. Safe to call repeatedly. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const texture of this.cache.values()) texture.dispose();
    this.cache.clear();
    // Emptied, so a decode still in flight settles into a key nobody holds and
    // is dropped rather than firing `onSettled` on a disposed engine.
    this.status.clear();
    this.failed.clear();
    this.placeholder.dispose();

    this.onSettled = null;
  }

  private applySampling(texture: THREE.Texture, source: ChannelSource): void {
    const T = this.context.three;

    const wrap =
      source.wrap === 'repeat'
        ? T.RepeatWrapping
        : source.wrap === 'mirror'
          ? T.MirroredRepeatWrapping
          : T.ClampToEdgeWrapping;

    texture.wrapS = wrap;
    texture.wrapT = wrap;
    texture.magFilter = source.filter === 'nearest' ? T.NearestFilter : T.LinearFilter;
    texture.minFilter = texture.magFilter;
    texture.generateMipmaps = false;
    texture.flipY = source.flipY;
  }

  private settle(key: string): void {
    // A late callback from a texture pruned during a rapid shader switch no
    // longer belongs to the live project and must not release its transition.
    if (!this.status.has(key)) return;
    this.status.set(key, 'settled');
    this.onSettled?.();
  }

  /** Disposes any cached texture no longer referenced by the current slots. */
  private prune(): void {
    const used = new Set(
      this.live.filter((source): source is ChannelSource => source !== null).map(cacheKey),
    );

    for (const [key, texture] of this.cache) {
      if (used.has(key)) continue;
      texture.dispose();
      this.cache.delete(key);
      this.status.delete(key);
      this.failed.delete(key);
    }
  }
}
