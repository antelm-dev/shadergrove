import type * as THREE from 'three';

import {
  UNIFORM_PREFIX,
  type ParamValue,
  type ShaderControl,
  type ShaderParams,
} from '@shadergrove/shared';

/**
 * The one place a uniform is written across more than one pass.
 *
 * A control is a property of the *project*, not of a pass: turning a knob has to
 * reach every buffer that declares it, or a parameter the whole pipeline is
 * built around would only affect its last step. The same is true of the uniforms
 * the engine supplies rather than the author — `iTime` has to tick inside a
 * buffer exactly as it does in the Image pass, or a feedback simulation and the
 * picture of it drift apart.
 *
 * So the maps are collected here and written through here. What this type
 * deliberately does *not* know is what a pass is: it holds
 * `Record<string, THREE.IUniform>` and an id to file it under, and nothing about
 * materials, scenes, compilation or the order things are drawn in. That is what
 * lets the interaction layer push a pointer or a parameter at the whole pipeline
 * without going through — or knowing about — the compiler or the engine.
 *
 * **The primary map** is the Image pass's, and it is what the single-value
 * questions are answered from: the resolution the canvas is at, the momentum a
 * shader asked for, the texture `iChannel2` currently samples. It is set only
 * when an image program is *accepted*, so it survives a context loss that has
 * emptied the registration list — which is why writing a built-in also reaches
 * it even when it is no longer registered.
 */

/** A pass's uniforms, exactly as three.js wants them on a `ShaderMaterial`. */
export type UniformMap = Record<string, THREE.IUniform>;

/** Anything the registry can file: an id, and the uniforms behind it. */
export interface UniformOwner {
  readonly id: string;
  readonly uniforms: UniformMap;
}

export class UniformRegistry {
  /** Registered maps in insertion order — buffers first, Image last, as they are drawn. */
  private readonly entries = new Map<string, UniformMap>();

  private primaryMap: UniformMap = {};

  private declared: readonly ShaderControl[] = [];

  /**
   * The Image pass's uniforms — the map single-value reads are answered from.
   * Never cleared, only replaced, so it outlives a context loss.
   */
  get primary(): UniformMap {
    return this.primaryMap;
  }

  setPrimary(uniforms: UniformMap): void {
    this.primaryMap = uniforms;
  }

  /** The controls the live project declares. Drives `setParams`. */
  get controls(): readonly ShaderControl[] {
    return this.declared;
  }

  setControls(controls: readonly ShaderControl[]): void {
    this.declared = controls;
  }

  /** The ids currently registered, in the order they were registered. */
  get ids(): readonly string[] {
    return [...this.entries.keys()];
  }

  register(id: string, uniforms: UniformMap): void {
    this.entries.set(id, uniforms);
  }

  unregister(id: string): void {
    this.entries.delete(id);
  }

  /**
   * Make the registration list exactly this, in exactly this order. The accepted
   * set changes wholesale on every compile — a pass added, removed, or left
   * alone — so replacing is both cheaper and harder to get wrong than diffing.
   */
  replace(owners: Iterable<UniformOwner>): void {
    this.entries.clear();
    for (const owner of owners) this.entries.set(owner.id, owner.uniforms);
  }

  /**
   * Forget every registration without touching `primary`. What a context loss
   * leaves behind: the programs are gone, but the last accepted Image uniforms
   * are still the answer to "what resolution is the canvas at".
   */
  unregisterAll(): void {
    this.entries.clear();
  }

  /** The value of a uniform on the primary map, if it has one. */
  value(name: string): unknown {
    return this.primaryMap[name]?.value;
  }

  /**
   * Write a uniform the engine owns — `iTime`, `iMouse`, `u_clickData` — on every
   * registered pass, and on the primary map whether or not it is one of them.
   *
   * That last clause is what keeps a shader set while the context was lost, or
   * left over from before one, ticking rather than frozen: its map is detached
   * from the registration list but is still the one every read goes to.
   */
  setBuiltIn(name: string, apply: (uniform: THREE.IUniform) => void): void {
    const written = new Set<UniformMap>();

    for (const uniforms of this.entries.values()) {
      if (written.has(uniforms)) continue;
      written.add(uniforms);
      const uniform = uniforms[name];
      if (uniform) apply(uniform);
    }

    if (written.has(this.primaryMap)) return;
    const uniform = this.primaryMap[name];
    if (uniform) apply(uniform);
  }

  /** Push every control value the project supplies at every registered pass. */
  setParams(params: ShaderParams): void {
    for (const control of this.declared) {
      const value = params[control.key];
      if (value !== undefined) this.setParam(control.key, value);
    }
  }

  /**
   * Drive one control's uniform across every registered pass. A control is the
   * project's, not a pass's: every pass that declares it moves together.
   */
  setParam(key: string, value: ParamValue): void {
    const control = this.declared.find((entry) => entry.key === key);

    for (const uniforms of this.entries.values()) {
      write(uniforms, key, value, control?.type === 'color');
    }
  }

  /**
   * Seed one map from a set of controls and the values for them. Used on a pass
   * whose program was left alone by a compile — its uniforms are live and need
   * the new parameter values, but the registration list has not been rebuilt yet.
   */
  applyControls(
    uniforms: UniformMap,
    controls: readonly ShaderControl[],
    params: ShaderParams,
  ): void {
    for (const control of controls) {
      write(
        uniforms,
        control.key,
        params[control.key] ?? control.default,
        control.type === 'color',
      );
    }
  }
}

/** A colour uniform holds a `THREE.Color` and is mutated; everything else is replaced. */
function write(uniforms: UniformMap, key: string, value: ParamValue, colour: boolean): void {
  const uniform = uniforms[UNIFORM_PREFIX + key];
  if (!uniform) return;

  if (colour) (uniform.value as THREE.Color).set(String(value));
  else uniform.value = value;
}
