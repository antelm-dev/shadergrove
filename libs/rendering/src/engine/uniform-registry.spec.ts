import { describe, expect, it } from 'vitest';

import type { ShaderControl } from '@shadergrove/shared';

import { UniformRegistry, type UniformMap } from './uniform-registry';

/**
 * The registry is the only thing allowed to write a uniform across more than one
 * pass, so what is under test is *reach*: which maps a write lands in, and —
 * just as importantly — which it lands in exactly once.
 */

function map(entries: Record<string, unknown>): UniformMap {
  return Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, { value }]));
}

const CONTROLS: readonly ShaderControl[] = [
  { key: 'speed', label: 'Speed', type: 'number', default: 1, min: 0, max: 2, step: 0.01 },
];

describe('UniformRegistry', () => {
  it('broadcasts a built-in to every registered pass', () => {
    const registry = new UniformRegistry();
    const a = map({ iTime: 0 });
    const b = map({ iTime: 0 });

    registry.replace([
      { id: 'a', uniforms: a },
      { id: 'b', uniforms: b },
    ]);
    registry.setBuiltIn('iTime', (uniform) => (uniform.value = 4));

    expect(a['iTime'].value).toBe(4);
    expect(b['iTime'].value).toBe(4);
  });

  it('skips a pass that does not declare the uniform', () => {
    const registry = new UniformRegistry();
    const bare = map({ iResolution: 0 });

    registry.register('bare', bare);
    expect(() => registry.setBuiltIn('iTime', (uniform) => (uniform.value = 1))).not.toThrow();
    expect(bare['iTime']).toBeUndefined();
  });

  it('writes a built-in to the primary map even when nothing is registered', () => {
    // What a lost context leaves behind: the programs are gone, but the last
    // accepted Image uniforms are still what every single-value read goes to.
    const registry = new UniformRegistry();
    const primary = map({ iTime: 0 });

    registry.setPrimary(primary);
    registry.unregisterAll();
    registry.setBuiltIn('iTime', (uniform) => (uniform.value = 7));

    expect(primary['iTime'].value).toBe(7);
  });

  it('writes a built-in to a registered primary map exactly once', () => {
    const registry = new UniformRegistry();
    const primary = map({ iTime: 0 });

    registry.setPrimary(primary);
    registry.replace([{ id: 'image', uniforms: primary }]);

    let writes = 0;
    registry.setBuiltIn('iTime', () => writes++);

    expect(writes).toBe(1);
  });

  it('drives a control across every registered pass, but not the primary map alone', () => {
    const registry = new UniformRegistry();
    const buffer = map({ u_speed: 1 });
    const detached = map({ u_speed: 1 });

    registry.setControls(CONTROLS);
    registry.setPrimary(detached);
    registry.replace([{ id: 'buffer', uniforms: buffer }]);

    registry.setParam('speed', 3);

    expect(buffer['u_speed'].value).toBe(3);
    // A control belongs to the passes actually running it. A detached map is a
    // dead program's; pushing parameters into it would be writing to nothing.
    expect(detached['u_speed'].value).toBe(1);
  });

  it('applies only the params it is given', () => {
    const registry = new UniformRegistry();
    const uniforms = map({ u_speed: 1 });

    registry.setControls(CONTROLS);
    registry.register('image', uniforms);
    registry.setParams({});

    expect(uniforms['u_speed'].value).toBe(1);

    registry.setParams({ speed: 2 });
    expect(uniforms['u_speed'].value).toBe(2);
  });

  it('mutates a colour uniform rather than replacing it', () => {
    // Colour uniforms hold a `THREE.Color`; three uploads the object it was
    // given, so replacing it with a string would break the next draw.
    const colour = { set: (value: string) => (seen = value) };
    let seen = '';

    const registry = new UniformRegistry();
    const uniforms: UniformMap = { u_tint: { value: colour } };

    registry.setControls([{ key: 'tint', label: 'Tint', type: 'color', default: '#000000' }]);
    registry.register('image', uniforms);
    registry.setParam('tint', '#ff0000');

    expect(uniforms['u_tint'].value).toBe(colour);
    expect(seen).toBe('#ff0000');
  });

  it('seeds one map from controls and their defaults', () => {
    const registry = new UniformRegistry();
    const uniforms = map({ u_speed: 0 });

    registry.applyControls(uniforms, CONTROLS, {});
    expect(uniforms['u_speed'].value).toBe(1);

    registry.applyControls(uniforms, CONTROLS, { speed: 1.5 });
    expect(uniforms['u_speed'].value).toBe(1.5);
  });

  it('replaces the whole registration list, in order', () => {
    const registry = new UniformRegistry();

    registry.replace([
      { id: 'a', uniforms: map({}) },
      { id: 'b', uniforms: map({}) },
    ]);
    expect(registry.ids).toEqual(['a', 'b']);

    registry.replace([{ id: 'b', uniforms: map({}) }]);
    expect(registry.ids).toEqual(['b']);

    registry.unregister('b');
    expect(registry.ids).toEqual([]);
  });

  it('keeps the primary map across an unregisterAll', () => {
    const registry = new UniformRegistry();
    const primary = map({ iResolution: 800 });

    registry.setPrimary(primary);
    registry.register('image', primary);
    registry.unregisterAll();

    expect(registry.ids).toEqual([]);
    expect(registry.value('iResolution')).toBe(800);
  });
});
