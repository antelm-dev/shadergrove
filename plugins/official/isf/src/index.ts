// Shadergrove ISF plugin — one-pass ISF FX filters to and from custom effects.
//
// Runs inside the plugin Worker: no DOM, no network, no runtime imports; it only sees the
// bytes and form values the host hands it, and the host revalidates and compiles
// whatever it returns. https://docs.isf.video/ref_json, /ref_functions.html
//
// Import keeps the ISF GLSL as it is, between two marker lines, and adapts it with
// the preprocessor only — `#define main isf_main`, the IMG_* macros, TIME,
// RENDERSIZE, one macro and one global per input — so
// nothing in the author's code is rewritten.
// Export rebuilds the JSON header from the effect's controls and current values.
//
// Supported: ISFVSN 2, one `inputImage`, no PASSES (or one plain pass), inputs of
// type float, bool, long (with VALUES) and color (alpha dropped: controls are RGB).
// Native exports sample inputImage with texture2D and need sampler2D hosts; rectangle-texture hosts need sampling rewritten with IMG_NORM_PIXEL.
// Built-ins: isf_FragNormCoord, RENDERSIZE, TIME, PASSINDEX, IMG_THIS_PIXEL,
// IMG_NORM_THIS_PIXEL (and IMG_THIS_NORM_PIXEL), IMG_NORM_PIXEL, IMG_PIXEL, IMG_SIZE. Anything else fails to
// compile, and the host shows where.

import type { ParamValue, ShaderControl, ShaderParams } from '@shadergrove/shared/model';
import type {
  EffectCandidate,
  ExporterInput,
  ExporterResult,
  ImporterInput,
  ImporterResult,
} from '@shadergrove/shared/plugin';

/** Parsed ISF JSON — a header, an input or a pass: untrusted, checked field by field as it is read. */
/* eslint-disable @typescript-eslint/no-explicit-any */
interface Isf {
  [field: string]: unknown;
  ISFVSN?: any;
  DESCRIPTION?: any;
  IMPORTED?: any;
  PASSES?: any;
  INPUTS?: any;
  NAME?: any;
  TYPE?: any;
  LABEL?: any;
  LABELS?: any;
  DEFAULT?: any;
  MIN?: any;
  MAX?: any;
  VALUES?: any;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const HEADER_MARK = '// ISF-HEADER: ';
const BEGIN_MARK = '// ---- ISF source ----';
const END_MARK = '// ---- end of ISF source ----';
const MAX_CONTROLS = 16;
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
// The app's own uniform names, and every name this file defines a macro or a symbol for.
const RESERVED = new Set([
  'clickData',
  'time',
  'resolution',
  'mouse',
  'mouseVel',
  'channel0',
  'channel1',
  'channel2',
  'channel3',
  'main',
  'effect',
  'inputImage',
  'tDiffuse',
  'vUv',
  'TIME',
  'RENDERSIZE',
  'PASSINDEX',
  'IMG_THIS_PIXEL',
  'IMG_THIS_NORM_PIXEL',
  'IMG_NORM_THIS_PIXEL',
  'IMG_NORM_PIXEL',
  'IMG_PIXEL',
  'IMG_SIZE',
]);
// GLSL ES 1.00 keywords, future reserved words and built-ins cannot be uniforms or input macros.
const GLSL_RESERVED = new Set([
  'attribute',
  'const',
  'uniform',
  'varying',
  'break',
  'continue',
  'do',
  'for',
  'while',
  'if',
  'else',
  'in',
  'out',
  'inout',
  'float',
  'int',
  'void',
  'bool',
  'true',
  'false',
  'lowp',
  'mediump',
  'highp',
  'precision',
  'invariant',
  'discard',
  'return',
  'mat2',
  'mat3',
  'mat4',
  'vec2',
  'vec3',
  'vec4',
  'ivec2',
  'ivec3',
  'ivec4',
  'bvec2',
  'bvec3',
  'bvec4',
  'sampler2D',
  'samplerCube',
  'struct',
  'asm',
  'class',
  'union',
  'enum',
  'typedef',
  'template',
  'this',
  'packed',
  'goto',
  'switch',
  'default',
  'inline',
  'noinline',
  'volatile',
  'public',
  'static',
  'extern',
  'external',
  'interface',
  'flat',
  'long',
  'short',
  'double',
  'half',
  'fixed',
  'unsigned',
  'superp',
  'input',
  'output',
  'hvec2',
  'hvec3',
  'hvec4',
  'dvec2',
  'dvec3',
  'dvec4',
  'fvec2',
  'fvec3',
  'fvec4',
  'sampler1D',
  'sampler3D',
  'sampler1DShadow',
  'sampler2DShadow',
  'sampler2DRect',
  'sampler3DRect',
  'sampler2DRectShadow',
  'sizeof',
  'cast',
  'namespace',
  'using',
  'radians',
  'degrees',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'pow',
  'exp',
  'log',
  'exp2',
  'log2',
  'sqrt',
  'inversesqrt',
  'abs',
  'sign',
  'floor',
  'ceil',
  'fract',
  'mod',
  'min',
  'max',
  'clamp',
  'mix',
  'step',
  'smoothstep',
  'length',
  'distance',
  'dot',
  'cross',
  'normalize',
  'faceforward',
  'reflect',
  'refract',
  'matrixCompMult',
  'lessThan',
  'lessThanEqual',
  'greaterThan',
  'greaterThanEqual',
  'equal',
  'notEqual',
  'any',
  'all',
  'not',
  'texture2D',
  'texture2DProj',
  'texture2DLod',
  'texture2DProjLod',
  'textureCube',
  'textureCubeLod',
  'defined',
  // GLSL ES 3.00 spec sections 3.8 (keywords/reserved words) and 8 (built-in functions).
  'layout',
  'centroid',
  'smooth',
  'case',
  'mat2x2',
  'mat2x3',
  'mat2x4',
  'mat3x2',
  'mat3x3',
  'mat3x4',
  'mat4x2',
  'mat4x3',
  'mat4x4',
  'uint',
  'uvec2',
  'uvec3',
  'uvec4',
  'samplerCubeShadow',
  'sampler2DArray',
  'sampler2DArrayShadow',
  'isampler2D',
  'isampler3D',
  'isamplerCube',
  'isampler2DArray',
  'usampler2D',
  'usampler3D',
  'usamplerCube',
  'usampler2DArray',
  'coherent',
  'restrict',
  'readonly',
  'writeonly',
  'resource',
  'atomic_uint',
  'noperspective',
  'patch',
  'sample',
  'subroutine',
  'common',
  'partition',
  'active',
  'filter',
  'image1D',
  'image2D',
  'image3D',
  'imageCube',
  'iimage1D',
  'iimage2D',
  'iimage3D',
  'iimageCube',
  'uimage1D',
  'uimage2D',
  'uimage3D',
  'uimageCube',
  'image1DArray',
  'image2DArray',
  'iimage1DArray',
  'iimage2DArray',
  'uimage1DArray',
  'uimage2DArray',
  'imageBuffer',
  'iimageBuffer',
  'uimageBuffer',
  'sampler1DArray',
  'sampler1DArrayShadow',
  'isampler1D',
  'isampler1DArray',
  'usampler1D',
  'usampler1DArray',
  'isampler2DRect',
  'usampler2DRect',
  'samplerBuffer',
  'isamplerBuffer',
  'usamplerBuffer',
  'sampler2DMS',
  'isampler2DMS',
  'usampler2DMS',
  'sampler2DMSArray',
  'isampler2DMSArray',
  'usampler2DMSArray',
  'sinh',
  'cosh',
  'tanh',
  'asinh',
  'acosh',
  'atanh',
  'trunc',
  'round',
  'roundEven',
  'modf',
  'isnan',
  'isinf',
  'floatBitsToInt',
  'floatBitsToUint',
  'intBitsToFloat',
  'uintBitsToFloat',
  'packSnorm2x16',
  'unpackSnorm2x16',
  'packUnorm2x16',
  'unpackUnorm2x16',
  'packHalf2x16',
  'unpackHalf2x16',
  'outerProduct',
  'transpose',
  'determinant',
  'inverse',
  'texture',
  'textureProj',
  'textureLod',
  'textureOffset',
  'texelFetch',
  'texelFetchOffset',
  'textureProjOffset',
  'textureLodOffset',
  'textureProjLod',
  'textureProjLodOffset',
  'textureGrad',
  'textureGradOffset',
  'textureProjGrad',
  'textureProjGradOffset',
  'textureSize',
  'dFdx',
  'dFdy',
  'fwidth',
]);
// three.js 0.185.1 src/renderers/webgl/WebGLProgram.js: ShaderMaterial fragment prefix,
// GLSL 3 conversion, and globals from tonemapping_pars_fragment / colorspace_pars_fragment.
// GLSL keywords and compatibility-macro targets are also covered by GLSL_RESERVED above.
const THREE_RESERVED = new Set([
  'HIGH_PRECISION',
  'MEDIUM_PRECISION',
  'LOW_PRECISION',
  'SHADER_TYPE',
  'SHADER_NAME',
  'ShaderMaterial',
  'USE_FOG',
  'FOG_EXP2',
  'ALPHA_TO_COVERAGE',
  'USE_MAP',
  'USE_MATCAP',
  'USE_ENVMAP',
  'ENVMAP_TYPE_CUBE',
  'ENVMAP_TYPE_CUBE_UV',
  'ENVMAP_MODE_REFLECTION',
  'ENVMAP_MODE_REFRACTION',
  'ENVMAP_BLENDING_NONE',
  'ENVMAP_BLENDING_MULTIPLY',
  'ENVMAP_BLENDING_MIX',
  'ENVMAP_BLENDING_ADD',
  'CUBEUV_TEXEL_WIDTH',
  'CUBEUV_TEXEL_HEIGHT',
  'CUBEUV_MAX_MIP',
  'USE_LIGHTMAP',
  'USE_AOMAP',
  'USE_BUMPMAP',
  'USE_NORMALMAP',
  'USE_NORMALMAP_OBJECTSPACE',
  'USE_NORMALMAP_TANGENTSPACE',
  'USE_PACKED_NORMALMAP',
  'USE_EMISSIVEMAP',
  'USE_ANISOTROPY',
  'USE_ANISOTROPYMAP',
  'USE_CLEARCOAT',
  'USE_CLEARCOATMAP',
  'USE_CLEARCOAT_ROUGHNESSMAP',
  'USE_CLEARCOAT_NORMALMAP',
  'USE_DISPERSION',
  'USE_IRIDESCENCE',
  'USE_IRIDESCENCEMAP',
  'USE_IRIDESCENCE_THICKNESSMAP',
  'USE_SPECULARMAP',
  'USE_SPECULAR_COLORMAP',
  'USE_SPECULAR_INTENSITYMAP',
  'USE_ROUGHNESSMAP',
  'USE_METALNESSMAP',
  'USE_ALPHAMAP',
  'USE_ALPHATEST',
  'USE_ALPHAHASH',
  'USE_SHEEN',
  'USE_SHEEN_COLORMAP',
  'USE_SHEEN_ROUGHNESSMAP',
  'USE_TRANSMISSION',
  'USE_TRANSMISSIONMAP',
  'USE_THICKNESSMAP',
  'USE_TANGENT',
  'USE_COLOR',
  'USE_COLOR_ALPHA',
  'USE_UV1',
  'USE_UV2',
  'USE_UV3',
  'USE_POINTS_UV',
  'USE_GRADIENTMAP',
  'FLAT_SHADED',
  'DOUBLE_SIDED',
  'FLIP_SIDED',
  'USE_SHADOWMAP',
  'SHADOWMAP_TYPE_BASIC',
  'SHADOWMAP_TYPE_PCF',
  'SHADOWMAP_TYPE_VSM',
  'PREMULTIPLIED_ALPHA',
  'USE_LIGHT_PROBES',
  'USE_LIGHT_PROBES_GRID',
  'DECODE_VIDEO_TEXTURE',
  'DECODE_VIDEO_TEXTURE_EMISSIVE',
  'USE_LOGARITHMIC_DEPTH_BUFFER',
  'USE_REVERSED_DEPTH_BUFFER',
  'viewMatrix',
  'cameraPosition',
  'isOrthographic',
  'TONE_MAPPING',
  'toneMapping',
  'toneMappingExposure',
  'saturate',
  'LinearToneMapping',
  'ReinhardToneMapping',
  'CineonToneMapping',
  'RRTAndODTFit',
  'ACESFilmicToneMapping',
  'LINEAR_REC2020_TO_LINEAR_SRGB',
  'LINEAR_SRGB_TO_LINEAR_REC2020',
  'agxDefaultContrastApprox',
  'AgXToneMapping',
  'NeutralToneMapping',
  'CustomToneMapping',
  'DITHERING',
  'OPAQUE',
  'LinearTransferOETF',
  'sRGBTransferEOTF',
  'sRGBTransferOETF',
  'linearToOutputTexel',
  'luminance',
  'DEPTH_PACKING',
  'pc_fragColor',
  'texture2DLodEXT',
  'texture2DProjLodEXT',
  'textureCubeLodEXT',
  'texture2DGradEXT',
  'texture2DProjGradEXT',
  'textureCubeGradEXT',
]);

const fail = (message: string): never => {
  throw new Error(message);
};

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function splitIsf(text: string): { header: Isf; body: string } {
  const start = text.indexOf('/*');
  if (start < 0 || text.slice(0, start).trim() !== '') {
    fail('Not an ISF file: it must start with a /*{ … }*/ JSON header');
  }
  const end = text.indexOf('*/', start + 2);
  if (end < 0) fail('The ISF JSON header is never closed with */');
  let header: unknown;
  try {
    header = JSON.parse(text.slice(start + 2, end));
  } catch (error) {
    fail(`The ISF JSON header is not valid JSON: ${(error as Error).message}`);
  }
  if (!header || typeof header !== 'object' || Array.isArray(header)) {
    fail('The ISF JSON header must be an object');
  }
  return { header: header as Isf, body: text.slice(end + 2).replace(/^\r?\n/, '') };
}

/**
 * An input is read from a global set before the ISF main runs. A macro naming the uniform
 * or an expression would also rewrite a declaration of that name, such as a function
 * parameter `vec4 color`, into one that does not compile — `u_color` is itself a macro in
 * a filter this plugin exported.
 */
function viaGlobal(key: string, type: string, value: string) {
  return {
    macro: `${type} isf_in_${key};\n#define ${key} isf_in_${key}`,
    setup: `  isf_in_${key} = ${value};`,
  };
}

function checkSupported(header: Isf): void {
  const version = header.ISFVSN;
  if (version === undefined) fail('ISF 1 files (no ISFVSN) are not supported; only ISF 2 is');
  if (!['2', '2.0'].includes(String(version))) {
    fail(`ISF version ${JSON.stringify(version)} is not supported; only ISF 2 is`);
  }
  if (Array.isArray(header.IMPORTED) ? header.IMPORTED.length > 0 : header.IMPORTED) {
    fail('Imported images (IMPORTED) are not supported');
  }
  if (header.PASSES !== undefined) {
    if (!Array.isArray(header.PASSES)) fail('PASSES must be an array');
    if (header.PASSES.length > 1) {
      fail(`Multi-pass ISF is not supported: this file has ${header.PASSES.length} passes`);
    }
    const pass = header.PASSES[0] ?? {};
    if (pass.TARGET || pass.PERSISTENT || pass.FLOAT) {
      fail('Persistent or named pass buffers are not supported');
    }
    // The effect renders at the output size; a pass of its own size would not be the same image.
    if (pass.WIDTH !== undefined || pass.HEIGHT !== undefined) {
      fail('Passes with their own WIDTH or HEIGHT are not supported');
    }
  }
}

const number = <T>(value: unknown, fallback: T): number | T =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

function label(input: Isf): { label?: string } {
  return typeof input.LABEL === 'string' && input.LABEL.trim()
    ? { label: input.LABEL.trim().slice(0, 64) }
    : {};
}

function hex(rgba: unknown): string {
  const channel = (value: unknown) =>
    Math.round(clamp(number(value, 0), 0, 1) * 255)
      .toString(16)
      .padStart(2, '0');
  return Array.isArray(rgba)
    ? `#${channel(rgba[0])}${channel(rgba[1])}${channel(rgba[2])}`
    : '#000000';
}

/**
 * A name both sides can use: a control key here, an input NAME in ISF. `isf_` and `u_`
 * names are this file's and the app's own: `u_time` is the time uniform, and a key
 * `u_gain` beside a key `gain` would be read through the other's macro.
 * Swizzle names would also rewrite vector components through the input macro.
 */
const usableName = (key: unknown): key is string =>
  typeof key === 'string' &&
  KEY.test(key) &&
  !/^(?:[xyzw]{1,4}|[rgba]{1,4}|[stpq]{1,4})$/.test(key) &&
  !RESERVED.has(key) &&
  !GLSL_RESERVED.has(key) &&
  !THREE_RESERVED.has(key) &&
  // GLSL ES 3.00 sections 3.5, 3.8 and 3.9 reserve these macro/identifier namespaces.
  !key.startsWith('gl_') &&
  !key.startsWith('GL_') &&
  !key.includes('__') &&
  !key.startsWith('isf_') &&
  !key.startsWith('u_');

/** One ISF input as a control, and the macro that makes the ISF name mean that control's uniform. */
function inputToControl(input: Isf): { control: ShaderControl; macro: string; setup: string } {
  const key = input.NAME;
  if (!usableName(key)) {
    fail(
      `Input name ${JSON.stringify(key)} cannot be used here: it must be a plain identifier, not a reserved name or vector swizzle`,
    );
  }
  switch (input.TYPE) {
    case 'float': {
      // ISF makes MIN and MAX optional; a control needs a range, so one is chosen that
      // holds the DEFAULT rather than one that would change it.
      const given = number(input.DEFAULT, undefined);
      const min = number(input.MIN, Math.min(0, given ?? 0, number(input.MAX, 1) - 1));
      const max = number(input.MAX, Math.max(min + 1, given ?? 1));
      if (!(min < max)) fail(`Input "${key}": MIN must be less than MAX`);
      return {
        control: {
          key,
          type: 'number',
          default: clamp(given ?? min, min, max),
          min,
          max,
          ...label(input),
        },
        ...viaGlobal(key, 'float', `u_${key}`),
      };
    }
    case 'bool':
      return {
        control: { key, type: 'boolean', default: Boolean(input.DEFAULT), ...label(input) },
        ...viaGlobal(key, 'bool', `u_${key}`),
      };
    case 'long': {
      const values = input.VALUES;
      if (
        !Array.isArray(values) ||
        values.length === 0 ||
        values.length > 64 ||
        !values.every(Number.isInteger)
      ) {
        fail(`Input "${key}": a long input needs VALUES, a list of at most 64 integers`);
      }
      const labels = Array.isArray(input.LABELS) ? input.LABELS : [];
      const options: Record<string, number> = {};
      values.forEach((value: number, index: number) => {
        const name =
          typeof labels[index] === 'string' && labels[index].trim()
            ? labels[index].trim()
            : String(value);
        let optionName = name;
        let attempt = 1;
        while (optionName in options) {
          optionName = `${name} (${value})${attempt === 1 ? '' : ` ${attempt}`}`;
          attempt++;
        }
        options[optionName] = value;
      });
      return {
        control: {
          key,
          type: 'select',
          default: values.includes(input.DEFAULT) ? input.DEFAULT : values[0],
          options,
          ...label(input),
        },
        ...viaGlobal(key, 'int', `int(u_${key})`),
      };
    }
    case 'color':
      return {
        control: { key, type: 'color', default: hex(input.DEFAULT), ...label(input) },
        ...viaGlobal(key, 'vec4', `vec4(u_${key}, 1.0)`),
      };
    case 'image':
      return fail(
        `Only one image input, inputImage, is supported: "${key}" makes this a transition or a multi-image filter`,
      );
    case 'audio':
    case 'audioFFT':
      return fail(`Input "${key}": audio inputs are not supported`);
    case 'point2D':
      return fail(`Input "${key}": point2D inputs are not supported`);
    case 'event':
      return fail(`Input "${key}": event inputs are not supported`);
    default:
      return fail(`Input "${key}": type ${JSON.stringify(input.TYPE)} is not supported`);
  }
}

function importIsf(text: string): ImporterResult & { candidate: EffectCandidate } {
  const { header, body } = splitIsf(text);
  checkSupported(header);
  const inputs: unknown = header.INPUTS ?? [];
  if (!Array.isArray(inputs)) return fail('INPUTS must be an array');
  const isImage = (input: Isf) => input && input.NAME === 'inputImage' && input.TYPE === 'image';
  if (!inputs.some(isImage)) {
    fail('This ISF file has no inputImage: it is a generator, and only FX filters are supported');
  }
  const converted = (inputs as Isf[]).filter((input) => !isImage(input)).map(inputToControl);
  if (converted.length > MAX_CONTROLS) fail(`At most ${MAX_CONTROLS} inputs are supported`);

  const controls = converted.map((entry) => entry.control);
  const values: ShaderParams = Object.fromEntries(
    controls.map((control) => [control.key, control.default]),
  );
  const name =
    (typeof header.DESCRIPTION === 'string' && header.DESCRIPTION.trim().slice(0, 64)) ||
    'ISF effect';
  // The header, minus what the controls now hold, so an export can restore CREDIT and the rest.
  const { INPUTS: _inputs, ...kept } = header;
  const source = [
    '// Converted from ISF by the Shadergrove ISF plugin. Edit the ISF code between the',
    '// two marker lines; the lines around them are what lets it run here.',
    HEADER_MARK + JSON.stringify(kept),
    '#define inputImage tDiffuse',
    '#define RENDERSIZE u_resolution',
    '#define TIME u_time',
    // One pass at most, so always the first.
    '#define PASSINDEX 0',
    '#define IMG_NORM_PIXEL(image, coord) texture2D(tDiffuse, coord)',
    // The spec's name, and the spelling some hosts also accept.
    '#define IMG_NORM_THIS_PIXEL(image) texture2D(tDiffuse, isf_uv)',
    '#define IMG_THIS_NORM_PIXEL(image) texture2D(tDiffuse, isf_uv)',
    '#define IMG_THIS_PIXEL(image) texture2D(tDiffuse, isf_uv)',
    '#define IMG_PIXEL(image, coord) texture2D(tDiffuse, (coord) / u_resolution)',
    '#define IMG_SIZE(image) u_resolution',
    '#define isf_FragNormCoord isf_uv',
    ...converted.map((entry) => entry.macro),
    'vec2 isf_uv;',
    '#define main isf_main',
    '#define effect isf_inner_effect',
    BEGIN_MARK,
    body.replace(/\s+$/, ''),
    END_MARK,
    '#undef effect',
    '#undef main',
    'vec4 effect(vec4 isf_color, vec2 isf_coord) {',
    '  isf_uv = isf_coord;',
    ...converted.flatMap((entry) => (entry.setup ? [entry.setup] : [])),
    '  isf_main();',
    '  return gl_FragColor;',
    '}',
    '',
  ].join('\n');
  return { candidate: { name, source, controls, values } };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function rgba(value: unknown): number[] {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(value));
  if (!match) return [0, 0, 0, 1];
  return [1, 2, 3].map((i) => Math.round((parseInt(match[i]!, 16) / 255) * 1000) / 1000).concat(1);
}

/** A control back as an ISF input, its DEFAULT the effect's current value. */
function controlToInput(control: ShaderControl, values: Record<string, ParamValue>): Isf {
  if (!usableName(control.key)) {
    fail(
      `Control "${control.key}" cannot be exported: its name is reserved in ISF or by this plugin, or is a vector swizzle`,
    );
  }
  const value = values[control.key] ?? control.default;
  const named = { NAME: control.key, ...(control.label ? { LABEL: control.label } : {}) };
  switch (control.type) {
    case 'number':
      return { ...named, TYPE: 'float', DEFAULT: value, MIN: control.min, MAX: control.max };
    case 'boolean':
      return { ...named, TYPE: 'bool', DEFAULT: Boolean(value) };
    case 'select': {
      const entries = Object.entries(control.options);
      if (!entries.every((entry) => Number.isInteger(entry[1]))) {
        fail(
          `Control "${control.key}" cannot be exported: an ISF long input takes integer values only`,
        );
      }
      return {
        ...named,
        TYPE: 'long',
        DEFAULT: value,
        VALUES: entries.map((entry) => entry[1]),
        LABELS: entries.map((entry) => entry[0]),
      };
    }
    case 'color':
      return { ...named, TYPE: 'color', DEFAULT: rgba(value) };
    default:
      return fail(`Control "${(control as ShaderControl).key}" cannot be expressed in ISF`);
  }
}

/** The ISF code and kept header of an effect this plugin imported, or null for any other effect. */
function extractIsf(source: string): { header: Isf; body: string } | null {
  const lines = source.split('\n');
  const headerLine = lines.find((line) => line.startsWith(HEADER_MARK));
  const begin = lines.indexOf(BEGIN_MARK);
  const end = lines.indexOf(END_MARK);
  if (!headerLine || begin < 0 || end < begin) return null;
  let header: Isf;
  try {
    header = JSON.parse(headerLine.slice(HEADER_MARK.length));
  } catch {
    return null;
  }
  return { header, body: lines.slice(begin + 1, end).join('\n') };
}

/**
 * Any other custom effect: its own code, made to read ISF's names, under an ISF main.
 * A control is read through a function declared at global scope, where its name can
 * only be the ISF input — a macro expanding to the bare name would bind to whatever
 * the effect's code declares under it, like `effect(vec4 color, …)` for a control `color`.
 */
function wrapNative(effect: EffectCandidate): string {
  const readers = effect.controls.flatMap((control) => {
    const [type, value] =
      control.type === 'color'
        ? ['vec3', `${control.key}.rgb`]
        : control.type === 'select'
          ? ['float', `float(${control.key})`]
          : control.type === 'boolean'
            ? ['bool', control.key]
            : ['float', control.key];
    return [
      `${type} isf_u_${control.key}() { return ${value}; }`,
      `#define u_${control.key} isf_u_${control.key}()`,
    ];
  });
  return [
    '// Exported from a Shadergrove custom effect: vec4 effect(vec4 color, vec2 uv) runs on',
    '// every pixel of inputImage. The defines map its names onto ISF’s.',
    '// This effect samples inputImage with texture2D and needs a host that binds images as sampler2D; rectangle-texture hosts need sampling rewritten with IMG_NORM_PIXEL.',
    '#define tDiffuse inputImage',
    '#define vUv isf_FragNormCoord',
    '#define u_resolution RENDERSIZE',
    '#define u_time TIME',
    ...readers,
    effect.source.replace(/\s+$/, ''),
    'void main() {',
    '  gl_FragColor = effect(IMG_THIS_PIXEL(inputImage), isf_FragNormCoord);',
    '}',
    // Imported back, this code is followed by Shadergrove's own main, which reads `vUv`.
    ...['tDiffuse', 'vUv', 'u_resolution', 'u_time']
      .concat(effect.controls.map((control) => `u_${control.key}`))
      .map((name) => `#undef ${name}`),
    '',
  ].join('\n');
}

function exportIsf(effect: EffectCandidate): ExporterResult {
  if (!effect || typeof effect.source !== 'string' || !Array.isArray(effect.controls)) {
    fail('Not an effect definition');
  }
  const values = effect.values && typeof effect.values === 'object' ? effect.values : {};
  const imported = extractIsf(effect.source);
  const header = {
    ...(imported ? imported.header : { ISFVSN: '2.0', CATEGORIES: ['Shadergrove'] }),
    DESCRIPTION: String(effect.name ?? 'Effect'),
    INPUTS: [
      { NAME: 'inputImage', TYPE: 'image' },
      ...effect.controls.map((control) => controlToInput(control, values)),
    ],
  };
  const body = imported ? `${imported.body.replace(/\s+$/, '')}\n` : wrapNative(effect);
  const text = `/*${JSON.stringify(header, null, 2).replace(/\*\//g, '*\\/')}*/\n${body}`;
  const stem =
    String(effect.name ?? 'effect')
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'effect';
  return {
    bytes: new TextEncoder().encode(text).buffer as ArrayBuffer,
    mime: 'text/plain',
    fileName: `${stem}.fs`,
  };
}

shaderStudio.handle('importer:isf-import', (params) => {
  const { bytes } = params as ImporterInput;
  let text = '';
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('The file is not UTF-8 text');
  }
  return importIsf(text);
});

shaderStudio.handle('exporter:isf-export', (params) =>
  exportIsf((params as ExporterInput).effect as EffectCandidate),
);
