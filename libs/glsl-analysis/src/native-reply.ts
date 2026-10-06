import type {
  AnalysisDiagnostic,
  AnalysisSymbols,
  CompilerLocation,
  EsslVersion,
  FunctionParameter,
  FunctionSymbol,
  GlobalSymbol,
  GlobalSymbolKind,
  GlslStage,
  GlslTypeInfo,
} from './contract';
import { MAX_DIAGNOSTICS, parseInfoLog, SourceLines } from './diagnostics';

/** JSON produced by `gla_analyze` in native/glsl_analysis.cpp. */
export interface NativeReply {
  parsed: boolean;
  linked: boolean;
  version: number;
  profile: string;
  infoLog: string;
  linkLog?: string;
  globals?: NativeGlobal[];
  functions?: NativeFunction[];
  symbolsTruncated?: boolean;
}

interface NativeLocation {
  string: string;
  line: number;
  column: number;
}

interface NativeType {
  text: string;
  base: string;
  precision: GlslTypeInfo['precision'];
  arraySizes: (number | null)[];
  members?: { name: string; type: NativeType }[];
}

interface NativeGlobal {
  name: string;
  storage: string;
  block: boolean;
  anonymous: boolean;
  layoutLocation: number | null;
  invariant: boolean;
  type: NativeType;
}

interface NativeFunction {
  name: string;
  mangledName: string;
  returnType: NativeType;
  parameters: { name: string | null; qualifier: string; type: NativeType }[];
  location: NativeLocation | null;
}

export interface AnalysisJob {
  readonly requestId: string;
  readonly stage: GlslStage;
  readonly version: EsslVersion;
  readonly source: string;
}

export type JobOutcome =
  | {
      readonly status: 'ok';
      readonly diagnostics: AnalysisDiagnostic[];
      readonly symbols: AnalysisSymbols;
    }
  | { readonly status: 'invalid-source'; readonly diagnostics: AnalysisDiagnostic[] }
  | {
      readonly status: 'unsupported-profile';
      readonly message: string;
      readonly detected: { version: number; profile: string };
      readonly diagnostics: AnalysisDiagnostic[];
    };

function toType(type: NativeType): GlslTypeInfo {
  return {
    text: type.text,
    base: type.base,
    precision: type.precision,
    arraySizes: type.arraySizes,
    ...(type.members
      ? {
          members: type.members.map((member) => ({ name: member.name, type: toType(member.type) })),
        }
      : {}),
  };
}

function globalKind(global: NativeGlobal): GlobalSymbolKind {
  switch (global.storage) {
    case 'uniform':
      return global.block ? 'uniform-block' : 'uniform';
    case 'in':
      return 'input';
    case 'out':
      return 'output';
    case 'global':
      return 'global';
    case 'const':
      return 'const';
    default:
      return 'other';
  }
}

/** The qualifier a user wrote for this kind in ESSL 1.00 or 3.00. */
function qualifierText(kind: GlobalSymbolKind, storage: string, job: AnalysisJob): string {
  if (job.version === 100) {
    if (kind === 'input') return job.stage === 'vertex' ? 'attribute' : 'varying';
    if (kind === 'output') return 'varying';
  }
  switch (kind) {
    case 'uniform':
    case 'uniform-block':
      return 'uniform';
    case 'input':
      return 'in';
    case 'output':
      return 'out';
    case 'const':
      return 'const';
    case 'global':
      return '';
    default:
      return storage;
  }
}

function toGlobal(global: NativeGlobal, job: AnalysisJob): GlobalSymbol {
  const kind = globalKind(global);
  return {
    name: global.anonymous ? null : global.name,
    kind,
    qualifier: qualifierText(kind, global.storage, job),
    type: toType(global.type),
    layoutLocation: global.layoutLocation,
    invariant: global.invariant,
    declaration: null,
  };
}

const PARAMETER_QUALIFIERS = new Set(['in', 'out', 'inout', 'const in']);

function toFunctions(functions: NativeFunction[], lines: SourceLines): FunctionSymbol[] {
  const counts = new Map<string, number>();
  for (const fn of functions) counts.set(fn.name, (counts.get(fn.name) ?? 0) + 1);
  return functions.map((fn) => {
    const parameters: FunctionParameter[] = fn.parameters.map((parameter) => ({
      name: parameter.name,
      qualifier: (PARAMETER_QUALIFIERS.has(parameter.qualifier)
        ? parameter.qualifier
        : 'in') as FunctionParameter['qualifier'],
      type: toType(parameter.type),
    }));
    const parameterText = parameters
      .map((parameter) =>
        [
          parameter.qualifier === 'in' ? '' : parameter.qualifier,
          parameter.type.text,
          parameter.name,
        ]
          .filter(Boolean)
          .join(' '),
      )
      .join(', ');
    const definition: CompilerLocation | null = fn.location
      ? lines.location(fn.location.string, fn.location.line, fn.location.column || null)
      : null;
    return {
      name: fn.name,
      signature: `${fn.returnType.text} ${fn.name}(${parameterText})`,
      returnType: toType(fn.returnType),
      parameters,
      overloadCount: counts.get(fn.name) ?? 1,
      definition,
    };
  });
}

function describeProfile(version: number, profile: string): string {
  if (profile === 'es') return version === 100 ? 'ESSL 1.00' : `#version ${version} es`;
  if (profile === 'none' || profile === 'core') return `#version ${version}`;
  return `#version ${version} ${profile}`;
}

/**
 * Turns the native reply into a status. Only a source that both parses and
 * links under the requested ESSL profile yields symbols; anything else carries
 * diagnostics only, so stale or partial symbols can never look current.
 */
export function interpretNativeReply(reply: NativeReply, job: AnalysisJob): JobOutcome {
  const lines = new SourceLines(job.source);
  const compile = parseInfoLog(reply.infoLog, 'compile', lines);
  const link = parseInfoLog(reply.linkLog ?? '', 'link', lines);
  const diagnostics = [...compile.diagnostics, ...link.diagnostics].slice(0, MAX_DIAGNOSTICS);

  const detected = { version: reply.version, profile: reply.profile };
  const supported = reply.profile === 'es' && (reply.version === 100 || reply.version === 300);
  if (!supported) {
    return {
      status: 'unsupported-profile',
      message: `Source declares ${describeProfile(reply.version, reply.profile)}; only ESSL 1.00 and 3.00 es are analysed.`,
      detected,
      diagnostics,
    };
  }
  if (reply.version !== job.version) {
    return {
      status: 'unsupported-profile',
      message: `Source declares ${describeProfile(reply.version, reply.profile)} but the request specified ESSL ${job.version === 100 ? '1.00' : '3.00'}.`,
      detected,
      diagnostics,
    };
  }
  if (!reply.parsed || !reply.linked) {
    return { status: 'invalid-source', diagnostics };
  }
  return {
    status: 'ok',
    diagnostics,
    symbols: {
      globals: (reply.globals ?? []).map((global) => toGlobal(global, job)),
      functions: toFunctions(reply.functions ?? [], lines),
      truncated: Boolean(reply.symbolsTruncated),
    },
  };
}
