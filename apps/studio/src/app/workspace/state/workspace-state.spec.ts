import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_CHANNELS,
  DEFAULT_RENDER,
  type ShaderControl,
  type ShaderRecord,
} from '@shadergrove/shared/model';
import {
  bufferPasses,
  commonPass,
  findPass,
  imagePass,
  migrateLegacyProject,
  type ShaderProject,
} from '@shadergrove/shared/project';
import { CONFIG_DOC, VERTEX_DOC } from '@shadergrove/shared/diagnostic';
import { CompilationService } from '../compilation.service';
import { planCommit } from '../../ui/editor/controls-builder-state';
import { DocumentState, type ShaderDraft } from './document-state';
import { ProjectMutations } from './project-mutations';

/**
 * The two owners behind `ShaderStore`, tested directly.
 *
 * `shader-store.spec.ts` and `project-workspace.spec.ts` still pin the facade's
 * behaviour end to end; what is worth saying here is the thing those suites can
 * only say obliquely — that a semantic transition leaves the four layers
 * consistent, and that one logical mutation is exactly one revision bump.
 */

const FRAGMENT = 'void main() { gl_FragColor = vec4(1.0); }';
const VERTEX = 'void main() { gl_Position = vec4(position, 1.0); }';

const CONTROLS: ShaderControl[] = [
  { key: 'speed', type: 'number', default: 1, min: 0, max: 10 },
  { key: 'glow', type: 'boolean', default: false },
];

function makeRecord(overrides: Partial<ShaderRecord> = {}): ShaderRecord {
  return {
    id: 'waves',
    kind: 'shader',
    name: 'Waves',
    description: '',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    revision: 1,
    controls: structuredClone(CONTROLS),
    render: structuredClone(DEFAULT_RENDER),
    channels: structuredClone(DEFAULT_CHANNELS),
    thumbnail: null,
    fragment: FRAGMENT,
    vertex: VERTEX,
    presets: [],
    project: migrateLegacyProject(FRAGMENT, VERTEX),
    ...overrides,
  };
}

describe('DocumentState', () => {
  let state: DocumentState;
  let compilation: CompilationService;
  let record: ShaderRecord;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    state = TestBed.inject(DocumentState);
    compilation = TestBed.inject(CompilationService);
    record = makeRecord();
  });

  describe('adopt', () => {
    beforeEach(() => state.adopt(record, structuredClone(record.project)));

    it('lands the record, the draft, the params and the open tab together', () => {
      expect(state.record()).toEqual(record);
      expect(state.fragment()).toBe(FRAGMENT);
      expect(state.vertex()).toBe(VERTEX);
      expect(state.params()).toEqual({ speed: 1, glow: false });
      expect(state.activeDocId()).toBe(imagePass(record.project).id);
      expect(state.activePresetId()).toBeNull();
      expect(state.diagnostics()).toEqual([]);
    });

    it('is not dirty, because the baseline is the project it just adopted', () => {
      expect(state.dirty()).toBe(false);
    });

    it('keeps the baseline out of reach of later edits', () => {
      const before = JSON.stringify(state.savedProject());
      state.patchDraft({ project: { ...state.project()!, vertex: 'NEW' } });

      expect(JSON.stringify(state.savedProject())).toBe(before);
      expect(state.dirty()).toBe(true);
    });

    it('leaves the compile revision alone — that is the caller`s call', () => {
      compilation.draftRevision.set(7);
      state.adopt(record, structuredClone(record.project));

      expect(compilation.draftRevision()).toBe(7);
    });
  });

  describe('patchDraft', () => {
    beforeEach(() => state.adopt(record, structuredClone(record.project)));

    it('bumps the revision exactly once', () => {
      const before = compilation.draftRevision();
      state.patchDraft({ controlsText: '[]' });

      expect(compilation.draftRevision()).toBe(before + 1);
      expect(state.draft()?.controlsText).toBe('[]');
    });

    it('refuses, and does not bump, with no document open', () => {
      state.clearWorkspace();
      const before = compilation.draftRevision();

      expect(state.patchDraft({ controlsText: '[]' })).toBe(false);
      expect(compilation.draftRevision()).toBe(before);
    });
  });

  it('commitSaved makes the draft the new baseline', () => {
    state.adopt(record, structuredClone(record.project));
    state.patchDraft({ controlsText: '[]' });
    expect(state.dirty()).toBe(true);

    const saved = makeRecord({ controls: [], revision: 2 });
    const draft: ShaderDraft = {
      project: structuredClone(state.project()!),
      controlsText: JSON.stringify([], null, 2),
      render: structuredClone(saved.render),
    };
    state.commitSaved(saved, draft, {}, 'sunset');

    expect(state.dirty()).toBe(false);
    expect(state.params()).toEqual({});
    expect(state.activePresetId()).toBe('sunset');
  });

  it('commitMigratedProject moves the baseline without disturbing what is being typed', () => {
    state.adopt(record, structuredClone(record.project));
    state.patchDraft({ controlsText: 'half-typed' });

    const migrated: ShaderProject = structuredClone(state.project()!);
    state.commitMigratedProject(makeRecord({ revision: 2 }), migrated);

    expect(state.draft()?.controlsText).toBe('half-typed');
    expect(JSON.stringify(state.savedProject())).toBe(JSON.stringify(migrated));
  });

  it('clearWorkspace empties every layer at once', () => {
    state.adopt(record, structuredClone(record.project));
    state.clearWorkspace();

    expect(state.record()).toBeNull();
    expect(state.draft()).toBeNull();
    expect(state.savedProject()).toBeNull();
    expect(state.params()).toEqual({});
    expect(state.project()).toBeNull();
    expect(state.documents()).toEqual([]);
    expect(state.dirty()).toBe(false);
  });

  it('restoreDraft replaces the draft without bumping the revision', () => {
    state.adopt(record, structuredClone(record.project));
    const before = compilation.draftRevision();

    const recovered: ShaderDraft = {
      project: structuredClone(record.project),
      controlsText: '[]',
      render: structuredClone(record.render),
    };
    state.restoreDraft(recovered);
    recovered.project.vertex = 'MUTATED AFTERWARDS';

    expect(compilation.draftRevision()).toBe(before);
    expect(state.vertex()).toBe(VERTEX);
  });

  describe('diagnostics', () => {
    beforeEach(() => state.adopt(record, structuredClone(record.project)));

    it('keeps the two sources independent', () => {
      state.setConfigDiagnostics(['bad config']);
      state.setCompileDiagnostics([
        { severity: 'error', line: 3, message: 'boom', source: 'fragment' },
      ]);

      expect(state.diagnostics().map((entry) => entry.message)).toEqual(['bad config', 'boom']);

      state.setCompileDiagnostics([]);
      expect(state.diagnostics().map((entry) => entry.message)).toEqual(['bad config']);

      state.setConfigDiagnostics([]);
      expect(state.diagnostics()).toEqual([]);
    });

    it('reports one error once, however many passes complained about it', () => {
      const same = {
        severity: 'error',
        line: 3,
        message: 'undefined identifier',
        source: 'fragment',
        docId: commonPass(state.project()!)!.id,
      } as const;
      state.setCompileDiagnostics([same, { ...same }, { ...same }]);

      expect(state.allDiagnostics()).toHaveLength(1);
      expect(state.hasErrors()).toBe(true);
      expect(state.errorCountFor(same.docId)).toBe(1);
    });
  });

  describe('documents', () => {
    beforeEach(() => state.adopt(record, structuredClone(record.project)));

    it('always offers the vertex and config tabs last', () => {
      const ids = state.documents().map((document) => document.id);
      expect(ids.slice(-2)).toEqual([VERTEX_DOC, CONFIG_DOC]);
    });

    it('falls back to the first document when the open one is gone', () => {
      state.selectDocument('deleted-tab');
      expect(state.activeDoc()?.id).toBe(imagePass(state.project()!).id);
    });

    it('cycles both ways, wrapping', () => {
      const ids = state.documents().map((document) => document.id);
      state.selectDocument(ids[0]);

      state.cycleDocument(-1);
      expect(state.activeDocId()).toBe(ids.at(-1));

      state.cycleDocument(1);
      expect(state.activeDocId()).toBe(ids[0]);
    });

    it('cycles from the fallback, not from nothing, when no tab is chosen', () => {
      state.activeDocId.set(null);
      state.cycleDocument(1);

      expect(state.activeDocId()).toBe(state.documents()[1].id);
    });
  });
});

describe('ProjectMutations', () => {
  let state: DocumentState;
  let mutations: ProjectMutations;
  let compilation: CompilationService;
  let record: ShaderRecord;

  /** How many times the revision moved while `act` ran. */
  function bumps(act: () => void): number {
    const before = compilation.draftRevision();
    act();
    return compilation.draftRevision() - before;
  }

  beforeEach(() => {
    TestBed.configureTestingModule({});
    state = TestBed.inject(DocumentState);
    mutations = TestBed.inject(ProjectMutations);
    compilation = TestBed.inject(CompilationService);
    record = makeRecord();
    state.adopt(record, structuredClone(record.project));
    compilation.reset();
  });

  describe('sources', () => {
    it('routes a document id to the right place, once', () => {
      const common = commonPass(state.project()!)!;

      expect(bumps(() => mutations.setDocSource(common.id, '#define PI 3.14'))).toBe(1);
      expect(findPass(state.project()!, common.id)?.source).toBe('#define PI 3.14');

      expect(bumps(() => mutations.setDocSource(VERTEX_DOC, 'NEW VERTEX'))).toBe(1);
      expect(state.vertex()).toBe('NEW VERTEX');

      expect(bumps(() => mutations.setDocSource(CONFIG_DOC, '[]'))).toBe(1);
      expect(state.draft()?.controlsText).toBe('[]');
    });

    it('ignores an id that is not a document at all', () => {
      const before = JSON.stringify(state.draft());
      expect(bumps(() => mutations.setDocSource('nope', 'x'))).toBe(0);
      expect(JSON.stringify(state.draft())).toBe(before);
    });

    it('writes the Image pass through setFragment', () => {
      mutations.setFragment('IMAGE');
      expect(state.fragment()).toBe('IMAGE');
    });

    it('does nothing at all with no document open', () => {
      state.clearWorkspace();
      expect(bumps(() => mutations.setFragment('IMAGE'))).toBe(0);
      expect(bumps(() => mutations.setVertex('VERTEX'))).toBe(0);
      expect(bumps(() => mutations.addBufferPass())).toBe(0);
    });
  });

  describe('passes and files', () => {
    it('opens the buffer it just created', () => {
      expect(bumps(() => mutations.addBufferPass())).toBe(1);
      expect(state.activeDocId()).toBe(bufferPasses(state.project()!).at(-1)?.id);
    });

    it('refuses a fifth buffer with a notice rather than a silent no-op', () => {
      for (let n = 0; n < 4; n++) mutations.addBufferPass();
      expect(state.canAddBuffer()).toBe(false);

      expect(bumps(() => mutations.addBufferPass())).toBe(0);
      expect(state.notice()).toEqual({ text: 'All four buffer slots are in use', error: true });
    });

    it('opens the copy a duplicate produced', () => {
      mutations.addBufferPass();
      const original = bufferPasses(state.project()!).at(-1)!;

      mutations.duplicateBufferPass(original.id);
      const copy = bufferPasses(state.project()!).find((pass) => pass.id !== original.id);

      expect(copy).toBeDefined();
      expect(state.activeDocId()).toBe(copy?.id);
      expect(copy?.source).toBe(original.source);
    });

    it('falls back to the Image tab when the open one is removed', () => {
      mutations.addBufferPass();
      const buffer = bufferPasses(state.project()!).at(-1)!;

      mutations.removeBufferPass(buffer.id);

      expect(state.activeDocId()).toBe(imagePass(state.project()!).id);
      expect(bufferPasses(state.project()!)).toHaveLength(0);
    });

    it('leaves the open tab alone when some other pass is removed', () => {
      mutations.addBufferPass();
      const buffer = bufferPasses(state.project()!).at(-1)!;
      const common = commonPass(state.project()!)!;
      state.selectDocument(common.id);

      mutations.removeBufferPass(buffer.id);
      expect(state.activeDocId()).toBe(common.id);
    });

    it('opens a new file, and falls back when it is removed', () => {
      expect(bumps(() => mutations.addSourceFile('noise.glsl'))).toBe(1);
      const file = state.project()!.files.at(-1)!;
      expect(state.activeDocId()).toBe(file.id);

      mutations.removeSourceFile(file.id);
      expect(state.activeDocId()).toBe(imagePass(state.project()!).id);
    });

    it('counts a rename, a move and a rewire as one edit each', () => {
      mutations.addBufferPass();
      const buffer = bufferPasses(state.project()!).at(-1)!;

      expect(bumps(() => mutations.renamePassById(buffer.id, 'Feedback'))).toBe(1);
      expect(bumps(() => mutations.setPassEnabledById(buffer.id, false))).toBe(1);
      expect(bumps(() => mutations.setPassResolutionById(buffer.id, { mode: 'fixed' }))).toBe(1);
      expect(bumps(() => mutations.setPassSamplingById(buffer.id, { filter: 'nearest' }))).toBe(1);
      expect(
        bumps(() =>
          mutations.setChannel(imagePass(state.project()!).id, 0, {
            kind: 'buffer',
            passId: buffer.id,
            feedback: false,
          }),
        ),
      ).toBe(1);

      const updated = findPass(state.project()!, buffer.id)!;
      expect(updated.name).toBe('Feedback');
      expect(updated.enabled).toBe(false);
      expect(updated.filter).toBe('nearest');
    });
  });

  describe('the config schema', () => {
    it('re-projects the live params onto a schema that parses', () => {
      mutations.setParam('speed', 4);

      mutations.setControlsText(
        JSON.stringify([{ key: 'speed', type: 'number', default: 1, min: 0, max: 10 }], null, 2),
      );

      expect(state.params()).toEqual({ speed: 4 });
      expect(state.diagnostics()).toEqual([]);
      expect(state.configValid()).toBe(true);
    });

    it('reports a broken schema without tearing down the control panel', () => {
      expect(bumps(() => mutations.setControlsText('{ not json'))).toBe(1);

      expect(state.configValid()).toBe(false);
      expect(state.diagnostics().map((entry) => entry.source)).toEqual(['config']);
      // The last known-good schema, off the record: a half-typed config must not
      // take the knobs with it.
      expect(state.controls()).toEqual(CONTROLS);
    });

    it('clears the complaint once the schema parses again', () => {
      mutations.setControlsText('{ not json');
      mutations.setControlsText('[]');

      expect(state.diagnostics()).toEqual([]);
      expect(state.controls()).toEqual([]);
    });

    it('leaves compile diagnostics alone while the config churns', () => {
      state.setCompileDiagnostics([
        { severity: 'error', line: 1, message: 'boom', source: 'fragment' },
      ]);
      mutations.setControlsText('{ not json');
      mutations.setControlsText('[]');

      expect(state.diagnostics().map((entry) => entry.message)).toEqual(['boom']);
    });
  });

  describe('commits from the config builder', () => {
    const NEXT: ShaderControl[] = [
      { key: 'speed', type: 'number', default: 1, min: 0, max: 2 },
      { key: 'tint', type: 'color', default: '#336699' },
    ];

    /** What the builder does: plan against the buffer text, write through the store's path. */
    function commit(next: readonly ShaderControl[]): void {
      const plan = planCommit(state.draft()!.controlsText, next);
      if (plan.status === 'commit') mutations.setDocSource(CONFIG_DOC, plan.text);
    }

    it('is one revision, and keeps compatible live values while the schema changes shape', () => {
      mutations.setParam('speed', 9);
      mutations.setParam('glow', true);

      expect(bumps(() => commit(NEXT))).toBe(1);

      // speed survives and is clamped into its new range; glow is gone; tint starts at its default.
      expect(state.params()).toEqual({ speed: 2, tint: '#336699' });
      expect(state.controls()).toEqual(NEXT);
      expect(state.dirty()).toBe(true);
    });

    it('keeps a live value inside the range it was applied against', () => {
      mutations.setParam('speed', 0.5);
      commit(NEXT);
      expect(state.params()['speed']).toBe(0.5);
    });

    it('previews a value without touching the schema, its defaults or the revision', () => {
      const text = state.draft()!.controlsText;

      expect(bumps(() => mutations.setParam('speed', 7))).toBe(0);

      expect(state.params()['speed']).toBe(7);
      expect(state.draft()!.controlsText).toBe(text);
      expect(state.controls()[0]).toMatchObject({ key: 'speed', default: 1 });
      expect(state.dirty()).toBe(false);
    });

    it('resets to the applied defaults', () => {
      commit(NEXT);
      mutations.setParam('speed', 1.5);
      mutations.resetParams();
      expect(state.params()).toEqual({ speed: 1, tint: '#336699' });
    });

    it('writes nothing for a proposal equal to the buffer', () => {
      expect(bumps(() => commit(structuredClone(CONTROLS)))).toBe(0);
      expect(planCommit(state.draft()!.controlsText, state.controls()).status).toBe('noop');
    });

    it('cannot be fooled by the fallback schema over invalid JSON', () => {
      mutations.setControlsText('{ not json');
      const broken = state.draft()!.controlsText;
      const revision = compilation.draftRevision();

      // The store still reports the last good schema ...
      expect(state.controls()).toEqual(CONTROLS);
      expect(state.configValid()).toBe(false);
      // ... which is exactly what the builder must not write back over the buffer.
      expect(planCommit(broken, state.controls())).toEqual({ status: 'blocked' });
      commit(NEXT);

      expect(state.draft()!.controlsText).toBe(broken);
      expect(compilation.draftRevision()).toBe(revision);
    });
  });

  describe('params', () => {
    it('detaches from the preset the values came from', () => {
      state.activePresetId.set('sunset');
      mutations.setParam('speed', 3);

      expect(state.params()['speed']).toBe(3);
      expect(state.activePresetId()).toBeNull();
    });

    it('resets to the schema defaults, not to the record', () => {
      mutations.setParam('speed', 3);
      mutations.resetParams();

      expect(state.params()).toEqual({ speed: 1, glow: false });
      expect(state.activePresetId()).toBeNull();
    });

    it('validates a batch per key rather than failing the lot', () => {
      const outcome = mutations.setParamsValidated({ speed: 2, glow: 'yes', nope: 1 });

      expect(outcome.applied).toEqual(['speed']);
      expect(Object.keys(outcome.errors).sort()).toEqual(['glow', 'nope']);
      expect(state.params()['speed']).toBe(2);
    });

    it('does not touch the draft revision', () => {
      expect(bumps(() => mutations.setParam('speed', 3))).toBe(0);
      expect(bumps(() => mutations.resetParams())).toBe(0);
    });
  });

  describe('applyTextEdits', () => {
    it('applies edits across several documents in one revision', () => {
      const image = imagePass(state.project()!);
      const common = commonPass(state.project()!)!;
      const base = compilation.draftRevision();

      const result = mutations.applyTextEdits(base, [
        { documentId: image.id, start: 0, end: image.source.length, text: 'IMAGE' },
        { documentId: common.id, start: 0, end: common.source.length, text: 'COMMON' },
        { documentId: VERTEX_DOC, start: 0, end: VERTEX.length, text: 'VERTEX' },
      ]);

      expect(result.status).toBe('applied');
      expect(compilation.draftRevision()).toBe(base + 1);
      expect(state.fragment()).toBe('IMAGE');
      expect(findPass(state.project()!, common.id)?.source).toBe('COMMON');
      expect(state.vertex()).toBe('VERTEX');
    });

    it('bumps once even when the batch touches the config too', () => {
      const image = imagePass(state.project()!);
      const base = compilation.draftRevision();
      const controlsText = state.draft()!.controlsText;

      mutations.applyTextEdits(base, [
        { documentId: image.id, start: 0, end: image.source.length, text: 'IMAGE' },
        { documentId: CONFIG_DOC, start: 0, end: controlsText.length, text: '[]' },
      ]);

      expect(compilation.draftRevision()).toBe(base + 1);
      expect(state.controls()).toEqual([]);
      expect(state.params()).toEqual({});
    });

    it('rejects a stale base revision before touching anything', () => {
      mutations.setFragment('EDITED BY SOMEONE ELSE');
      const current = compilation.draftRevision();

      const result = mutations.applyTextEdits(current - 1, [
        { documentId: imagePass(state.project()!).id, start: 0, end: 0, text: 'x' },
      ]);

      expect(result).toEqual({
        status: 'failed',
        failure: {
          ok: false,
          code: 'STALE_REVISION',
          message: `baseRevision ${current - 1} is stale; the draft is at revision ${current}.`,
          currentRevision: current,
        },
      });
      expect(state.fragment()).toBe('EDITED BY SOMEONE ELSE');
      expect(compilation.draftRevision()).toBe(current);
    });

    it('applies none of a batch whose last edit is invalid', () => {
      const image = imagePass(state.project()!);
      const base = compilation.draftRevision();

      const result = mutations.applyTextEdits(base, [
        { documentId: image.id, start: 0, end: image.source.length, text: 'IMAGE' },
        { documentId: 'ghost', start: 0, end: 0, text: 'x' },
      ]);

      expect(result.status).toBe('failed');
      expect(state.fragment()).toBe(FRAGMENT);
      expect(compilation.draftRevision()).toBe(base);
    });

    it('refuses overlapping edits to the same document', () => {
      const image = imagePass(state.project()!);
      const base = compilation.draftRevision();

      const result = mutations.applyTextEdits(base, [
        { documentId: image.id, start: 0, end: 5, text: 'a' },
        { documentId: image.id, start: 3, end: 8, text: 'b' },
      ]);

      expect(result.status).toBe('failed');
      expect(state.fragment()).toBe(FRAGMENT);
      expect(compilation.draftRevision()).toBe(base);
    });

    it('treats an empty batch as a no-op rather than an edit', () => {
      const base = compilation.draftRevision();
      expect(mutations.applyTextEdits(base, [])).toEqual({ status: 'noop', revision: base });
      expect(compilation.draftRevision()).toBe(base);
    });

    it('has nothing to patch with no document open', () => {
      state.clearWorkspace();
      const result = mutations.applyTextEdits(compilation.draftRevision(), []);

      expect(result).toEqual({
        status: 'failed',
        failure: { ok: false, code: 'NOT_FOUND', message: 'No shader is open.' },
      });
    });
  });
});
