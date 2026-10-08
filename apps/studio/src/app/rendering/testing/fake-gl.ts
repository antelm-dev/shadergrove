import { vi } from 'vitest';

import type { GlBackend, ThreeModule } from '../gl-context';

/**
 * A three.js that never touches a GPU.
 *
 * jsdom has no WebGL, and a real driver would make the answers
 * non-deterministic anyway — but almost nothing worth testing about the
 * renderer is *pixels*. Ownership, isolation, context loss, whether the clock is
 * the wall's or the caller's, what size the drawing buffer was set to: all of it
 * is bookkeeping, and bookkeeping is exactly what a fake can record.
 *
 * So three comes in through the `GlBackend` seam as this, and the fakes remember
 * what was asked of them.
 */

export class FakeVector {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
    public w = 0,
  ) {}
  set(x: number, y: number, z = 0, w = 0): this {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
    return this;
  }
  copy(other: FakeVector): this {
    return this.set(other.x, other.y, other.z, other.w);
  }
  clone(): FakeVector {
    return new FakeVector(this.x, this.y, this.z, this.w);
  }
  lerp(): this {
    return this;
  }
  subVectors(): this {
    return this;
  }
  divideScalar(): this {
    return this;
  }
  multiplyScalar(): this {
    return this;
  }
}

export class FakeDisposable {
  disposed = false;
  dispose(): void {
    this.disposed = true;
  }
}

export class FakeTexture extends FakeDisposable {
  needsUpdate = false;
  wrapS = 0;
  wrapT = 0;
  magFilter = 0;
  minFilter = 0;
  generateMipmaps = true;
  flipY = true;
  /** What an RGBA8 decoded image looks like to `render-inspection`. */
  format = 1023;
  type = 1009;
  colorSpace = '';
  mipmaps: unknown[] = [];
  image: { width: number; height: number } | undefined = { width: 2, height: 2 };
  constructor(readonly url = '') {
    super();
  }
}

export class FakeMaterial extends FakeDisposable {
  vertexShader: string;
  fragmentShader: string;
  uniforms: Record<string, { value: unknown }>;
  constructor(options: {
    vertexShader: string;
    fragmentShader: string;
    uniforms: Record<string, { value: unknown }>;
  }) {
    super();
    this.vertexShader = options.vertexShader;
    this.fragmentShader = options.fragmentShader;
    this.uniforms = options.uniforms;
  }
}

/**
 * A render target, and the texture behind it.
 *
 * The texture object's *identity* is what the multi-pass tests turn on: a
 * feedback buffer is correct exactly when the texture it samples is the one the
 * other target wrote last frame, and wrong — invisibly, on a real GPU — when it
 * is the one it is currently drawing into. An object you can compare with
 * `toBe` is the whole point.
 */
export class FakeRenderTarget extends FakeDisposable {
  /**
   * Every target ever handed out, newest last. A test cannot ask the engine
   * which targets it allocated — that is exactly the private bookkeeping under
   * test — so the fake records it instead. Call `reset()` between tests.
   */
  static readonly created: FakeRenderTarget[] = [];

  static reset(): void {
    FakeRenderTarget.created.length = 0;
  }

  readonly texture = new FakeTexture();
  readonly viewport = new FakeVector();

  /** How many times this target has been reallocated. A resize is never free. */
  resizes = 0;

  constructor(
    public width = 1,
    public height = 1,
    readonly options: Record<string, unknown> = {},
  ) {
    super();
    FakeRenderTarget.created.push(this);
  }

  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.resizes++;
  }
}

/** One `render()` call: what was drawn, and where it landed. */
export interface FakeDraw {
  scene: unknown;
  target: unknown;
}

export class FakeRenderer {
  readonly debug = { checkShaderErrors: false, onShaderError: null as unknown };
  disposed = false;
  draws = 0;

  /** Every draw, in order, with the target it was aimed at. */
  readonly drawLog: FakeDraw[] = [];

  /** The last drawing-buffer size asked for, and every one before it. */
  pixelRatio = 1;
  width = 0;
  height = 0;
  readonly sizes: { width: number; height: number; pixelRatio: number }[] = [];

  private target: unknown = null;

  readonly capabilities = { maxTextureSize: 4096 };

  /** Flip to false to see how a capture refuses a GPU that cannot read floats back. */
  floatReadback = true;

  /** Every `readRenderTargetPixels` call: the lifecycle of a capture, not its pixels. */
  readonly reads: { width: number; height: number }[] = [];

  private readonly gl = {
    NO_ERROR: 0,
    FRAMEBUFFER: 1,
    FRAMEBUFFER_COMPLETE: 2,
    RGBA: 3,
    UNSIGNED_BYTE: 4,
    isContextLost: () => false,
    getError: () => 0,
    checkFramebufferStatus: () => 2,
    getExtension: (name: string) =>
      name === 'EXT_color_buffer_float' && this.floatReadback ? {} : null,
    getContextAttributes: () => ({ alpha: true }),
    readPixels: () => undefined,
    drawingBufferWidth: 0,
    drawingBufferHeight: 0,
  };

  getContext(): unknown {
    this.gl.drawingBufferWidth = Math.floor(this.width * this.pixelRatio);
    this.gl.drawingBufferHeight = Math.floor(this.height * this.pixelRatio);
    return this.gl;
  }
  /** Lets a test say what a read returns; without one the array is left as the caller made it. */
  readHook: ((read: { width: number; height: number; out: Float32Array }) => void) | null = null;

  readRenderTargetPixels(
    _target: unknown,
    _x: number,
    _y: number,
    width: number,
    height: number,
    out?: Float32Array,
  ): void {
    this.reads.push({ width, height });
    if (out) this.readHook?.({ width, height, out });
  }

  setPixelRatio(ratio: number): void {
    this.pixelRatio = ratio;
  }
  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.sizes.push({ width, height, pixelRatio: this.pixelRatio });
  }
  getRenderTarget(): unknown {
    return this.target;
  }
  setRenderTarget(target: unknown): void {
    this.target = target;
  }
  render(scene?: unknown): void {
    this.draws++;
    this.drawLog.push({ scene, target: this.target });
  }
  dispose(): void {
    this.disposed = true;
  }
}

export class FakeScene {
  readonly children: unknown[] = [];
  add(child: unknown): void {
    this.children.push(child);
  }
}

const identity = () => ({
  elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
});

/** A geometry that can be cloned (a capture freezes its own copy) and owns no vertex data. */
export class FakeGeometry extends FakeDisposable {
  readonly attributes: Record<string, never> = {};
  readonly index = null;
  clone(): FakeGeometry {
    return new FakeGeometry();
  }
}

export class FakeMesh {
  readonly matrixWorld = identity();
  constructor(
    public geometry: unknown,
    public material: unknown,
  ) {}
}

/** The matrices a capture reads off the camera, and a `clone` that owns its own. */
export class FakeCamera {
  readonly isOrthographicCamera = true;
  readonly projectionMatrix = identity();
  readonly matrixWorldInverse = identity();
  readonly matrixWorld = identity();
  clone(): FakeCamera {
    return new FakeCamera();
  }
}

export const fakeThree = {
  Scene: FakeScene,
  OrthographicCamera: FakeCamera,
  Mesh: FakeMesh,
  PlaneGeometry: FakeGeometry,
  ShaderMaterial: FakeMaterial,
  WebGLRenderTarget: FakeRenderTarget,
  DataTexture: class extends FakeTexture {},
  TextureLoader: class {
    load(url: string, onLoad?: (texture: FakeTexture) => void): FakeTexture {
      const texture = new FakeTexture(url);
      onLoad?.(texture);
      return texture;
    }
  },
  Vector2: FakeVector,
  Vector3: FakeVector,
  Vector4: FakeVector,
  Color: class {
    set(): void {}
  },
  ColorManagement: { enabled: true },
  RGBAFormat: 1023,
  UnsignedByteType: 1009,
  FloatType: 1015,
  NoColorSpace: '',
  HalfFloatType: 1016,
  RepeatWrapping: 1000,
  MirroredRepeatWrapping: 1002,
  ClampToEdgeWrapping: 1001,
  NearestFilter: 1003,
  LinearFilter: 1006,
};

/** A backend, plus every renderer it handed out, in creation order. */
export function fakeBackend(): { backend: GlBackend; renderers: FakeRenderer[] } {
  const renderers: FakeRenderer[] = [];
  const backend: GlBackend = {
    three: fakeThree as unknown as ThreeModule,
    createRenderer: () => {
      const renderer = new FakeRenderer();
      renderers.push(renderer);
      return renderer as unknown as ReturnType<GlBackend['createRenderer']>;
    },
  };
  return { backend, renderers };
}

// -----------------------------------------------------------------------------
// A controllable animation frame
// -----------------------------------------------------------------------------

/**
 * `requestAnimationFrame` under the test's control.
 *
 * The engine's whole liveness — and, for a capture, its whole *deadness* — is
 * expressed in whether it has a frame scheduled. Owning the queue is what lets a
 * test say "run one round" and then ask who drew.
 */
export class FakeFrames {
  private frames = new Map<number, FrameRequestCallback>();
  private nextFrame = 0;

  install(): void {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = ++this.nextFrame;
      this.frames.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      this.frames.delete(id);
    });
  }

  /** Whether anything is still asking to be drawn. */
  get pending(): number {
    return this.frames.size;
  }

  /** Runs exactly one round of whatever the engines have scheduled. */
  run(): void {
    const pending = [...this.frames.values()];
    this.frames.clear();
    for (const callback of pending) callback(performance.now());
  }
}
