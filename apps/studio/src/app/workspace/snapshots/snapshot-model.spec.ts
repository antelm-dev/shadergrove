import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CHANNELS,
  DEFAULT_RENDER,
  type ShaderControl,
  type ShaderParams,
} from '@shadergrove/shared/model';
import { migrateLegacyProject, type ShaderProject } from '@shadergrove/shared/project';
import { controlsToText } from '../controls-text';
import type { ShaderDraft } from '../state/document-state';
import {
  differs,
  needsSafetySnapshot,
  planRestore,
  type SessionSnapshot,
  type SnapshotSubject,
} from './snapshot-model';

const CONTROLS: ShaderControl[] = [
  { key: 'speed', type: 'number', default: 1, min: 0, max: 10 },
  { key: 'glow', type: 'boolean', default: false },
];

// Pass ids are generated, so one project per source keeps equal drafts equal.
const projects = new Map<string, ShaderProject>();

function draft(fragment = 'void main() {}'): ShaderDraft {
  if (!projects.has(fragment)) {
    projects.set(fragment, migrateLegacyProject(fragment, 'void main() {}'));
  }
  return {
    project: structuredClone(projects.get(fragment) as ShaderProject),
    controlsText: controlsToText(CONTROLS),
    render: structuredClone(DEFAULT_RENDER),
  };
}

function snapshot(subject: SnapshotSubject): SessionSnapshot {
  return {
    id: 'snapshot-1',
    shaderId: 'waves',
    createdAt: 0,
    revision: 1,
    draft: subject.draft,
    params: subject.params,
    channels: DEFAULT_CHANNELS,
    frame: new Blob(),
    thumbnailUrl: 'blob:thumb',
  };
}

describe('planRestore', () => {
  it('clamps values the snapshot controls no longer allow, and fills missing ones with defaults', () => {
    const plan = planRestore(snapshot({ draft: draft(), params: { speed: 50, stale: 3 } }), {
      draft: draft(),
      params: {},
      controls: [],
    });

    expect(plan.params).toEqual({ speed: 10, glow: false });
  });

  it('falls back to the live controls when the snapshot config does not parse', () => {
    const broken = { ...draft(), controlsText: '{ not json' };
    const plan = planRestore(snapshot({ draft: broken, params: { speed: -4 } }), {
      draft: draft(),
      params: {},
      controls: [{ key: 'speed', type: 'number', default: 2, min: 1, max: 3 }],
    });

    expect(plan.params).toEqual({ speed: 1 });
    expect(plan.draftPatch.controlsText).toBe('{ not json');
  });

  it('returns a mutable copy of the draft, never the frozen original', () => {
    const held = Object.freeze(draft('void main() { /* old */ }'));
    const plan = planRestore(snapshot({ draft: held, params: {} }), {
      draft: draft(),
      params: {},
      controls: CONTROLS,
    });

    expect(plan.draftPatch).toEqual(held);
    expect(plan.draftPatch).not.toBe(held);
    expect(plan.draftPatch.project).not.toBe(held.project);
    expect(Object.isFrozen(plan.draftPatch)).toBe(false);
  });
});

describe('differs', () => {
  const params: ShaderParams = { speed: 2, glow: true };

  it('is false for an identical state, whatever the params key order', () => {
    const held = snapshot({ draft: draft(), params });
    expect(differs(held, { draft: draft(), params: { glow: true, speed: 2 } })).toBe(false);
  });

  it('notices a change to the source, the controls, the render or any value', () => {
    const held = snapshot({ draft: draft(), params });
    const render = structuredClone(DEFAULT_RENDER);
    render.postProcessing.enabled = !render.postProcessing.enabled;

    expect(differs(held, { draft: draft('void main() { }'), params })).toBe(true);
    expect(differs(held, { draft: { ...draft(), controlsText: '[]' }, params })).toBe(true);
    expect(differs(held, { draft: { ...draft(), render }, params })).toBe(true);
    expect(differs(held, { draft: draft(), params: { speed: 3, glow: true } })).toBe(true);
    expect(differs(held, { draft: draft(), params: { speed: 2 } })).toBe(true);
    expect(differs(held, { draft: draft(), params: { speed: 2, glow: true, extra: 1 } })).toBe(
      true,
    );
  });
});

describe('needsSafetySnapshot', () => {
  const live = { draft: draft(), params: { speed: 1 } };

  it('asks for one when no snapshot holds the live state', () => {
    expect(needsSafetySnapshot(live, [])).toBe(true);
    expect(needsSafetySnapshot(live, [{ draft: draft(), params: { speed: 2 } }])).toBe(true);
  });

  it('does not when some snapshot already holds it', () => {
    expect(
      needsSafetySnapshot(live, [
        { draft: draft('void main() { }'), params: { speed: 1 } },
        { draft: draft(), params: { speed: 1 } },
      ]),
    ).toBe(false);
  });
});
