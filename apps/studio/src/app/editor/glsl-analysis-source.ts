import type { AnalysisDiagnostic, GlslStage } from '@shadergrove/glsl-analysis';
import { VERTEX_DOC } from '@shadergrove/shared/diagnostic';
import { expandMacros } from '@shadergrove/shared/glsl-export';
import { composePass, locate, type SourceSpan } from '@shadergrove/shared/pass-source';
import type { RenderPass, ShaderProject } from '@shadergrove/shared/project';

/**
 * Turning a project into the ESSL the analysis front end should see, and the
 * front end's locations back into documents.
 *
 * What the driver compiles is not what the user typed. three.js's
 * `ShaderMaterial` (which the engine uses) puts `#version 300 es`, its own
 * compatibility defines, precision statements and declarations in front of the
 * source, so legacy `gl_FragColor`/`texture2D`/`varying` shaders are accepted as
 * ESSL 3.00. Analysing the bare text would flag perfectly valid shaders and miss
 * redeclarations of what three.js already declared. The prefixes below are
 * therefore three.js's, for a plain `ShaderMaterial` probed into a render target
 * (no tone mapping, linear output) — and deliberately NOT the declarations that
 * `buildFullGlsl` adds for export, which serve a different purpose. The user's
 * `#version` and precision are never altered.
 *
 * `glsl-analysis-source.node.spec.ts` pins this prefix to the installed three.js.
 */

const PRECISION = [
  'precision highp float;',
  ...[
    'int',
    'sampler2D',
    'samplerCube',
    'sampler3D',
    'sampler2DArray',
    'sampler2DShadow',
    'samplerCubeShadow',
    'sampler2DArrayShadow',
    'isampler2D',
    'isampler3D',
    'isamplerCube',
    'isampler2DArray',
    'usampler2D',
    'usampler3D',
    'usamplerCube',
    'usampler2DArray',
  ].map((type) => `precision highp ${type};`),
  '#define HIGH_PRECISION',
  '#define SHADER_TYPE ShaderMaterial',
  '#define SHADER_NAME ShaderMaterial',
];

const VERTEX_PREFIX = [
  '#version 300 es',
  '#define attribute in',
  '#define varying out',
  '#define texture2D texture',
  ...PRECISION,
  'uniform mat4 modelMatrix;',
  'uniform mat4 modelViewMatrix;',
  'uniform mat4 projectionMatrix;',
  'uniform mat4 viewMatrix;',
  'uniform mat3 normalMatrix;',
  'uniform vec3 cameraPosition;',
  'uniform bool isOrthographic;',
  'attribute vec3 position;',
  'attribute vec3 normal;',
  'attribute vec2 uv;',
];

/** `colorspace_pars_fragment`, `linearToOutputTexel` and `luminance` as three.js emits them. */
const FRAGMENT_PREFIX = [
  '#version 300 es',
  '#define varying in',
  'layout(location = 0) out highp vec4 pc_fragColor;',
  '#define gl_FragColor pc_fragColor',
  '#define gl_FragDepthEXT gl_FragDepth',
  '#define texture2D texture',
  '#define textureCube texture',
  '#define texture2DProj textureProj',
  '#define texture2DLodEXT textureLod',
  '#define texture2DProjLodEXT textureProjLod',
  '#define textureCubeLodEXT textureLod',
  '#define texture2DGradEXT textureGrad',
  '#define texture2DProjGradEXT textureProjGrad',
  '#define textureCubeGradEXT textureGrad',
  ...PRECISION,
  'uniform mat4 viewMatrix;',
  'uniform vec3 cameraPosition;',
  'uniform bool isOrthographic;',
  'vec4 LinearTransferOETF( in vec4 value ) {',
  '\treturn value;',
  '}',
  'vec4 sRGBTransferEOTF( in vec4 value ) {',
  '\treturn vec4( mix( pow( value.rgb * 0.9478672986 + vec3( 0.0521327014 ), vec3( 2.4 ) ), value.rgb * 0.0773993808, vec3( lessThanEqual( value.rgb, vec3( 0.04045 ) ) ) ), value.a );',
  '}',
  'vec4 sRGBTransferOETF( in vec4 value ) {',
  '\treturn vec4( mix( pow( value.rgb, vec3( 0.41666 ) ) * 1.055 - vec3( 0.055 ), value.rgb * 12.92, vec3( lessThanEqual( value.rgb, vec3( 0.0031308 ) ) ) ), value.a );',
  '}',
  'vec4 linearToOutputTexel( vec4 value ) {',
  '\treturn LinearTransferOETF( vec4( value.rgb * mat3( 1.0000,0.0000,0.0000,0.0000,1.0000,0.0000,0.0000,0.0000,1.0000 ), value.a ) );',
  '}',
  'float luminance( const in vec3 rgb ) {',
  '\tconst vec3 weights = vec3( 0.2126, 0.7152, 0.0722 );',
  '\treturn dot( weights, rgb );',
  '}',
];

export const GENERATED_PREFIX: Readonly<Record<GlslStage, string>> = {
  vertex: `${VERTEX_PREFIX.join('\n')}\n`,
  fragment: `${FRAGMENT_PREFIX.join('\n')}\n`,
};

function lineCount(text: string): number {
  let count = 0;
  for (const char of text) if (char === '\n') count++;
  return count;
}

/**
 * Names three.js declares in front of the user's source. They are the analysis
 * front end's globals but not the user's, so they are never offered as the
 * project's own symbols.
 */
export const GENERATED_GLOBALS: Readonly<Record<GlslStage, ReadonlySet<string>>> = {
  // Per stage: `position`, `uv` and `modelMatrix` are three's in the vertex
  // prefix but valid user uniforms in a fragment, and vice versa for the helpers.
  vertex: new Set([
    'modelMatrix',
    'modelViewMatrix',
    'projectionMatrix',
    'viewMatrix',
    'normalMatrix',
    'cameraPosition',
    'isOrthographic',
    'position',
    'normal',
    'uv',
  ]),
  fragment: new Set([
    'viewMatrix',
    'cameraPosition',
    'isOrthographic',
    'pc_fragColor',
    'LinearTransferOETF',
    'sRGBTransferEOTF',
    'sRGBTransferOETF',
    'linearToOutputTexel',
    'luminance',
  ]),
};

/**
 * The functions each stage's prefix defines, by name and exact parameter types.
 * Identity by signature, not by line: `#line` lets user code claim any line, and
 * a user overload with other parameter types is the user's.
 */
const GENERATED_FUNCTIONS: Readonly<
  Record<GlslStage, Readonly<Record<string, readonly string[]>>>
> = {
  vertex: {},
  fragment: {
    LinearTransferOETF: ['vec4'],
    sRGBTransferEOTF: ['vec4'],
    sRGBTransferOETF: ['vec4'],
    linearToOutputTexel: ['vec4'],
    luminance: ['vec3'],
  },
};

/** Whether `symbol` is a function three.js's prefix defines for `stage`. */
export function isGeneratedFunction(
  stage: GlslStage,
  symbol: { readonly name: string; readonly parameters: readonly { type: { base: string } }[] },
): boolean {
  const known = GENERATED_FUNCTIONS[stage][symbol.name];
  return (
    !!known &&
    known.length === symbol.parameters.length &&
    known.every((base, index) => symbol.parameters[index].type.base === base)
  );
}

/** One source the front end analyses: a render pass's fragment, or the vertex shader. */
export interface AnalysisUnit {
  /** Stable identity inside a project: the pass id, or `@vertex`. */
  readonly key: string;
  readonly stage: GlslStage;
  /** What is sent to the compiler: generated prefix, then the user's composed source. */
  readonly source: string;
  /** Lines the generated prefix occupies; user line 1 is compiler line `prefixLines + 1`. */
  readonly prefixLines: number;
  /** The document the unit is blamed on when no line can be attributed. */
  readonly docId: string;
  readonly docName: string;
  /** Composed line -> originating document line. Null for the vertex shader (not composed). */
  readonly spans: readonly SourceSpan[] | null;
  /** Every document whose text is part of this unit. */
  readonly docIds: ReadonlySet<string>;
  /** Composed lines whose text `expandMacros` rewrote, so columns there are not trusted. */
  readonly rewrittenLines: ReadonlySet<number>;
  /** `#line` makes compiler line numbers mean something else; nothing is attributed then. */
  readonly remapsLines: boolean;
  /** Original text per document, for column verification. */
  readonly lines: ReadonlyMap<string, readonly string[]>;
}

const LINE_DIRECTIVE = /^\s*#\s*line\b/m;

function rewrittenLines(composed: string): Set<number> {
  const rewritten = new Set<number>();
  composed.split('\n').forEach((line, index) => {
    if (line !== expandMacros(line)) rewritten.add(index + 1);
  });
  return rewritten;
}

function documentLines(project: ShaderProject, ids: ReadonlySet<string>) {
  const lines = new Map<string, readonly string[]>();
  for (const pass of project.passes) {
    if (ids.has(pass.id)) lines.set(pass.id, pass.source.split('\n'));
  }
  for (const file of project.files) {
    if (ids.has(file.id)) lines.set(file.id, file.source.split('\n'));
  }
  if (ids.has(VERTEX_DOC)) lines.set(VERTEX_DOC, project.vertex.split('\n'));
  return lines;
}

/** The fragment unit for a pass, composed exactly as the renderer composes it. */
export function prepareFragmentUnit(project: ShaderProject, pass: RenderPass): AnalysisUnit {
  const composed = composePass(project, pass);
  const docIds = new Set<string>(composed.spans.map((span) => span.docId));
  docIds.add(pass.id);

  return {
    key: pass.id,
    stage: 'fragment',
    source: GENERATED_PREFIX.fragment + expandMacros(composed.source),
    prefixLines: lineCount(GENERATED_PREFIX.fragment),
    docId: pass.id,
    docName: pass.name,
    spans: composed.spans,
    docIds,
    rewrittenLines: rewrittenLines(composed.source),
    remapsLines: LINE_DIRECTIVE.test(composed.source),
    lines: documentLines(project, docIds),
  };
}

/** The vertex unit. The vertex shader is not composed: no Common, no `#include`. */
export function prepareVertexUnit(project: ShaderProject): AnalysisUnit {
  const docIds = new Set([VERTEX_DOC]);
  return {
    key: VERTEX_DOC,
    stage: 'vertex',
    source: GENERATED_PREFIX.vertex + expandMacros(project.vertex),
    prefixLines: lineCount(GENERATED_PREFIX.vertex),
    docId: VERTEX_DOC,
    docName: 'Vertex',
    spans: null,
    docIds,
    rewrittenLines: rewrittenLines(project.vertex),
    remapsLines: LINE_DIRECTIVE.test(project.vertex),
    lines: documentLines(project, docIds),
  };
}

/** Every unit worth analysing: each non-Common pass (enabled or not) and the vertex shader. */
export function prepareUnits(project: ShaderProject): AnalysisUnit[] {
  return [
    ...project.passes
      .filter((pass) => pass.kind !== 'common')
      .map((pass) => prepareFragmentUnit(project, pass)),
    prepareVertexUnit(project),
  ];
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/**
 * How trustworthy a diagnostic's position is.
 *
 * - `user`: a line of a document, and a column when one is given.
 * - `generated`: the compiler blamed the generated prefix (a redeclaration clash
 *   is the usual cause); there is no document line, so it is pinned to the unit's
 *   document without a position.
 * - `unattributed`: the compiler gave no line (link errors), or `#line` made its
 *   line numbers meaningless.
 */
export type DiagnosticOrigin = 'user' | 'generated' | 'unattributed';

export interface MappedDiagnostic {
  readonly docId: string;
  readonly docName: string;
  readonly severity: AnalysisDiagnostic['severity'];
  readonly phase: AnalysisDiagnostic['phase'];
  readonly message: string;
  readonly origin: DiagnosticOrigin;
  /** 1-based line in the document; null unless `origin` is `user`. */
  readonly line: number | null;
  /** 1-based UTF-16 columns, only when verified against the document's text. */
  readonly startColumn: number | null;
  readonly endColumn: number | null;
  /** Passes whose analysis reported it (shared-include errors appear once, with every pass). */
  readonly passIds: readonly string[];
}

/**
 * Compiler columns are only used when they are demonstrably right: the quoted
 * token has to sit at that column in the *document's own* line. A line that
 * `expandMacros` rewrote, or a user macro that expanded to something else, fails
 * that test and keeps the line without a column rather than a wrong one.
 */
function verifiedColumns(
  token: string | null,
  column: number | null,
  line: string | undefined,
  rewritten: boolean,
): { start: number; end: number } | null {
  if (!token || column === null || line === undefined || rewritten) return null;
  if (line.startsWith(token, column - 1)) return { start: column, end: column + token.length };
  // glslang may report the end of the token.
  const start = column - token.length;
  if (start >= 1 && line.startsWith(token, start - 1)) return { start, end: column };
  return null;
}

export function mapDiagnostic(
  unit: AnalysisUnit,
  diagnostic: AnalysisDiagnostic,
): MappedDiagnostic {
  const base = {
    severity: diagnostic.severity,
    phase: diagnostic.phase,
    message: diagnostic.message,
    startColumn: null,
    endColumn: null,
    passIds: [unit.key],
  };
  const pinned = (origin: DiagnosticOrigin): MappedDiagnostic => ({
    ...base,
    docId: unit.docId,
    docName: unit.docName,
    origin,
    line: null,
  });

  const at = diagnostic.location;
  if (!at || unit.remapsLines || at.sourceString !== '0' || at.line < 1) {
    return pinned('unattributed');
  }

  const composedLine = at.line - unit.prefixLines;
  if (composedLine < 1) return pinned('generated');

  const origin = unit.spans ? locate(unit.spans, composedLine) : null;
  if (unit.spans && !origin) return pinned('unattributed');

  const docId = origin?.docId ?? unit.docId;
  const line = origin?.line ?? composedLine;
  const columns = verifiedColumns(
    diagnostic.token,
    at.column,
    unit.lines.get(docId)?.[line - 1],
    unit.rewrittenLines.has(composedLine),
  );

  return {
    ...base,
    docId,
    docName: origin?.docName ?? unit.docName,
    origin: 'user',
    line,
    startColumn: columns?.start ?? null,
    endColumn: columns?.end ?? null,
  };
}

/** Shared-include errors show up once per analysed pass; keep one with every pass named. */
export function dedupeDiagnostics(diagnostics: readonly MappedDiagnostic[]): MappedDiagnostic[] {
  const merged = new Map<string, MappedDiagnostic>();
  for (const diagnostic of diagnostics) {
    const key = [
      diagnostic.docId,
      diagnostic.line,
      diagnostic.startColumn,
      diagnostic.severity,
      diagnostic.origin,
      diagnostic.message,
    ].join('\u0000');
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, diagnostic);
      continue;
    }
    merged.set(key, {
      ...existing,
      passIds: [...new Set([...existing.passIds, ...diagnostic.passIds])],
    });
  }
  return [...merged.values()];
}
