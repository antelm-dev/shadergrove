import type * as THREE from 'three';

import type { CompileDiagnostic } from '@shadergrove/shared/diagnostic';
import { parseInfoLog, prefixLineCount } from '@shadergrove/shared/glsl-diagnostics';

/**
 * Compile a candidate program without letting it touch the screen.
 *
 * three.js compiles lazily on first draw, so the only way to know whether a
 * shader is valid is to draw with it: `scene` (holding the candidate) is drawn
 * once into `target`, a pixel nobody sees. While it draws, `onShaderError`
 * hands over the driver's log instead of three throwing. Lines come back
 * relative to `fragment`/`vertex` as given, with three's own prelude removed.
 * An empty list means the driver accepted it.
 */
export function probeProgram(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  target: THREE.WebGLRenderTarget,
  fragment: string,
  vertex: string,
): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  const previousHandler = renderer.debug.onShaderError;
  const previousTarget = renderer.getRenderTarget();

  renderer.debug.onShaderError = (gl, program, glVertexShader, glFragmentShader) => {
    const fragmentSource = gl.getShaderSource(glFragmentShader) ?? '';
    const vertexSource = gl.getShaderSource(glVertexShader) ?? '';

    diagnostics.push(
      ...parseInfoLog(
        gl.getShaderInfoLog(glFragmentShader) ?? '',
        'fragment',
        prefixLineCount(fragmentSource, fragment),
      ),
      ...parseInfoLog(
        gl.getShaderInfoLog(glVertexShader) ?? '',
        'vertex',
        prefixLineCount(vertexSource, vertex),
      ),
    );

    // A program can link-fail with both shaders clean — mismatched varyings,
    // too many uniforms. Without this the user would see a silent failure.
    if (diagnostics.length === 0) {
      const log = (gl.getProgramInfoLog(program) ?? '').trim();
      diagnostics.push({
        severity: 'error',
        line: 0,
        message: log || 'The shader program failed to link',
        source: 'fragment',
      });
    }
  };

  try {
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
  } catch (error) {
    diagnostics.push({
      severity: 'error',
      line: 0,
      message: `Renderer rejected the shader: ${String(error)}`,
      source: 'fragment',
    });
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.debug.onShaderError = previousHandler;
  }

  return diagnostics;
}
