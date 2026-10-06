import { describe, expect, it } from 'vitest';
import { checkRequest, echoIdentity } from './request';

const valid = {
  requestId: 'r1',
  sessionId: 's1',
  projectId: 'p1',
  revision: 3,
  passId: 'image',
  stage: 'fragment',
  profile: { language: 'essl', version: 300 },
  source: 'void main() {}',
};

describe('checkRequest', () => {
  it('accepts a well-formed request and measures UTF-8 bytes', () => {
    expect(checkRequest({ ...valid, source: 'é' }, 100)).toMatchObject({
      kind: 'valid',
      sourceBytes: 2,
    });
  });

  it.each([
    [null, 'request must be an object'],
    [{ ...valid, requestId: '' }, 'requestId must not be empty'],
    [{ ...valid, sessionId: 4 }, 'sessionId must be a string'],
    [{ ...valid, revision: -1 }, 'revision must be a non-negative safe integer'],
    [{ ...valid, revision: 1.5 }, 'revision must be a non-negative safe integer'],
    [{ ...valid, stage: 'compute' }, 'stage must be "vertex" or "fragment"'],
    [{ ...valid, source: undefined }, 'source must be a string'],
    [
      { ...valid, profile: { language: 'glsl', version: 300 } },
      'profile must be { language: "essl", version: number }',
    ],
    [{ ...valid, passId: 'x'.repeat(300) }, 'passId exceeds 256 characters'],
  ])('rejects %j', (input, issue) => {
    const check = checkRequest(input, 100);
    expect(check.kind).toBe('invalid');
    expect(check.kind === 'invalid' && check.issues).toContain(issue);
  });

  it('separates unsupported versions from malformed input', () => {
    expect(
      checkRequest({ ...valid, profile: { language: 'essl', version: 310 } }, 100),
    ).toMatchObject({
      kind: 'unsupported-profile',
    });
  });

  it('enforces the source byte limit', () => {
    expect(checkRequest({ ...valid, source: '😀'.repeat(30) }, 100)).toEqual({
      kind: 'too-large',
      sourceBytes: 120,
    });
  });
});

describe('echoIdentity', () => {
  it('echoes only well-typed identity fields', () => {
    expect(echoIdentity({ requestId: 'r', revision: 'x', stage: 'vertex' })).toEqual({
      requestId: 'r',
      sessionId: '',
      projectId: '',
      revision: -1,
      passId: '',
      stage: 'vertex',
      profile: { language: 'essl', version: 100 },
    });
  });
});
