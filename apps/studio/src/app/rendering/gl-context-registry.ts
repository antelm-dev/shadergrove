import { Injectable, computed, signal, type Signal } from '@angular/core';

import { GlContext, type GlContextOptions } from '@shadergrove/rendering';

/**
 * Every live WebGL context in the app, keyed by id.
 *
 * The registry holds no rendering state of its own — it is a directory, not a
 * god object. Destroying one entry disposes exactly that context and leaves the
 * others rendering, which is the whole point of having it: without a registry
 * the only place a second context could be tracked is a module-level variable,
 * and that variable is precisely the single-context assumption.
 */
@Injectable({ providedIn: 'root' })
export class GlContextRegistry {
  private readonly contexts = signal<readonly GlContext[]>([]);

  /** The live contexts, in creation order. */
  readonly all: Signal<readonly GlContext[]> = this.contexts.asReadonly();
  readonly ids = computed(() => this.contexts().map((context) => context.id));
  readonly size = computed(() => this.contexts().length);

  async create(canvas: HTMLCanvasElement, options: GlContextOptions = {}): Promise<GlContext> {
    if (options.id !== undefined && this.get(options.id)) {
      throw new Error(`A WebGL context with id "${options.id}" already exists.`);
    }

    const context = await GlContext.create(canvas, options);

    // Disposing a context is the one way it leaves the registry, whether that
    // came from `destroy()` here or from the owner calling `dispose()` itself.
    context.onDispose(() => {
      this.contexts.update((contexts) => contexts.filter((entry) => entry !== context));
    });

    this.contexts.update((contexts) => [...contexts, context]);
    return context;
  }

  get(id: string): GlContext | undefined {
    return this.contexts().find((context) => context.id === id);
  }

  /** Disposes one context. Every other context keeps rendering. */
  destroy(id: string): boolean {
    const context = this.get(id);
    if (!context) return false;
    context.dispose();
    return true;
  }

  destroyAll(): void {
    for (const context of this.contexts()) context.dispose();
  }
}
