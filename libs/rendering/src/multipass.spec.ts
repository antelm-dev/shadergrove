import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_RENDER,
  addBuffer,
  bufferPasses,
  commonPass,
  composePass,
  imagePass,
  migrateLegacyProject,
  removePass,
  resetIdCounter,
  resolvePassOrder,
  setChannelBinding,
  setPassResolution,
  setPassSource,
  type ChannelIndex,
  type RenderPass,
  type ShaderProject,
} from '@shadergrove/shared';

import { GlContext, type GlBackend } from './gl-context';
import { ShaderEngine, type EnginePass, type MultiPassSpec } from './shader-engine';
import { FakeFrames, FakeRenderTarget, fakeBackend, type FakeRenderer } from './testing/fake-gl';

/**
 * The multi-pass pipeline, end to end, on a three.js that never touches a GPU.
 *
 * What is under test is not pixels — a fake renderer has none — but the things
 * that decide whether the pixels would be right: what was drawn, in what order,
 * into which target, and above all *which texture each pass was sampling at the
 * moment it was drawn*. That last one is the whole of feedback, and on a real GPU
 * it is invisible until the effect looks subtly wrong and there is nothing to
 * point at. Here the textures are objects, and objects can be compared.
 */

const VERTEX = 'void main() { gl_Position = vec4(position, 1.0); }';

/** The canvas the engine is told it has. Every target size below follows from it. */
const CANVAS = { width: 800, height: 600 };

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

/**
 * Take a project through the same path the app does — resolve the order, compose
 * each pass — and hand the engine the result. Composing here rather than hand-
 * writing a spec is the point: it is the real pipeline being exercised.
 */
function toSpec(project: ShaderProject): MultiPassSpec {
  const { order, errors } = resolvePassOrder(project);
  expect(errors).toEqual([]);

  const passes: EnginePass[] = order.map((pass: RenderPass) => {
    const { source, spans } = composePass(project, pass);
    return {
      id: pass.id,
      kind: pass.kind === 'image' ? 'image' : 'buffer',
      fragment: source,
      spans,
      channels: pass.channels,
      resolution: pass.resolution,
      filter: pass.filter,
      wrap: pass.wrap,
    };
  });

  return {
    vertex: project.vertex,
    controls: [],
    params: {},
    render: DEFAULT_RENDER,
    passes,
    textures: [null, null, null, null],
  };
}

function bind(
  project: ShaderProject,
  pass: RenderPass,
  channel: ChannelIndex,
  target: RenderPass,
  feedback = false,
): ShaderProject {
  return setChannelBinding(project, pass.id, channel, {
    kind: 'buffer',
    passId: target.id,
    feedback,
  });
}

/** The buffer targets, ignoring the engine's 1×1 compile probe. */
function bufferTargets(): FakeRenderTarget[] {
  return FakeRenderTarget.created.filter((target) => target.width !== 1 || target.height !== 1);
}

describe('multi-pass rendering', () => {
  let backend: GlBackend;
  let renderers: FakeRenderer[];
  let renderer: FakeRenderer;
  let context: GlContext;
  let engine: ShaderEngine;
  let frames: FakeFrames;
  let canvas: HTMLCanvasElement;

  beforeEach(async () => {
    resetIdCounter();
    FakeRenderTarget.reset();

    frames = new FakeFrames();
    frames.install();

    ({ backend, renderers } = fakeBackend());

    canvas = document.createElement('canvas');
    // jsdom reports a zero client size for everything, and the engine falls back
    // to 1×1 — which would make every size assertion below vacuously true.
    vi.spyOn(canvas, 'clientWidth', 'get').mockReturnValue(CANVAS.width);
    vi.spyOn(canvas, 'clientHeight', 'get').mockReturnValue(CANVAS.height);

    context = await GlContext.create(canvas, { id: 'gl', backend });
    engine = await ShaderEngine.create(context);
    renderer = renderers[0];
  });

  afterEach(() => {
    engine.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** Draw one frame and hand back the targets each draw landed in, in order. */
  function frame(): unknown[] {
    renderer.drawLog.length = 0;
    frames.run();
    return renderer.drawLog.map((draw) => draw.target);
  }

  // ---------------------------------------------------------------------------
  // A two-buffer pipeline
  // ---------------------------------------------------------------------------

  describe('a two-buffer pipeline', () => {
    /** Buffer A → Buffer B → Image. */
    function pipeline(): { project: ShaderProject; a: RenderPass; b: RenderPass } {
      let project = addBuffer(addBuffer(migrateLegacyProject('IMAGE', VERTEX)));
      const [a0, b0] = bufferPasses(project);

      project = setPassSource(project, a0.id, 'BUFFER_A');
      project = setPassSource(project, b0.id, 'BUFFER_B');

      project = bind(project, b0, 0, a0);
      project = bind(project, imagePass(project), 0, b0);

      const [a, b] = bufferPasses(project);
      return { project, a, b };
    }

    it('compiles every pass', () => {
      const { project } = pipeline();

      expect(engine.setPasses(toSpec(project))).toEqual([]);
      expect(engine.activePasses.map((pass) => pass.kind)).toEqual(['buffer', 'buffer', 'image']);
    });

    it('renders A before B, because B samples A — and Image last', () => {
      const { project, a, b } = pipeline();
      engine.setPasses(toSpec(project));

      expect(engine.activePasses.map((pass) => pass.id)).toEqual([
        a.id,
        b.id,
        imagePass(project).id,
      ]);
    });

    it('reverses the order when the dependency is reversed', () => {
      // The same two buffers, but now A samples B, so B has to go first. Nothing
      // about the project *array* changed — only the graph.
      let { project, a, b } = pipeline();
      project = setChannelBinding(project, b.id, 0, { kind: 'none' });
      project = bind(project, a, 0, b);

      engine.setPasses(toSpec(project));

      expect(engine.activePasses.map((pass) => pass.id)).toEqual([
        b.id,
        a.id,
        imagePass(project).id,
      ]);
    });

    it('gives each buffer two targets, and the Image pass none', () => {
      const { project } = pipeline();
      engine.setPasses(toSpec(project));

      // Two buffers, ping-ponging. The Image pass renders to the canvas.
      expect(bufferTargets()).toHaveLength(4);
    });

    it('draws the buffers into targets, then the Image pass onto the canvas', () => {
      const { project } = pipeline();
      engine.setPasses(toSpec(project));

      const targets = frame();

      expect(targets).toHaveLength(3);
      expect(targets[0]).not.toBeNull();
      expect(targets[1]).not.toBeNull();
      expect(targets[0]).not.toBe(targets[1]);
      // `null` is the canvas.
      expect(targets[2]).toBeNull();
    });

    it('feeds a buffer through to the pass that samples it', () => {
      const { project, a, b } = pipeline();
      engine.setPasses(toSpec(project));
      frame();

      // B's iChannel0 is A's current frame; Image's iChannel0 is B's.
      expect(engine.passChannelTexture(b.id, 0)).toBe(engine.bufferTexture(a.id));
      expect(engine.channelTexture(0)).toBe(engine.bufferTexture(b.id));
    });

    it('can be consumed through any of the four channels', () => {
      for (const channel of [0, 1, 2, 3] as ChannelIndex[]) {
        let project = addBuffer(migrateLegacyProject('IMAGE', VERTEX));
        const a = bufferPasses(project)[0];
        project = bind(project, imagePass(project), channel, a);

        engine.setPasses(toSpec(project));
        frame();

        expect(engine.channelTexture(channel)).toBe(engine.bufferTexture(a.id));
      }
    });

    it('sizes a scaled buffer to a fraction of the viewport', () => {
      let { project, a } = pipeline();
      project = setPassResolution(project, a.id, { mode: 'scaled', scale: 0.5 });

      engine.setPasses(toSpec(project));

      // A buffer that thought it was full-size would sample and step at the wrong
      // scale — the sort of thing that looks like a shader bug for an hour.
      const half = bufferTargets().filter((target) => target.width === 400);
      expect(half).toHaveLength(2);
      expect(half.every((target) => target.height === 300)).toBe(true);
    });

    it('sizes a fixed buffer to exactly what it asked for', () => {
      let { project, a } = pipeline();
      project = setPassResolution(project, a.id, { mode: 'fixed', width: 256, height: 128 });

      engine.setPasses(toSpec(project));

      const fixed = bufferTargets().filter((target) => target.width === 256);
      expect(fixed).toHaveLength(2);
      expect(fixed.every((target) => target.height === 128)).toBe(true);
    });

    it('recompiles only the pass that changed', () => {
      const { project, a, b } = pipeline();
      engine.setPasses(toSpec(project));

      const before = {
        a: engine.passMaterial(a.id),
        b: engine.passMaterial(b.id),
        image: engine.passMaterial(imagePass(project).id),
      };

      engine.setPasses(toSpec(setPassSource(project, a.id, 'BUFFER_A edited')));

      // B and Image compose to byte-for-byte the same source as before, so their
      // programs are reused. Only A is rebuilt.
      expect(engine.passMaterial(a.id)).not.toBe(before.a);
      expect(engine.passMaterial(b.id)).toBe(before.b);
      expect(engine.passMaterial(imagePass(project).id)).toBe(before.image);
    });

    it('recompiles every pass when Common changes', () => {
      const { project } = pipeline();
      engine.setPasses(toSpec(project));

      const before = engine.activePasses.map((pass) => engine.passMaterial(pass.id));

      const common = commonPass(project)!;
      engine.setPasses(toSpec(setPassSource(project, common.id, '#define TAU 6.28318')));

      // Every pass's composed source now differs, so every program is new — and
      // nothing had to tell the engine which passes Common reached.
      const after = engine.activePasses.map((pass) => engine.passMaterial(pass.id));
      after.forEach((material, index) => expect(material).not.toBe(before[index]));
    });

    it('shares Common with every pass', () => {
      let { project } = pipeline();
      const common = commonPass(project)!;
      project = setPassSource(project, common.id, 'float shared() { return 1.0; }');

      const spec = toSpec(project);

      for (const pass of spec.passes) {
        expect(pass.fragment).toContain('float shared() { return 1.0; }');
      }
    });

    it('frees both targets of a buffer that is deleted', () => {
      const { project, a, b } = pipeline();
      engine.setPasses(toSpec(project));

      expect(bufferTargets().every((target) => !target.disposed)).toBe(true);

      let edited = setChannelBinding(project, b.id, 0, { kind: 'none' });
      edited = removePass(edited, a.id);

      engine.setPasses(toSpec(edited));

      const disposed = bufferTargets().filter((target) => target.disposed);
      expect(disposed).toHaveLength(2);
      // B's pair is untouched.
      expect(bufferTargets().filter((target) => !target.disposed)).toHaveLength(2);
    });

    it('stops rendering a buffer that is disabled, and frees its targets', () => {
      let { project, a, b } = pipeline();
      engine.setPasses(toSpec(project));

      let edited = setChannelBinding(project, b.id, 0, { kind: 'none' });
      edited = {
        ...edited,
        passes: edited.passes.map((pass) =>
          pass.id === a.id ? { ...pass, enabled: false } : pass,
        ),
      };

      engine.setPasses(toSpec(edited));

      expect(engine.activePasses.map((pass) => pass.id)).toEqual([b.id, imagePass(project).id]);
      expect(bufferTargets().filter((target) => target.disposed)).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Feedback
  // ---------------------------------------------------------------------------

  describe('feedback', () => {
    /** Buffer A samples its own previous frame; Image shows its current one. */
    function trail(): { project: ShaderProject; a: RenderPass } {
      let project = addBuffer(migrateLegacyProject('IMAGE', VERTEX));
      const a0 = bufferPasses(project)[0];

      project = setPassSource(project, a0.id, 'TRAIL');
      project = bind(project, a0, 0, a0, true);
      project = bind(project, imagePass(project), 0, a0);

      return { project, a: bufferPasses(project)[0] };
    }

    it('renders a self-sampling buffer without calling it a cycle', () => {
      const { project } = trail();

      expect(engine.setPasses(toSpec(project))).toEqual([]);
      expect(engine.activePasses).toHaveLength(2);
    });

    it('never samples the target it is drawing into', () => {
      // The single most important property here. A GPU cannot sample a texture it
      // is rendering into; on a real driver the result is undefined — usually a
      // black frame, sometimes garbage, never an error.
      const { project, a } = trail();
      engine.setPasses(toSpec(project));

      for (let n = 0; n < 4; n++) {
        const [drawnInto] = frame() as FakeRenderTarget[];
        expect(engine.passChannelTexture(a.id, 0)).not.toBe(drawnInto.texture);
      }
    });

    it('samples exactly the frame it drew last tick', () => {
      const { project, a } = trail();
      engine.setPasses(toSpec(project));

      const [first] = frame() as FakeRenderTarget[];
      const [second] = frame() as FakeRenderTarget[];

      // On the second frame, the channel holds what the first frame wrote …
      expect(engine.passChannelTexture(a.id, 0)).toBe(first.texture);
      // … and the drawing has moved to the other target of the pair.
      expect(second).not.toBe(first);
    });

    it('ping-pongs: the two targets alternate, frame after frame', () => {
      const { project } = trail();
      engine.setPasses(toSpec(project));

      const drawn = [frame()[0], frame()[0], frame()[0], frame()[0]];

      expect(drawn[0]).toBe(drawn[2]);
      expect(drawn[1]).toBe(drawn[3]);
      expect(drawn[0]).not.toBe(drawn[1]);
    });

    it('shows the Image pass this frame’s buffer, not last frame’s', () => {
      const { project } = trail();
      engine.setPasses(toSpec(project));

      const [drawnInto] = frame() as FakeRenderTarget[];

      // The Image pass's binding has no feedback, so it must see what Buffer A
      // produced *this* frame — the very target it was just drawn into.
      expect(engine.channelTexture(0)).toBe(drawnInto.texture);
    });

    it('a plain and a feedback binding on the same buffer are one frame apart', () => {
      // Image samples Buffer A twice: iChannel0 as it is now, iChannel1 as it was.
      let { project, a } = trail();
      project = bind(project, imagePass(project), 1, a, true);

      engine.setPasses(toSpec(project));
      frame();
      frame();

      const now = engine.channelTexture(0);
      const before = engine.channelTexture(1);

      expect(now).toBe(engine.bufferTexture(a.id));
      expect(before).not.toBe(now);
    });

    it('breaks a two-buffer cycle when one edge is feedback', () => {
      let project = addBuffer(addBuffer(migrateLegacyProject('IMAGE', VERTEX)));
      const [a, b] = bufferPasses(project);

      project = bind(project, a, 0, b, true); // reads B's last frame
      project = bind(project, b, 0, a, false); // needs A's current frame

      // `toSpec` asserts the order resolved without errors, so this passing at
      // all is the claim: a feedback edge is not a dependency.
      engine.setPasses(toSpec(project));

      expect(engine.activePasses.map((pass) => pass.id)).toEqual([
        a.id,
        b.id,
        imagePass(project).id,
      ]);
    });

    it('does not reallocate targets when the canvas is "resized" to the same size', () => {
      // A reallocation clears the texture, and for a feedback buffer that is the
      // loss of its entire history. A ResizeObserver fires far more often than the
      // size actually changes.
      const { project } = trail();
      engine.setPasses(toSpec(project));

      engine.resize();
      engine.resize();
      engine.resize();

      expect(bufferTargets().every((target) => target.resizes === 0)).toBe(true);
    });

    it('resizes a viewport-sized buffer when the canvas really does change', () => {
      const { project } = trail();
      engine.setPasses(toSpec(project));

      vi.spyOn(canvas, 'clientWidth', 'get').mockReturnValue(1024);
      engine.resize();

      expect(bufferTargets().every((target) => target.width === 1024)).toBe(true);
      expect(bufferTargets().every((target) => target.resizes === 1)).toBe(true);
    });

    it('leaves a fixed-size buffer alone when the canvas changes', () => {
      let { project, a } = trail();
      project = setPassResolution(project, a.id, { mode: 'fixed', width: 256, height: 256 });
      engine.setPasses(toSpec(project));

      vi.spyOn(canvas, 'clientWidth', 'get').mockReturnValue(1024);
      engine.resize();

      // A simulation buffer pinned to 256×256 must not be wiped because the
      // window was dragged.
      expect(bufferTargets().every((target) => target.resizes === 0)).toBe(true);
      expect(bufferTargets().every((target) => target.width === 256)).toBe(true);
    });

    it('reports the drawing buffer once per size, starting with the one set before anyone listened', () => {
      // The first sizing happens inside `create`, so a listener attached after
      // it must still hear about the size the engine already has.
      const sizes: string[] = [];
      engine.onResize = (width, height) => sizes.push(`${width}x${height}`);

      engine.resize();
      engine.resize();
      vi.spyOn(canvas, 'clientWidth', 'get').mockReturnValue(1024);
      engine.resize();

      expect(sizes).toEqual([`${CANVAS.width}x${CANVAS.height}`, `1024x${CANVAS.height}`]);
    });
  });

  // ---------------------------------------------------------------------------
  // Profiler workload generations
  // ---------------------------------------------------------------------------

  describe('profiler workload generations', () => {
    it('retains samples for an unchanged compile and resets after an accepted source change', () => {
      const project = migrateLegacyProject('IMAGE', VERTEX);
      engine.setPasses(toSpec(project));
      const stable = engine.profilerGeneration();

      engine.setPasses(toSpec(project));
      expect(engine.profilerGeneration()).toBe(stable);

      engine.setPasses(toSpec(setPassSource(project, imagePass(project).id, 'IMAGE_EDITED')));
      expect(engine.profilerGeneration()).toBeGreaterThan(stable);
    });

    it('resets after accepted pass topology and buffer-resolution changes', () => {
      let project = migrateLegacyProject('IMAGE', VERTEX);
      engine.setPasses(toSpec(project));

      const beforeAdd = engine.profilerGeneration();
      project = addBuffer(project);
      engine.setPasses(toSpec(project));
      expect(engine.profilerGeneration()).toBeGreaterThan(beforeAdd);

      const buffer = bufferPasses(project)[0];
      const beforeResolution = engine.profilerGeneration();
      project = setPassResolution(project, buffer.id, {
        mode: 'fixed',
        width: 256,
        height: 128,
      });
      engine.setPasses(toSpec(project));
      expect(engine.profilerGeneration()).toBeGreaterThan(beforeResolution);

      const beforeRemove = engine.profilerGeneration();
      project = removePass(project, buffer.id);
      engine.setPasses(toSpec(project));
      expect(engine.profilerGeneration()).toBeGreaterThan(beforeRemove);
    });

    it('resets only when drawing-buffer dimensions really change', () => {
      const project = migrateLegacyProject('IMAGE', VERTEX);
      engine.setPasses(toSpec(project));
      const stable = engine.profilerGeneration();

      engine.resize();
      engine.resize();
      expect(engine.profilerGeneration()).toBe(stable);

      vi.spyOn(canvas, 'clientWidth', 'get').mockReturnValue(1024);
      engine.resize();
      expect(engine.profilerGeneration()).toBeGreaterThan(stable);
    });
  });

  // ---------------------------------------------------------------------------
  // A failed compile must not take the picture down
  // ---------------------------------------------------------------------------

  describe('a failed compile', () => {
    /**
     * Make the next compile fail the way a driver does: three.js reports it
     * through `debug.onShaderError` — which the engine sets only while probing —
     * rather than by throwing.
     */
    function failNextCompile(line = 1): void {
      let fired = false;
      const original = renderer.render.bind(renderer);

      renderer.render = ((scene?: unknown) => {
        const handler = renderer.debug.onShaderError as
          | ((gl: unknown, program: unknown, vertex: unknown, fragment: unknown) => void)
          | null;

        if (handler && !fired) {
          fired = true;
          handler(
            {
              getShaderSource: () => '',
              getShaderInfoLog: (shader: unknown) =>
                shader === 'fragment' ? `ERROR: 0:${line}: 'x' : undeclared identifier` : '',
              getProgramInfoLog: () => '',
            },
            {},
            'vertex',
            'fragment',
          );
        }

        original(scene);
      }) as typeof renderer.render;
    }

    it('keeps the last good program for the pass that failed', () => {
      let project = addBuffer(migrateLegacyProject('IMAGE', VERTEX));
      const a = bufferPasses(project)[0];
      project = setPassSource(project, a.id, 'GOOD');

      engine.setPasses(toSpec(project));
      const good = engine.passMaterial(a.id);

      failNextCompile();
      const diagnostics = engine.setPasses(toSpec(setPassSource(project, a.id, 'BROKEN')));

      expect(diagnostics.length).toBeGreaterThan(0);
      // The shader that worked is still the one on the GPU: a typo in a buffer
      // must not black out the preview.
      expect(engine.passMaterial(a.id)).toBe(good);
      expect(good?.fragmentShader).toContain('GOOD');
    });

    it('retains profiler samples when a rejected compile leaves the live workload unchanged', () => {
      let project = addBuffer(migrateLegacyProject('IMAGE', VERTEX));
      const a = bufferPasses(project)[0];
      project = setPassSource(project, a.id, 'GOOD');
      engine.setPasses(toSpec(project));
      const stable = engine.profilerGeneration();

      failNextCompile();
      engine.setPasses(toSpec(setPassSource(project, a.id, 'BROKEN')));

      expect(engine.profilerGeneration()).toBe(stable);
    });

    it('keeps rendering every pass, including the failed one', () => {
      let project = addBuffer(migrateLegacyProject('IMAGE', VERTEX));
      const a = bufferPasses(project)[0];
      project = setPassSource(project, a.id, 'GOOD');
      engine.setPasses(toSpec(project));

      failNextCompile();
      engine.setPasses(toSpec(setPassSource(project, a.id, 'BROKEN')));

      // Still a buffer and an Image pass, still drawn.
      expect(frame()).toHaveLength(2);
    });

    it('blames a buffer’s error on the buffer, at the right line', () => {
      let project = addBuffer(migrateLegacyProject('IMAGE', VERTEX));
      const a = bufferPasses(project)[0];
      project = setPassSource(project, a.id, 'one\ntwo\nthree');
      engine.setPasses(toSpec(project));

      failNextCompile(3);
      const diagnostics = engine.setPasses(
        toSpec(setPassSource(project, a.id, 'one\ntwo\nbroken')),
      );

      expect(diagnostics[0].docId).toBe(a.id);
      expect(diagnostics[0].line).toBe(3);
    });

    it('blames an error inside Common on Common, not on the pass that included it', () => {
      let project = addBuffer(migrateLegacyProject('IMAGE', VERTEX));
      const common = commonPass(project)!;
      const a = bufferPasses(project)[0];

      project = setPassSource(project, common.id, 'c1\nc2\nc3');
      project = setPassSource(project, a.id, 'a1\na2');
      engine.setPasses(toSpec(project));

      // Composed line 2 lies inside Common. Without the span map this would be
      // reported as line 2 of the buffer, which is a line the user never wrote.
      failNextCompile(2);
      const diagnostics = engine.setPasses(toSpec(setPassSource(project, a.id, 'a1\na2 edited')));

      expect(diagnostics[0].docId).toBe(common.id);
      expect(diagnostics[0].docName).toBe('Common');
      expect(diagnostics[0].line).toBe(2);
    });
  });
});
