/**
 * Private request/reply contract between an editor adapter and the ESSL
 * analysis Worker. All values are plain, structured-clone-safe data; no AST,
 * native pointer or compiler object crosses the boundary.
 */

export type GlslStage = 'vertex' | 'fragment';
export type EsslVersion = 100 | 300;

export interface EsslProfile {
  readonly language: 'essl';
  /** 100 = GLSL ES 1.00 (no `#version`), 300 = `#version 300 es`. */
  readonly version: EsslVersion;
}

/**
 * One prepared source to analyse. The adapter owns composition (Common,
 * includes, generated prefixes) and its source mappings; the front end only
 * sees `source`.
 */
export interface AnalysisRequest {
  readonly requestId: string;
  /** Latest-wins scope: a newer request in the same session supersedes older ones. */
  readonly sessionId: string;
  readonly projectId: string;
  /** Project/draft revision the source was prepared from (non-negative integer). */
  readonly revision: number;
  readonly passId: string;
  readonly stage: GlslStage;
  readonly profile: EsslProfile;
  readonly source: string;
}

export type AnalysisStatus =
  | 'ok'
  | 'invalid-source'
  | 'unsupported-profile'
  | 'unavailable'
  | 'cancelled';

/**
 * A 1-based location in the compiler's view of the prepared source.
 * `sourceString` is glslang's source-string number or `#line` name ("0" for an
 * unmodified single source). `byteColumn` is the compiler's UTF-8 byte column;
 * `column` is the 1-based UTF-16 column (Monaco's unit) when it can be derived
 * from `source` — it is null when a `#line` directive remaps lines or the
 * compiler reported no column. Neither is guaranteed to be the editable span of
 * macro-expanded or generated code; mapping to documents belongs to the adapter.
 */
export interface CompilerLocation {
  readonly sourceString: string;
  readonly line: number;
  readonly column: number | null;
  readonly byteColumn: number | null;
}

export interface AnalysisDiagnostic {
  readonly severity: 'error' | 'warning' | 'info';
  readonly phase: 'compile' | 'link';
  readonly message: string;
  /** The token glslang quoted, if any (may be empty). */
  readonly token: string | null;
  /** Null for diagnostics glslang does not attribute to a line (e.g. link errors). */
  readonly location: CompilerLocation | null;
}

export interface GlslTypeInfo {
  /** GLSL spelling including effective precision and array sizes, e.g. "highp vec3[4]". */
  readonly text: string;
  /** Unqualified, unsized type, e.g. "vec3", "mat2x3", "sampler2D" or a struct/block name. */
  readonly base: string;
  /** Effective precision after default-precision rules, not necessarily as written. */
  readonly precision: 'lowp' | 'mediump' | 'highp' | null;
  /** Outer to inner; null for an unsized dimension. */
  readonly arraySizes: readonly (number | null)[];
  readonly members?: readonly { readonly name: string; readonly type: GlslTypeInfo }[];
}

export type GlobalSymbolKind =
  | 'uniform'
  | 'uniform-block'
  | 'input'
  | 'output'
  | 'global'
  | 'const'
  | 'other';

export interface GlobalSymbol {
  /** Null for an anonymous uniform block; its members are then global names. */
  readonly name: string | null;
  readonly kind: GlobalSymbolKind;
  /** Storage qualifier as spelled for the profile/stage: uniform, attribute, varying, in, out, const or "". */
  readonly qualifier: string;
  readonly type: GlslTypeInfo;
  readonly layoutLocation: number | null;
  readonly invariant: boolean;
  /** Always null: glslang does not retain declaration locations for globals. */
  readonly declaration: null;
}

export interface FunctionParameter {
  readonly name: string | null;
  readonly qualifier: 'in' | 'out' | 'inout' | 'const in';
  readonly type: GlslTypeInfo;
}

export interface FunctionSymbol {
  readonly name: string;
  /** Display signature, e.g. "highp float foo(highp vec3 p, out float d)". */
  readonly signature: string;
  readonly returnType: GlslTypeInfo;
  readonly parameters: readonly FunctionParameter[];
  /** Number of definitions sharing `name` in this source (overloads). */
  readonly overloadCount: number;
  /** Compiler location glslang attaches to the definition; see SymbolLimits. */
  readonly definition: CompilerLocation | null;
}

export interface AnalysisSymbols {
  readonly globals: readonly GlobalSymbol[];
  readonly functions: readonly FunctionSymbol[];
  /** True when the per-reply symbol cap was reached. */
  readonly truncated: boolean;
}

export interface AnalysisCapabilities {
  readonly frontend: {
    readonly name: 'glslang';
    readonly version: string;
    readonly commit: string;
  };
  readonly profiles: readonly {
    readonly language: 'essl';
    readonly version: EsslVersion;
    readonly stages: readonly GlslStage[];
  }[];
  readonly spirv: false;
  readonly symbols: {
    /** Declared globals, uniforms, inputs/outputs, consts and uniform blocks. */
    readonly globals: true;
    /** Only defined (bodied) functions; prototypes and built-ins are excluded. */
    readonly userFunctions: 'definitions';
    readonly overloads: true;
    readonly locals: false;
    readonly references: false;
    readonly globalDeclarationLocations: false;
    readonly functionDefinitionLocations: 'compiler';
    /** Symbols are produced only by a successful analysis of the exact revision. */
    readonly incompleteSources: 'none';
  };
  readonly diagnostics: {
    readonly columns: 'utf16-when-derivable';
  };
  readonly limits: {
    readonly maxSourceBytes: number;
    readonly timeoutMs: number;
    readonly maxMemoryBytes: number;
  };
}

export type UnavailableReason =
  | 'load-failed'
  | 'timeout'
  | 'memory-limit'
  | 'input-limit'
  | 'queue-full'
  | 'invalid-request'
  | 'crashed';

export type CancelledReason = 'superseded' | 'cancelled' | 'disposed';

interface ReplyIdentity {
  readonly requestId: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly revision: number;
  readonly passId: string;
  readonly stage: GlslStage;
  readonly profile: EsslProfile;
}

export interface AnalysisTiming {
  /** Time the request waited before reaching the Worker. */
  readonly queuedMs: number;
  /** Synchronous front-end time measured inside the Worker. */
  readonly analysisMs: number;
  readonly totalMs: number;
}

export interface OkReply extends ReplyIdentity {
  readonly status: 'ok';
  /** Warnings only. */
  readonly diagnostics: readonly AnalysisDiagnostic[];
  /** Valid only for this exact revision. */
  readonly symbols: AnalysisSymbols;
  readonly capabilities: AnalysisCapabilities;
  readonly timing: AnalysisTiming;
}

export interface InvalidSourceReply extends ReplyIdentity {
  readonly status: 'invalid-source';
  readonly diagnostics: readonly AnalysisDiagnostic[];
  readonly symbols: null;
  readonly capabilities: AnalysisCapabilities;
  readonly timing: AnalysisTiming;
}

export interface UnsupportedProfileReply extends ReplyIdentity {
  readonly status: 'unsupported-profile';
  readonly message: string;
  /** What the source declared, when the front end got that far. */
  readonly detected: { readonly version: number; readonly profile: string } | null;
  readonly diagnostics: readonly AnalysisDiagnostic[];
  readonly symbols: null;
  readonly capabilities: AnalysisCapabilities;
}

export interface UnavailableReply extends ReplyIdentity {
  readonly status: 'unavailable';
  readonly reason: UnavailableReason;
  readonly message: string;
  readonly symbols: null;
  readonly capabilities: AnalysisCapabilities;
}

export interface CancelledReply extends ReplyIdentity {
  readonly status: 'cancelled';
  readonly reason: CancelledReason;
  readonly symbols: null;
  readonly capabilities: AnalysisCapabilities;
}

export type AnalysisReply =
  | OkReply
  | InvalidSourceReply
  | UnsupportedProfileReply
  | UnavailableReply
  | CancelledReply;
