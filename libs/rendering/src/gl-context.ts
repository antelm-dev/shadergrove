import type * as THREE from 'three';

/**
 * One canvas, one `WebGLRenderer`, one owner.
 *
 * Everything the GPU knows about hangs off a single context: a texture uploaded
 * through renderer A is meaningless to renderer B, and three.js will not tell
 * you so — it silently re-uploads the object into the second context and you
 * get two copies with one `dispose()` between them. `GlContext` is what makes
 * that ownership explicit: resources are tagged as they are created, checked as
 * they are bound, and torn down with the context they belong to.
 *
 * It is also the unit of *failure*. The `webglcontextlost` listener lives on
 * this context's canvas, so a driver reset on one preview cannot be observed —
 * let alone acted on — by another. Losing a context suspends its own renderer
 * and nothing else.
 *
 * three.js is imported through the `backend` seam rather than at module scope:
 * none of it exists on the server, and tests need to stand two contexts up side
 * by side in jsdom, where there is no WebGL at all.
 */

export type ThreeModule = typeof import('three');

export type GlContextStatus = 'live' | 'lost' | 'disposed';

export interface RendererOptions {
  antialias: boolean;
  /** Required to read the drawing buffer back after the frame — see `screenshot()`. */
  preserveDrawingBuffer: boolean;
}

/** The three.js surface a context needs. Swapped out wholesale under test. */
export interface GlBackend {
  three: ThreeModule;
  createRenderer(canvas: HTMLCanvasElement, options: RendererOptions): THREE.WebGLRenderer;
}

export interface GlContextOptions {
  id?: string;
  backend?: GlBackend;
  antialias?: boolean;
  preserveDrawingBuffer?: boolean;
}

/** Thrown when a resource is bound to a context that did not create it. */
export class WrongContextError extends Error {
  constructor(
    readonly label: string,
    readonly ownerId: string | undefined,
    readonly contextId: string,
  ) {
    super(
      ownerId === undefined
        ? `The ${label} was not created by any WebGL context, so it cannot be used with "${contextId}".`
        : `The ${label} belongs to WebGL context "${ownerId}" and cannot be used with "${contextId}".`,
    );
    this.name = 'WrongContextError';
  }
}

/**
 * Non-enumerable so a tagged resource still serialises, compares and logs
 * exactly as three.js left it.
 */
const OWNER = Symbol('shader-studio.gl-owner');

interface Owned {
  [OWNER]?: string;
}

/** The id of the context that created this resource, if any. */
export function ownerOf(resource: object): string | undefined {
  return (resource as Owned)[OWNER];
}

let colourManagementInitialised = false;

/**
 * three's `ColorManagement` is module-global, not per-renderer: this is the one
 * piece of state every context genuinely shares. Shader colour uniforms are
 * authored as display-space sRGB, so it stays off — set once, not once per
 * context, to make the sharing visible rather than accidental.
 */
function initColourManagement(three: ThreeModule): void {
  if (colourManagementInitialised) return;
  three.ColorManagement.enabled = false;
  colourManagementInitialised = true;
}

async function defaultBackend(): Promise<GlBackend> {
  const three = await import('three');
  return {
    three,
    createRenderer: (canvas, options) => new three.WebGLRenderer({ canvas, ...options }),
  };
}

let nextId = 0;

export class GlContext {
  private currentStatus: GlContextStatus = 'live';

  private readonly lostListeners = new Set<() => void>();
  private readonly restoredListeners = new Set<() => void>();
  private readonly disposeListeners = new Set<() => void>();

  /**
   * Live status of *this* context alone. A sibling losing its context is invisible here.
   * A plain read, not a signal: changes are announced through `onLost`, `onRestored`
   * and `onDispose`, so the runtime carries no framework dependency.
   */
  status(): GlContextStatus {
    return this.currentStatus;
  }

  private constructor(
    readonly id: string,
    readonly canvas: HTMLCanvasElement,
    readonly three: ThreeModule,
    readonly renderer: THREE.WebGLRenderer,
  ) {
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
  }

  static async create(
    canvas: HTMLCanvasElement,
    options: GlContextOptions = {},
  ): Promise<GlContext> {
    const backend = options.backend ?? (await defaultBackend());
    initColourManagement(backend.three);

    const renderer = backend.createRenderer(canvas, {
      antialias: options.antialias ?? true,
      preserveDrawingBuffer: options.preserveDrawingBuffer ?? true,
    });
    renderer.debug.checkShaderErrors = true;

    return new GlContext(options.id ?? `gl-${++nextId}`, canvas, backend.three, renderer);
  }

  // ---------------------------------------------------------------------------
  // Ownership
  // ---------------------------------------------------------------------------

  /**
   * Claims a freshly created GPU resource for this context. Returns it, so it
   * can wrap the constructor call it belongs to.
   */
  own<T extends object>(resource: T): T {
    const owner = ownerOf(resource);
    if (owner === this.id) return resource;
    if (owner !== undefined) throw new WrongContextError('resource', owner, this.id);

    Object.defineProperty(resource, OWNER, {
      value: this.id,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    return resource;
  }

  /** Throws `WrongContextError` unless this context created the resource. */
  assertOwns(resource: object, label: string): void {
    const owner = ownerOf(resource);
    if (owner !== this.id) throw new WrongContextError(label, owner, this.id);
  }

  owns(resource: object): boolean {
    return ownerOf(resource) === this.id;
  }

  // ---------------------------------------------------------------------------
  // Loss, restoration, teardown
  // ---------------------------------------------------------------------------

  /**
   * `preventDefault()` is what makes the loss recoverable: without it the
   * browser never fires `webglcontextrestored` and the canvas stays dead.
   */
  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    if (this.currentStatus !== 'live') return;
    this.currentStatus = 'lost';
    for (const listener of this.lostListeners) listener();
  };

  private readonly onContextRestored = (): void => {
    if (this.currentStatus !== 'lost') return;
    this.currentStatus = 'live';
    for (const listener of this.restoredListeners) listener();
  };

  onLost(listener: () => void): () => void {
    this.lostListeners.add(listener);
    return () => this.lostListeners.delete(listener);
  }

  onRestored(listener: () => void): () => void {
    this.restoredListeners.add(listener);
    return () => this.restoredListeners.delete(listener);
  }

  /** Runs before the renderer goes away: whoever holds GPU resources frees them here. */
  onDispose(listener: () => void): () => void {
    this.disposeListeners.add(listener);
    return () => this.disposeListeners.delete(listener);
  }

  dispose(): void {
    if (this.currentStatus === 'disposed') return;
    this.currentStatus = 'disposed';

    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);

    for (const listener of this.disposeListeners) listener();
    this.disposeListeners.clear();
    this.lostListeners.clear();
    this.restoredListeners.clear();

    this.renderer.dispose();
  }
}
