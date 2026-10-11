import type * as THREE from 'three';

import {
  UNIFORM_PREFIX,
  type CustomEffect,
  type CustomEffectDefinition,
  type ShaderControl,
  type ShaderParams,
} from '@shadergrove/shared';
import type { CompileDiagnostic } from '@shadergrove/shared/diagnostic';
import { uniformType } from '@shadergrove/shared/glsl-export';

import type { GlContext } from '../gl-context';
import { probeProgram } from './shader-probe';
import type { UniformMap } from './uniform-registry';

/**
 * A custom post-processing effect, API v1, as a program the driver can run.
 *
 * The author writes `vec4 effect(vec4 color, vec2 uv)`. Everything around it is
 * the app's: the full-screen vertex stage, the uniforms (`tDiffuse`, the frame
 * so far; `u_resolution`; `u_time`; one `u_<key>` per control, local to this
 * effect) and a `main` that samples the previous frame and hands it over. That
 * is the whole of what `apiVersion: 1` promises, so a later backend has exactly
 * this to reproduce.
 */

/** Effects get editor documents of their own, so their errors land on their code. */
export const effectDocId = (instanceId: string): string => `@effect/${instanceId}`;

export const CUSTOM_EFFECT_VERTEX = `varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 1.0);
}`;

/** The full fragment for a definition, and how many generated lines precede the author's. */
export function composeCustomEffect(definition: CustomEffectDefinition): {
  fragment: string;
  headerLines: number;
} {
  const header = [
    'uniform sampler2D tDiffuse;',
    'uniform vec2 u_resolution;',
    'uniform float u_time;',
    ...definition.controls.map(
      (control) => `uniform ${uniformType(control)} ${UNIFORM_PREFIX}${control.key};`,
    ),
    'varying vec2 vUv;',
  ];
  const fragment = [
    ...header,
    definition.source,
    'void main() { gl_FragColor = effect(texture2D(tDiffuse, vUv), vUv); }',
  ].join('\n');
  return { fragment, headerLines: header.length };
}

/**
 * What the compiled program depends on: the code and the declared controls.
 * Two effects with the same key share nothing, but one effect whose key is
 * unchanged needs no recompile — its values are only uniforms.
 */
export function customEffectKey(definition: CustomEffectDefinition): string {
  return JSON.stringify([definition.source, definition.controls]);
}

/** Pushes one effect's values into its uniforms. Never rebuilds anything. */
export function applyCustomValues(
  uniforms: UniformMap,
  controls: readonly ShaderControl[],
  values: ShaderParams,
): void {
  for (const control of controls) {
    const uniform = uniforms[UNIFORM_PREFIX + control.key];
    if (!uniform) continue;
    const value = values[control.key] ?? control.default;
    if (control.type === 'color') (uniform.value as THREE.Color).set(String(value));
    else uniform.value = value;
  }
}

/**
 * Builds and probes custom-effect programs on a 1×1 target of its own, the same
 * way `PassCompiler` does for passes: a candidate the driver rejects is
 * disposed and comes back as diagnostics, attributed to the author's lines.
 */
export class CustomEffectCompiler {
  private readonly scene: THREE.Scene;
  private readonly mesh: THREE.Mesh;
  private readonly target: THREE.WebGLRenderTarget;
  private readonly geometry: THREE.BufferGeometry;

  constructor(
    private readonly context: GlContext,
    private readonly camera: THREE.Camera,
  ) {
    const T = context.three;
    this.geometry = context.own(new T.PlaneGeometry(2, 2));
    this.scene = new T.Scene();
    this.mesh = new T.Mesh(this.geometry);
    this.scene.add(this.mesh);
    this.target = context.own(
      new T.WebGLRenderTarget(1, 1, { depthBuffer: false, stencilBuffer: false }),
    );
  }

  /** An accepted material with its values applied, or what the driver said about it. */
  build(
    effect: CustomEffect,
    time: number,
    resolution: { x: number; y: number },
  ): { material: THREE.ShaderMaterial } | { diagnostics: CompileDiagnostic[] } {
    const T = this.context.three;
    const { definition } = effect;
    const { fragment, headerLines } = composeCustomEffect(definition);

    const uniforms: UniformMap = {
      tDiffuse: { value: null },
      u_resolution: { value: new T.Vector2(resolution.x, resolution.y) },
      u_time: { value: time },
    };
    for (const control of definition.controls) {
      uniforms[UNIFORM_PREFIX + control.key] = {
        value: control.type === 'color' ? new T.Color() : control.default,
      };
    }
    applyCustomValues(uniforms, definition.controls, effect.values);

    const material = new T.ShaderMaterial({
      vertexShader: CUSTOM_EFFECT_VERTEX,
      fragmentShader: fragment,
      uniforms,
    });

    this.mesh.material = material;
    const raw = probeProgram(
      this.context.renderer,
      this.scene,
      this.camera,
      this.target,
      fragment,
      CUSTOM_EFFECT_VERTEX,
    );
    if (raw.length === 0) return { material };

    material.dispose();
    const userLines = definition.source.split('\n').length;
    const docId = effectDocId(effect.instanceId);
    return {
      diagnostics: raw.map((diagnostic) => {
        const line = diagnostic.line - headerLines;
        return {
          ...diagnostic,
          // A line outside the author's code is in what the app generated around it.
          line: line >= 1 && line <= userLines ? line : 0,
          source: 'fragment',
          docId,
          docName: definition.name,
        };
      }),
    };
  }

  dispose(): void {
    this.target.dispose();
    this.geometry.dispose();
  }
}
