import type { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

import type { VignetteSettings } from '@shadergrove/shared';

/**
 * A resolution-independent vignette: every quantity in the fragment shader is
 * derived from `vUv`, so the effect needs no resolution uniform and there is
 * nothing for `PostProcessing.setSize` to feed it on a resize — unlike Bloom,
 * whose kernel is sized in real pixels.
 *
 * `roundness` blends the darkened shape between one that hugs the screen's
 * own rectangle (0) and a perfect circle (1); `softness` controls how sharp
 * the transition from clear to vignetted is; `intensity` blends the whole
 * effect between untouched (0) and fully applied (1). Alpha passes through
 * unchanged — this runs after the final Image pass, and the composer's own
 * output must stay whatever alpha that pass produced.
 */
export const VIGNETTE_SHADER = {
  name: 'VignetteShader',
  uniforms: {
    tDiffuse: { value: null },
    uIntensity: { value: 0 },
    uSoftness: { value: 0.5 },
    uRoundness: { value: 0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uIntensity;
    uniform float uSoftness;
    uniform float uRoundness;
    varying vec2 vUv;

    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);

      vec2 centered = vUv - 0.5;
      // roundness 0: a shape that reaches full strength at the screen's own
      // corners (a "rectangular" vignette). roundness 1: a perfect circle,
      // which clips before the corners on a non-square viewport.
      float rectangular = clamp(
        (0.25 - centered.x * centered.x) * (0.25 - centered.y * centered.y) * 16.0,
        0.0,
        1.0
      );
      float circular = clamp(1.0 - dot(centered, centered) * 4.0, 0.0, 1.0);
      float shape = mix(rectangular, circular, clamp(uRoundness, 0.0, 1.0));

      // Softness bends the falloff curve: near 0 the transition is sharp,
      // near 1 it is a gentle gradient.
      float softness = max(uSoftness, 0.0001);
      float vignette = pow(shape, 1.0 / softness);
      float darken = mix(1.0, vignette, clamp(uIntensity, 0.0, 1.0));

      gl_FragColor = vec4(texel.rgb * darken, texel.a);
    }
  `,
};

/** Pushes live settings into an already-built pass's uniforms. Never rebuilds it. */
export function setVignetteUniforms(pass: ShaderPass, settings: VignetteSettings): void {
  pass.uniforms['uIntensity'].value = settings.intensity;
  pass.uniforms['uSoftness'].value = settings.softness;
  pass.uniforms['uRoundness'].value = settings.roundness;
}
