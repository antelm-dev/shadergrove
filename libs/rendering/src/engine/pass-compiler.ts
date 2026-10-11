import type * as THREE from 'three';

import {
  legacyTextureBindings,
  locate,
  UNIFORM_PREFIX,
  type ChannelBindings,
  type PassResolution,
  type RenderSettings,
  type ShaderControl,
  type ShaderParams,
  type SourceSpan,
  type TextureFilterMode,
  type TextureWrapMode,
} from '@shadergrove/shared';
import { VERTEX_DOC, type CompileDiagnostic } from '@shadergrove/shared/diagnostic';
import { expandMacros } from '@shadergrove/shared/glsl-export';

import type { EngineOutputLevel, EngineOutputSource } from '../engine-output-sink';
import type { GlContext } from '../gl-context';
import { CHANNEL_UNIFORMS, type ChannelBinder } from './channel-binder';
import { CHANNEL_COUNT, type ChannelSource } from './texture-manager';
import { probeProgram } from './shader-probe';
import type { UniformMap, UniformRegistry } from './uniform-registry';

/**
 * Everything between "here is some GLSL" and "the driver has accepted it".
 *
 * The contract this type exists to keep is that **a failed compile never takes
 * down the picture.** three.js compiles lazily, on the first draw, so the only
 * way to find out whether a shader is valid is to draw with it — which is what
 * the 1×1 offscreen probe target is for. A candidate is built, drawn once into a
 * pixel nobody sees, and only promoted to an accepted pass if the driver said
 * nothing. If it did say something, the candidate is disposed on the spot and
 * the *previously* accepted program for that pass keeps rendering. So a project
 * whose Buffer B has a typo in it keeps showing the last Buffer B that worked
 * instead of collapsing to black while it is fixed.
 *
 * The second thing it owns is knowing what *not* to recompile. A pass whose
 * composed source and vertex are byte-for-byte what it already compiled is
 * skipped entirely — which is what makes an edit to Buffer C recompile Buffer C
 * and nothing else, and an edit to Common recompile every pass that uses it,
 * without anyone having to work out which passes Common reached. An unaffected
 * pass simply composes to the same string it did last time.
 *
 * Every accepted material belongs to this type and is disposed by it: on being
 * replaced by a better one, on its pass being deleted or disabled, on a
 * candidate being rejected, and on teardown. Nothing else disposes a pass
 * program.
 *
 * It does not import the engine, does not draw a frame, and does not own a
 * texture or a render target beyond its own probe.
 */

/**
 * One pass, as the compiler wants it: the source already composed (Common and
 * any `#include`s folded in), with the map back to the files it came from so a
 * driver error can be blamed on the right one.
 *
 * The channel bindings arrive *unresolved* — as the document model wrote them —
 * because resolving them has to be redone every frame anyway: a binding to a
 * buffer names a texture that ping-pongs, so there is no stable object a caller
 * could have handed us.
 */
export interface EnginePass {
  id: string;
  kind: 'image' | 'buffer';
  /** Composed fragment source. Compared against the last one to skip a recompile. */
  fragment: string;
  spans: readonly SourceSpan[];
  channels: ChannelBindings;
  resolution: PassResolution;
  filter: TextureFilterMode;
  wrap: TextureWrapMode;
}

/**
 * A whole project, ready to render. `passes` is already in dependency order —
 * the buffers that have to go first, then the Image pass last. The compiler does
 * not build the graph; it compiles the order the graph produced.
 */
export interface MultiPassSpec {
  vertex: string;
  controls: readonly ShaderControl[];
  params: ShaderParams;
  render: RenderSettings;
  /** Buffers in render order, Image last. */
  passes: readonly EnginePass[];
  /** The shader's four image slots, which a `texture` binding points into. */
  textures: readonly (ChannelSource | null)[];
  /** Which project this is. A different one ends any frame capture. */
  projectId?: string;
  /** The editor revision this spec was composed from; stamped on every pass it makes (or keeps) accepted. */
  revision?: number;
}

/**
 * What the driver accepted for a pass, kept beside the program so that an
 * inspection can state exactly which source produced the pixels — even when a
 * newer draft of the same pass has since been rejected. Only ever replaced by a
 * source the driver accepted, never rebuilt from the draft.
 */
export interface AcceptedSource {
  /** Non-cryptographic hash of the expanded vertex + fragment: the program's identity. */
  readonly fingerprint: string;
  /** The requested revision at which this exact program was last accepted. */
  readonly revision: number | null;
  /** Composed source before macro expansion, and the map back to the files it came from. */
  readonly composedFragment: string;
  readonly composedVertex: string;
  readonly spans: readonly Readonly<SourceSpan>[];
}

/** 53-bit cyrb53 hash. Identity for display, not security. */
export function sourceFingerprint(...parts: readonly string[]): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (const char of parts.join('\u0000')) {
    const code = char.codePointAt(0)!;
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

function accept(
  pass: EnginePass,
  fragment: string,
  vertex: string,
  spec: MultiPassSpec,
): AcceptedSource {
  return Object.freeze({
    fingerprint: sourceFingerprint(vertex, fragment),
    revision: spec.revision ?? null,
    composedFragment: pass.fragment,
    composedVertex: spec.vertex,
    spans: Object.freeze(pass.spans.map((span) => Object.freeze({ ...span }))),
  });
}

/**
 * A pass the driver has accepted: everything needed to draw it and to rebind its
 * channels, and nothing else.
 *
 * This is the compiler's output contract. `channels` is the one mutable field —
 * pointing a pass at a different buffer is a new uniform value, never a reason
 * to recompile — and it is the compiler that writes it. Everything else is fixed
 * for the lifetime of the program: a pass whose source changed is a *different*
 * `PassRuntime` with a different material, which is exactly what makes material
 * identity an observable answer to "did you recompile this?".
 *
 * The material is owned by the compiler. Holding one of these does not entitle
 * anyone to dispose it.
 */
export interface PassRuntime {
  readonly id: string;
  readonly kind: 'image' | 'buffer';
  readonly material: THREE.ShaderMaterial;
  readonly uniforms: UniformMap;
  /** What its four samplers point at. Rebound every frame; never recompiled for. */
  channels: ChannelBindings;
  /** What it was compiled from — an identical source next time is not recompiled. */
  readonly fragment: string;
  readonly vertex: string;
  /** The accepted source's identity and maps. Replaced only by an accepted source. */
  accepted: AcceptedSource;
}

export interface PassCompilerOptions {
  /**
   * The ripple ring every pass shares. One array, held by the engine: writing a
   * slot is already visible to every pass, because every `u_clickData` uniform
   * holds the same object.
   */
  clickData: readonly THREE.Vector3[];
  /** The clock value a freshly built pass starts its `iTime` at. */
  time: () => number;
  /** Where compile output goes. Absent means nothing is logged. */
  write?: (level: EngineOutputLevel, source: EngineOutputSource, message: string) => void;
  /** Fired after each forced 1×1 probe, including rejected compiles. */
  onProbe?: (passId: string, durationMs: number, success: boolean) => void;
}

const PLACEHOLDER_FRAGMENT = `precision mediump float;
void main() { gl_FragColor = vec4(0.02, 0.03, 0.05, 1.0); }`;

const PLACEHOLDER_VERTEX = `void main() { gl_Position = vec4(position, 1.0); }`;

/**
 * Blame a pass's compile errors on the file they actually came from.
 *
 * The driver reports a line in the source *it* was given, which is Common, plus
 * every `#include`, plus the pass — a file that exists nowhere and that the user
 * has never seen. `parseInfoLog` has already subtracted three.js's prelude; the
 * span map subtracts the rest, and what comes out is a file and a line the
 * editor can actually put a cursor on.
 *
 * A diagnostic with no line (a link failure, most often) has nothing to map, so
 * it is pinned to the pass itself — the one file that is certainly involved.
 */
function attribute(
  diagnostics: readonly CompileDiagnostic[],
  pass: EnginePass,
): CompileDiagnostic[] {
  return diagnostics.map((diagnostic) => {
    if (diagnostic.source === 'vertex') {
      return { ...diagnostic, docId: VERTEX_DOC, docName: 'Vertex' };
    }

    const at = diagnostic.line > 0 ? locate(pass.spans, diagnostic.line) : null;
    if (!at) return { ...diagnostic, docId: pass.id };

    return { ...diagnostic, line: at.line, docId: at.docId, docName: at.docName };
  });
}

export class PassCompiler {
  /** A separate one-pixel scene used to compile candidates without showing them. */
  private readonly probeScene: THREE.Scene;
  private readonly probeMesh: THREE.Mesh;
  private readonly probeTarget: THREE.WebGLRenderTarget;

  /** What an engine draws before it has ever been given a shader. */
  private readonly placeholder: THREE.ShaderMaterial;

  /** The buffer passes, in the order the dependency graph said they must run. */
  private buffers: PassRuntime[] = [];
  /** The Image pass, if one has been accepted. */
  private image: PassRuntime | null = null;

  /**
   * The Image program on screen. Distinct from `image` on purpose: a context
   * loss forgets the accepted passes, but what the engine's mesh is holding is
   * still this, and `activeShader` still has to answer with it.
   */
  private current: THREE.ShaderMaterial;

  /** The bindings the Image pass' channels were last accepted with. */
  private channels: ChannelBindings = legacyTextureBindings();

  /**
   * The last spec asked for — accepted, rejected, or never attempted because the
   * context was lost. Kept so a restored context can be replayed to exactly what
   * was requested of it; the shader is the only thing a lost context cannot
   * reconstruct on its own.
   */
  private requested: MultiPassSpec | null = null;

  /**
   * The last failure logged per pass, so a debounce that fires on unchanged,
   * still-broken source — or a forced recompile of every pass, changed or not —
   * does not repeat a driver log the user is already looking at.
   */
  private readonly lastFailureByPass = new Map<string, string>();

  private disposed = false;

  /**
   * `geometry` and `camera` are the engine's full-screen quad and its
   * orthographic camera, shared with the scenes that actually reach the canvas.
   * They are deliberately borrowed rather than owned — one of each per engine,
   * and neither is a GPU allocation this type should be freeing.
   */
  constructor(
    private readonly context: GlContext,
    geometry: THREE.BufferGeometry,
    private readonly camera: THREE.Camera,
    private readonly registry: UniformRegistry,
    private readonly binder: ChannelBinder,
    private readonly options: PassCompilerOptions,
  ) {
    const T = context.three;

    this.placeholder = context.own(
      new T.ShaderMaterial({
        vertexShader: PLACEHOLDER_VERTEX,
        fragmentShader: PLACEHOLDER_FRAGMENT,
        uniforms: {},
      }),
    );
    this.current = this.placeholder;

    this.probeScene = new T.Scene();
    this.probeMesh = new T.Mesh(geometry, this.placeholder);
    this.probeScene.add(this.probeMesh);
    // Depth/stencil unused for compile probes — keep the allocation at 1×1 RGBA.
    this.probeTarget = context.own(
      new T.WebGLRenderTarget(1, 1, { depthBuffer: false, stencilBuffer: false }),
    );
  }

  // ---------------------------------------------------------------------------
  // The accepted set
  // ---------------------------------------------------------------------------

  /** Every accepted pass, in render order: the buffers, then the Image pass. */
  get passes(): readonly PassRuntime[] {
    return this.image ? [...this.buffers, this.image] : [...this.buffers];
  }

  /** The accepted buffer passes alone, in the order they must be drawn. */
  get bufferPasses(): readonly PassRuntime[] {
    return this.buffers;
  }

  /** The accepted Image pass, or `null` if no image program has survived a compile. */
  get imagePass(): PassRuntime | null {
    return this.image;
  }

  /** The Image program on screen: the last one the driver accepted, or the placeholder. */
  get material(): THREE.ShaderMaterial {
    return this.current;
  }

  /** The shader currently on screen: the last one the driver accepted. */
  get activeShader(): { fragment: string; vertex: string } {
    return {
      fragment: this.current.fragmentShader,
      vertex: this.current.vertexShader,
    };
  }

  /** The bindings the accepted Image pass' four channels resolve through. */
  get imageChannels(): ChannelBindings {
    return this.channels;
  }

  /** The last spec asked for, whatever became of it. */
  get lastSpec(): MultiPassSpec | null {
    return this.requested;
  }

  find(passId: string): PassRuntime | null {
    for (const pass of this.passes) {
      if (pass.id === passId) return pass;
    }
    return null;
  }

  /**
   * The program a pass is currently running.
   *
   * Its *identity* is the observable fact worth having: an unchanged object
   * across two compiles is the compiler saying it did not rebuild that pass, and
   * a changed one that it did.
   */
  materialOf(passId: string): THREE.ShaderMaterial | null {
    return this.find(passId)?.material ?? null;
  }

  // ---------------------------------------------------------------------------
  // Compilation
  // ---------------------------------------------------------------------------

  /**
   * Record a spec without compiling it: what a lost context does with a request
   * it has no driver to answer. `lastSpec` replays it once the context is back.
   */
  remember(spec: MultiPassSpec): void {
    this.requested = spec;
  }

  /**
   * Probe every pass that needs it and promote the ones the driver accepted.
   *
   * `force` is what Ctrl+Enter means: probe every pass, even the ones whose
   * source has not moved. It is also the only thing that writes a summary to the
   * output log — every keystroke lands here through a debounce, and a line per
   * keystroke would drown out the one summary anyone wants.
   */
  compile(spec: MultiPassSpec, force = false): CompileDiagnostic[] {
    this.requested = spec;
    if (this.disposed) return [];

    const vertex = expandMacros(spec.vertex);
    const diagnostics: CompileDiagnostic[] = [];

    const previous = new Map(this.passes.map((pass) => [pass.id, pass]));
    const compiled: PassRuntime[] = [];

    for (const pass of spec.passes) {
      const fragment = expandMacros(pass.fragment);
      const existing = previous.get(pass.id);

      // Same source, same vertex: the program on the GPU is already the right
      // one. Rebind its channels and its params and move on.
      if (!force && existing && existing.fragment === fragment && existing.vertex === vertex) {
        existing.channels = pass.channels;
        existing.accepted = accept(pass, fragment, vertex, spec);
        this.registry.applyControls(existing.uniforms, spec.controls, spec.params);
        compiled.push(existing);
        previous.delete(pass.id);
        continue;
      }

      const candidate = this.build(pass, fragment, vertex, spec);

      if (candidate.diagnostics.length > 0) {
        // Rejected, and already disposed. Keep whatever was on the GPU for this
        // pass, so the picture survives the failure — that is the whole contract.
        diagnostics.push(...candidate.diagnostics);
        if (existing) {
          existing.channels = pass.channels;
          compiled.push(existing);
          previous.delete(pass.id);
        }
        continue;
      }

      if (existing) existing.material.dispose();
      previous.delete(pass.id);
      compiled.push(candidate.pass);
    }

    // Anything left in `previous` belongs to a pass that is no longer in the
    // project — a deleted or disabled buffer. Its program is now garbage.
    for (const orphan of previous.values()) orphan.material.dispose();

    this.registry.setControls(spec.controls);

    const image = compiled.find((pass) => pass.kind === 'image') ?? null;
    this.buffers = compiled.filter((pass) => pass.kind === 'buffer');

    if (image) {
      this.image = image;
      this.current = image.material;
      this.channels = image.channels;
      this.registry.setPrimary(image.uniforms);
    }

    this.registry.replace(this.passes);

    this.summarise(force, diagnostics.length);

    return diagnostics;
  }

  /**
   * Build one candidate and put it in front of the driver. A rejected candidate
   * is disposed here and comes back as diagnostics; nothing else ever sees its
   * material.
   *
   * On success the material is live but not yet installed: only `compile` knows
   * whether the rest of the project compiled too.
   */
  private build(
    pass: EnginePass,
    fragment: string,
    vertex: string,
    spec: MultiPassSpec,
  ): { pass: PassRuntime; diagnostics: CompileDiagnostic[] } {
    const T = this.context.three;

    const uniforms = this.buildUniforms(spec.controls, spec.params, pass.channels);
    const material = this.context.own(
      new T.ShaderMaterial({ vertexShader: vertex, fragmentShader: fragment, uniforms }),
    );

    const probeStarted = performance.now();
    const raw = this.probe(material, fragment, vertex);
    const probeDurationMs = performance.now() - probeStarted;
    this.options.onProbe?.(pass.id, probeDurationMs, raw.length === 0);

    if (raw.length > 0) {
      material.dispose();
      const diagnostics = attribute(raw, pass);
      this.logFailure(pass.id, diagnostics);
      return { pass: null as never, diagnostics };
    }

    // Whatever this pass failed with before, it is not failing with it now.
    this.lastFailureByPass.delete(pass.id);

    return {
      pass: {
        id: pass.id,
        kind: pass.kind,
        material,
        uniforms,
        channels: pass.channels,
        fragment,
        vertex,
        accepted: accept(pass, fragment, vertex, spec),
      },
      diagnostics: [],
    };
  }

  /**
   * Compile a candidate without letting it touch the screen.
   *
   * three.js compiles lazily on first draw, so the only way to know whether a
   * shader is valid is to draw with it — hence the 1×1 offscreen target. When
   * `onShaderError` is set, three hands us the driver's log instead of throwing.
   */
  private probe(
    material: THREE.ShaderMaterial,
    fragment: string,
    vertex: string,
  ): CompileDiagnostic[] {
    this.probeMesh.material = material;
    try {
      return probeProgram(
        this.context.renderer,
        this.probeScene,
        this.camera,
        this.probeTarget,
        fragment,
        vertex,
      );
    } finally {
      this.probeMesh.material = this.current;
    }
  }

  private buildUniforms(
    controls: readonly ShaderControl[],
    params: ShaderParams,
    channels: ChannelBindings,
  ): UniformMap {
    const T = this.context.three;

    const uniforms: UniformMap = {
      iTime: { value: this.options.time() },
      iResolution: { value: new T.Vector2(1, 1) },
      iMouse: { value: new T.Vector4(-1000, -1000, 0, 0) },
      iMouseVel: { value: new T.Vector2(0, 0) },
      u_clickData: { value: this.options.clickData },
    };

    // A placeholder to begin with where a binding cannot be resolved yet: a
    // binding to a buffer names a texture that ping-pongs, so there is nothing
    // stable to put here. The binder fills them in for real, every frame, just
    // before the pass is drawn.
    for (let index = 0; index < CHANNEL_COUNT; index++) {
      uniforms[CHANNEL_UNIFORMS[index]] = { value: this.binder.resolve(channels[index]) };
    }

    for (const control of controls) {
      const value = params[control.key] ?? control.default;
      uniforms[UNIFORM_PREFIX + control.key] = {
        value: control.type === 'color' ? new T.Color(String(value)) : value,
      };
    }

    // Carry the live resolution across a recompile so the first frame after an
    // edit is not rendered against a 1×1 viewport.
    const existing = this.registry.primary['iResolution']?.value as THREE.Vector2 | undefined;
    if (existing) (uniforms['iResolution'].value as THREE.Vector2).copy(existing);

    return uniforms;
  }

  // ---------------------------------------------------------------------------
  // Output
  // ---------------------------------------------------------------------------

  /**
   * The raw driver output for one pass's failed compile, deduplicated per pass:
   * a debounce that fires again on source the user has not touched — or a forced
   * recompile of every pass, whether it changed or not — must not repeat the same
   * driver log for a shader that is still broken in exactly the way it was a
   * moment ago.
   */
  private logFailure(passId: string, diagnostics: readonly CompileDiagnostic[]): void {
    const write = this.options.write;
    if (!write) return;

    const signature = diagnostics.map((diagnostic) => diagnostic.message).join('\n');
    if (this.lastFailureByPass.get(passId) === signature) return;
    this.lastFailureByPass.set(passId, signature);

    const count = diagnostics.length;
    write(
      'error',
      'compiler',
      `Pass "${passId}" failed to compile (${count} ${count === 1 ? 'issue' : 'issues'}).`,
    );
    for (const diagnostic of diagnostics) write('error', 'compiler', diagnostic.message);
  }

  /** A concise summary, only for an *explicit* compile — Ctrl+Enter or a save. */
  private summarise(force: boolean, errors: number): void {
    const write = this.options.write;
    if (!force || !write) return;

    if (errors === 0) {
      write('info', 'compiler', 'Shader compiled successfully.');
    } else {
      write(
        'error',
        'compiler',
        `Compilation failed with ${errors} ${errors === 1 ? 'error' : 'errors'}.`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Context loss and teardown
  // ---------------------------------------------------------------------------

  /**
   * Every program the driver held died with the context. Forget them — without
   * disposing, because there is nothing left on the GPU to free — so that the
   * next compile cannot recognise their sources as unchanged and "reuse"
   * materials that no longer exist.
   *
   * What survives is `lastSpec`, which is what makes the restore a replay rather
   * than a reload, and the primary uniform map, which is still what the canvas
   * resolution is read from.
   */
  invalidate(): void {
    this.buffers = [];
    this.image = null;
    this.registry.unregisterAll();
    // `lastFailureByPass` is deliberately kept: a pass that is still broken in
    // exactly the way it was is not news just because the context came back.
  }

  /** Frees every program and the probe target. Safe to call repeatedly. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.probeTarget.dispose();

    for (const pass of this.buffers) pass.material.dispose();
    this.buffers = [];
    this.image = null;

    // The accepted Image program, and the placeholder that stood in for it —
    // the same object until something was accepted, two distinct ones after that.
    if (this.current !== this.placeholder) this.current.dispose();
    this.placeholder.dispose();
    this.current = this.placeholder;

    this.probeMesh.material = this.placeholder;
    this.registry.unregisterAll();
    this.lastFailureByPass.clear();
  }
}
