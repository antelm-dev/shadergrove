import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { TextureFilterMode, TextureWrapMode } from '@shadergrove/shared';
import { GlContext, ownerOf, type GlBackend, type ThreeModule } from '../gl-context';
import { FakeTexture, fakeBackend, fakeThree } from '../testing/fake-gl';
import { TextureManager, type ChannelSource } from './texture-manager';

/**
 * The image half of a shader's channels, on its own.
 *
 * `fake-gl`'s `TextureLoader` decodes synchronously, which is exactly wrong for
 * the two questions worth asking here — what `ready` says *while* an image is
 * still in flight, and what happens when a decode lands after the slot that
 * wanted it is gone. So this file brings its own loader: one that hands back an
 * empty texture and parks the callback until a test says otherwise, which is
 * what a real network does.
 */

interface PendingLoad {
  url: string;
  texture: FakeTexture;
  settle: () => void;
  fail: (error: unknown) => void;
}

/** three, but with a `TextureLoader` whose decodes finish when the test says. */
function deferredBackend(): { backend: GlBackend; loads: PendingLoad[] } {
  const loads: PendingLoad[] = [];

  const { backend } = fakeBackend();

  backend.three = {
    ...fakeThree,
    TextureLoader: class {
      load(
        url: string,
        onLoad?: (texture: FakeTexture) => void,
        _onProgress?: unknown,
        onError?: (error: unknown) => void,
      ): FakeTexture {
        const texture = new FakeTexture(url);
        loads.push({
          url,
          texture,
          settle: () => onLoad?.(texture),
          fail: (error) => onError?.(error),
        });
        return texture;
      }
    },
  } as unknown as ThreeModule;

  return { backend, loads };
}

function source(url: string, overrides: Partial<Omit<ChannelSource, 'url'>> = {}): ChannelSource {
  return { url, wrap: 'clamp', filter: 'linear', flipY: true, ...overrides };
}

describe('TextureManager', () => {
  let context: GlContext;
  let loads: PendingLoad[];
  let textures: TextureManager;
  let warn: Mock<(message: string) => void>;

  beforeEach(async () => {
    const fake = deferredBackend();
    loads = fake.loads;

    context = await GlContext.create(document.createElement('canvas'), {
      id: 'textures',
      backend: fake.backend,
    });

    warn = vi.fn<(message: string) => void>();
    textures = new TextureManager(context, { warn });
  });

  afterEach(() => {
    textures.dispose();
    context.dispose();
  });

  // ---------------------------------------------------------------------------
  // The placeholder
  // ---------------------------------------------------------------------------

  it('resolves an unassigned channel to the one shared transparent placeholder', () => {
    expect(textures.resolve(null)).toBe(textures.placeholder);
    expect(textures.resolveSlot(2)).toBe(textures.placeholder);

    // Nothing was downloaded to say "there is no image here".
    expect(loads).toHaveLength(0);
  });

  it('tags every texture it makes with the owning context', () => {
    expect(ownerOf(textures.placeholder)).toBe('textures');
    expect(ownerOf(textures.resolve(source('a.png')))).toBe('textures');
  });

  // ---------------------------------------------------------------------------
  // The cache
  // ---------------------------------------------------------------------------

  it('returns the same texture for the same descriptor, and loads it once', () => {
    const first = textures.resolve(source('a.png'));
    const second = textures.resolve(source('a.png'));

    expect(second).toBe(first);
    expect(loads).toHaveLength(1);
  });

  it('keys the cache on the sampling settings, not just the url', () => {
    const base = textures.resolve(source('a.png'));

    const variants: ChannelSource[] = [
      source('a.png', { wrap: 'repeat' }),
      source('a.png', { filter: 'nearest' }),
      source('a.png', { flipY: false }),
      source('b.png'),
    ];

    for (const variant of variants) {
      expect(textures.resolve(variant)).not.toBe(base);
    }
    expect(loads).toHaveLength(1 + variants.length);
  });

  it('applies wrap, filter, mipmaps and flipY to the texture it hands back', () => {
    const wraps: [TextureWrapMode, number][] = [
      ['clamp', fakeThree.ClampToEdgeWrapping],
      ['repeat', fakeThree.RepeatWrapping],
      ['mirror', fakeThree.MirroredRepeatWrapping],
    ];

    for (const [mode, expected] of wraps) {
      const texture = textures.resolve(source('w.png', { wrap: mode })) as unknown as FakeTexture;
      expect(texture.wrapS).toBe(expected);
      expect(texture.wrapT).toBe(expected);
    }

    const filters: [TextureFilterMode, number][] = [
      ['linear', fakeThree.LinearFilter],
      ['nearest', fakeThree.NearestFilter],
    ];

    for (const [mode, expected] of filters) {
      const texture = textures.resolve(source('f.png', { filter: mode })) as unknown as FakeTexture;
      expect(texture.magFilter).toBe(expected);
      // Mipmaps are never generated: a shader samples these at one level, and a
      // mip chain on a non-power-of-two image is a silent black texture.
      expect(texture.minFilter).toBe(expected);
      expect(texture.generateMipmaps).toBe(false);
    }

    const flipped = textures.resolve(source('y.png', { flipY: false })) as unknown as FakeTexture;
    expect(flipped.flipY).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Slots and pruning
  // ---------------------------------------------------------------------------

  it('pads a short slot list out to four', () => {
    textures.setSlots([source('a.png')]);

    expect(textures.slots).toHaveLength(4);
    expect(textures.slots[0]?.url).toBe('a.png');
    expect(textures.slots[3]).toBeNull();
  });

  it('frees a cached texture the moment no slot names it', () => {
    textures.setSlots([source('a.png'), null, null, null]);
    const a = textures.resolveSlot(0) as unknown as FakeTexture;

    // Still referenced: a re-set of the same slots keeps it.
    textures.setSlots([source('a.png'), null, null, null]);
    expect(a.disposed).toBe(false);
    expect(textures.resolveSlot(0)).toBe(a);

    textures.setSlots([source('b.png'), null, null, null]);

    expect(a.disposed).toBe(true);
    // And it really left the cache: asking for it again is a fresh load.
    const loadsBefore = loads.length;
    expect(textures.resolve(source('a.png'))).not.toBe(a);
    expect(loads.length).toBe(loadsBefore + 1);
  });

  it('keeps a texture that merely moved to a different slot', () => {
    textures.setSlots([source('a.png'), null, null, null]);
    const a = textures.resolveSlot(0);

    textures.setSlots([null, source('a.png'), null, null]);

    expect((a as unknown as FakeTexture).disposed).toBe(false);
    expect(textures.resolveSlot(1)).toBe(a);
    expect(textures.resolveSlot(0)).toBe(textures.placeholder);
  });

  // ---------------------------------------------------------------------------
  // Readiness
  // ---------------------------------------------------------------------------

  it('is not ready until every live channel has decoded', () => {
    textures.setSlots([source('a.png'), source('b.png'), null, null]);
    textures.resolveSlot(0);
    textures.resolveSlot(1);

    expect(textures.ready).toBe(false);

    loads[0].settle();
    expect(textures.ready).toBe(false);

    loads[1].settle();
    expect(textures.ready).toBe(true);
  });

  it('counts a failed load as settled, and reports it', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    textures.setSlots([source('missing.png'), null, null, null]);
    textures.resolveSlot(0);
    expect(textures.ready).toBe(false);

    loads[0].fail(new Error('404'));

    // A channel that will never arrive must not hold a transition open forever.
    expect(textures.ready).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('missing.png'));
    expect(consoleWarn).toHaveBeenCalled();

    consoleWarn.mockRestore();
  });

  it('notifies once per channel that settles', () => {
    const settled = vi.fn();
    textures.onSettled = settled;

    textures.setSlots([source('a.png'), source('b.png'), null, null]);
    textures.resolveSlot(0);
    textures.resolveSlot(1);

    loads[0].settle();
    loads[1].settle();

    expect(settled).toHaveBeenCalledTimes(2);
  });

  /**
   * The rapid-switch bug this file exists for. Clicking through shaders faster
   * than the images decode leaves callbacks in flight for a project nobody is
   * looking at any more; releasing the current transition on one of them shows
   * the new shader before its own textures have arrived.
   */
  it('drops a decode that lands after its texture was pruned', () => {
    const settled = vi.fn();
    textures.onSettled = settled;

    textures.setSlots([source('old.png'), null, null, null]);
    textures.resolveSlot(0);

    // The user moved on before `old.png` came back.
    textures.setSlots([source('new.png'), null, null, null]);
    textures.resolveSlot(0);

    loads[0].settle();

    expect(settled).not.toHaveBeenCalled();
    // …and the shader actually on screen is still waiting for its own image.
    expect(textures.ready).toBe(false);

    loads[1].settle();
    expect(settled).toHaveBeenCalledTimes(1);
    expect(textures.ready).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Context loss and teardown
  // ---------------------------------------------------------------------------

  it('marks every texture for re-upload after the context comes back', () => {
    textures.setSlots([source('a.png'), source('b.png'), null, null]);
    const a = textures.resolveSlot(0) as unknown as FakeTexture;
    const b = textures.resolveSlot(1) as unknown as FakeTexture;
    a.needsUpdate = false;
    b.needsUpdate = false;
    (textures.placeholder as unknown as FakeTexture).needsUpdate = false;

    textures.invalidate();

    expect(a.needsUpdate).toBe(true);
    expect(b.needsUpdate).toBe(true);
    expect((textures.placeholder as unknown as FakeTexture).needsUpdate).toBe(true);
  });

  it('counts the placeholder and deduplicates shared textures in allocations', () => {
    expect(textures.textureAllocations().totalBytes).toBe(4);

    textures.setSlots([source('shared.png'), source('shared.png'), null, null]);
    textures.resolveSlot(0);
    textures.resolveSlot(1);
    expect(textures.textureAllocations().totalBytes).toBeNull();

    const texture = loads[0].texture as FakeTexture & { image?: { width: number; height: number } };
    texture.image = { width: 8, height: 4 };
    loads[0].settle();

    const allocations = textures.textureAllocations();
    expect(allocations.totalBytes).toBe(4 + 8 * 4 * 4);
    expect(allocations.items[0]?.bytes).toBe(8 * 4 * 4);
    expect(allocations.items[1]?.bytes).toBe(8 * 4 * 4);
  });

  it('disposes everything it made, repeatedly and safely', () => {
    textures.setSlots([source('a.png'), null, null, null]);
    const a = textures.resolveSlot(0) as unknown as FakeTexture;
    const placeholder = textures.placeholder as unknown as FakeTexture;

    textures.dispose();
    textures.dispose();

    expect(a.disposed).toBe(true);
    expect(placeholder.disposed).toBe(true);

    // Nothing new is allocated on a corpse, and a decode still in flight is
    // dropped rather than fired at whoever was listening.
    const settled = vi.fn();
    textures.onSettled = settled;
    expect(textures.resolve(source('c.png'))).toBe(textures.placeholder);
    textures.setSlots([source('c.png'), null, null, null]);
    loads[0].settle();

    expect(settled).not.toHaveBeenCalled();
    expect(loads).toHaveLength(1);
  });
});
