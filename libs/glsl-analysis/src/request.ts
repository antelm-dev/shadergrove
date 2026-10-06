import type { AnalysisRequest, EsslProfile, GlslStage } from './contract';

const MAX_ID_LENGTH = 256;

export type RequestCheck =
  | { readonly kind: 'valid'; readonly request: AnalysisRequest; readonly sourceBytes: number }
  | { readonly kind: 'invalid'; readonly issues: readonly string[] }
  | { readonly kind: 'unsupported-profile'; readonly message: string }
  | { readonly kind: 'too-large'; readonly sourceBytes: number };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

function idIssue(name: string, value: unknown, allowEmpty = false): string | null {
  if (typeof value !== 'string') return `${name} must be a string`;
  if (!allowEmpty && value.length === 0) return `${name} must not be empty`;
  if (value.length > MAX_ID_LENGTH) return `${name} exceeds ${MAX_ID_LENGTH} characters`;
  return null;
}

/** Validates untrusted input at the boundary; nothing malformed reaches the Worker. */
export function checkRequest(value: unknown, maxSourceBytes: number): RequestCheck {
  if (!isRecord(value)) return { kind: 'invalid', issues: ['request must be an object'] };
  const issues = [
    idIssue('requestId', value['requestId']),
    idIssue('sessionId', value['sessionId']),
    idIssue('projectId', value['projectId'], true),
    idIssue('passId', value['passId'], true),
  ].filter((issue): issue is string => issue !== null);
  const revision = value['revision'];
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    issues.push('revision must be a non-negative safe integer');
  }
  const stage = value['stage'];
  if (stage !== 'vertex' && stage !== 'fragment')
    issues.push('stage must be "vertex" or "fragment"');
  const source = value['source'];
  if (typeof source !== 'string') issues.push('source must be a string');
  const profile = value['profile'];
  if (
    !isRecord(profile) ||
    profile['language'] !== 'essl' ||
    typeof profile['version'] !== 'number'
  ) {
    issues.push('profile must be { language: "essl", version: number }');
  }
  if (issues.length) return { kind: 'invalid', issues };

  const version = (profile as Record<string, unknown>)['version'];
  if (version !== 100 && version !== 300) {
    return {
      kind: 'unsupported-profile',
      message: `ESSL ${String(version)} is not supported; use 100 or 300.`,
    };
  }
  const sourceBytes = new TextEncoder().encode(source as string).length;
  if (sourceBytes > maxSourceBytes) return { kind: 'too-large', sourceBytes };

  const request: AnalysisRequest = {
    requestId: value['requestId'] as string,
    sessionId: value['sessionId'] as string,
    projectId: value['projectId'] as string,
    revision: revision as number,
    passId: value['passId'] as string,
    stage: stage as GlslStage,
    profile: { language: 'essl', version } as EsslProfile,
    source: source as string,
  };
  return { kind: 'valid', request, sourceBytes };
}

/** Best-effort identity echo for replies to requests that failed validation. */
export function echoIdentity(value: unknown): Omit<AnalysisRequest, 'source'> {
  const record = isRecord(value) ? value : {};
  const text = (key: string) => (typeof record[key] === 'string' ? (record[key] as string) : '');
  const revision = record['revision'];
  const profile = isRecord(record['profile']) ? record['profile'] : {};
  return {
    requestId: text('requestId'),
    sessionId: text('sessionId'),
    projectId: text('projectId'),
    revision: typeof revision === 'number' ? revision : -1,
    passId: text('passId'),
    stage: record['stage'] === 'vertex' ? 'vertex' : 'fragment',
    profile: { language: 'essl', version: profile['version'] === 300 ? 300 : 100 },
  };
}
