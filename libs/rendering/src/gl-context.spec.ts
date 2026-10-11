import { describe, expect, it, vi } from 'vitest';

import { GlContext } from './gl-context';
import { fakeBackend } from './testing/fake-gl';

// The status contract without Angular: a plain read plus the lost/restored/dispose events.
describe('GlContext status', () => {
  it('reports loss, restoration and disposal through status() and its listeners', async () => {
    const canvas = document.createElement('canvas');
    const context = await GlContext.create(canvas, { backend: fakeBackend().backend });
    const lost = vi.fn();
    const restored = vi.fn();
    const disposed = vi.fn();
    const stopLost = context.onLost(lost);
    context.onRestored(restored);
    context.onDispose(disposed);

    expect(context.status()).toBe('live');
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(context.status()).toBe('lost');
    expect(lost).toHaveBeenCalledTimes(1);

    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(context.status()).toBe('live');
    expect(restored).toHaveBeenCalledTimes(1);

    stopLost();
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(context.status()).toBe('lost');
    expect(lost).toHaveBeenCalledTimes(1);

    context.dispose();
    context.dispose();
    expect(context.status()).toBe('disposed');
    expect(disposed).toHaveBeenCalledTimes(1);

    // A disposed context no longer listens to its canvas.
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(context.status()).toBe('disposed');
    expect(restored).toHaveBeenCalledTimes(1);
  });
});
