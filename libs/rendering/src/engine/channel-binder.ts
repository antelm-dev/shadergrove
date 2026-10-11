import type * as THREE from 'three';

import type { ChannelBinding, ChannelBindings } from '@shadergrove/shared';
import type { BufferTargets } from '../pass-targets';
import { CHANNEL_COUNT, type TextureManager } from './texture-manager';
import type { UniformMap } from './uniform-registry';

/**
 * What `iChannel0…3` are pointing at, right now.
 *
 * A binding is a *description* — "slot 2", "buffer B's previous frame" — and the
 * two halves of turning one into a `THREE.Texture` are owned elsewhere and stay
 * there: image slots by `TextureManager`, buffer targets by `BufferTargets`.
 * This is only the join between them, which has to exist somewhere because a
 * binding can name either and neither owner is allowed to know about the other.
 *
 * The reason this is done immediately before a pass is drawn, every frame,
 * rather than once at compile time, is that there is no stable answer: a buffer
 * binding names a texture that ping-pongs, so the object behind it changes every
 * frame, and a feedback binding deliberately names the *other* one. Baking the
 * result into a uniform at compile time would freeze a pass on whichever half of
 * the pair happened to be in front when it was built.
 *
 * Nothing is allocated or freed here.
 */
export const CHANNEL_UNIFORMS = ['iChannel0', 'iChannel1', 'iChannel2', 'iChannel3'] as const;

export class ChannelBinder {
  constructor(
    private readonly textures: TextureManager,
    private readonly targets: BufferTargets,
  ) {}

  /**
   * The texture a binding names, at this instant.
   *
   * A buffer whose target does not exist yet — the first moment after one is
   * added, before the pool has been synced — resolves to the transparent
   * placeholder rather than to nothing, so a sampler is never left unbound.
   */
  resolve(binding: ChannelBinding | undefined): THREE.Texture {
    switch (binding?.kind) {
      case 'texture':
        return this.textures.resolveSlot(binding.slot);
      case 'buffer':
        return (
          (binding.feedback
            ? this.targets.previous(binding.passId)
            : this.targets.front(binding.passId)) ?? this.textures.placeholder
        );
      case 'none':
      default:
        return this.textures.placeholder;
    }
  }

  /** Point a map's four samplers at the textures its bindings currently name. */
  bind(uniforms: UniformMap, channels: ChannelBindings): void {
    for (let index = 0; index < CHANNEL_COUNT; index++) {
      const uniform = uniforms[CHANNEL_UNIFORMS[index]];
      if (!uniform) continue;
      uniform.value = this.resolve(channels[index]);
    }
  }

  /** What a map's `iChannelN` is bound to, without resolving anything anew. */
  textureOf(uniforms: UniformMap, index: number): THREE.Texture | null {
    return (uniforms[CHANNEL_UNIFORMS[index]]?.value as THREE.Texture | undefined) ?? null;
  }
}
