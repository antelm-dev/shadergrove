import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_CHANNELS,
  DEFAULT_RENDER,
  type ShaderControl,
  type ShaderParams,
  type ShaderRecord,
  type ShaderSummary,
} from '@shadergrove/shared/model';
import { migrateLegacyProject } from '@shadergrove/shared/project';
import { RendererHandle } from '../../rendering/renderer-handle';
import { CompilationService } from '../compilation.service';
import { DocumentState } from '../state/document-state';
import { SNAPSHOT_CAP, SNAPSHOT_LABEL_MAX, SessionSnapshots } from './session-snapshots';

const CONTROLS: ShaderControl[] = [{ key: 'speed', type: 'number', default: 1, min: 0, max: 10 }];

function makeRecord(id = 'waves'): ShaderRecord {
  const fragment = 'void main() { gl_FragColor = vec4(1.0); }';
  const vertex = 'void main() { gl_Position = vec4(position, 1.0); }';
  return {
    id,
    kind: 'shader',
    name: id,
    description: '',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    revision: 7,
    controls: structuredClone(CONTROLS),
    render: structuredClone(DEFAULT_RENDER),
    channels: structuredClone(DEFAULT_CHANNELS),
    thumbnail: null,
    fragment,
    vertex,
    presets: [],
    project: migrateLegacyProject(fragment, vertex),
  };
}

const summary = (id: string) => ({ id }) as ShaderSummary;

describe('SessionSnapshots', () => {
  let snapshots: SessionSnapshots;
  let state: DocumentState;
  let frame: Blob | null;
  let readFrame: () => Promise<Blob | null>;
  let created: unknown[];
  let revoked: string[];
  let canvasSizes: { width: number; height: number }[];
  let context2d: { drawImage: () => void } | null;

  beforeEach(() => {
    frame = new Blob(['png'], { type: 'image/png' });
    readFrame = async () => frame;
    created = [];
    revoked = [];
    canvasSizes = [];
    context2d = { drawImage: vi.fn() };

    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 1920, height: 1080, close: vi.fn() })),
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => context2d as never,
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
      this: HTMLCanvasElement,
      callback: BlobCallback,
    ) {
      canvasSizes.push({ width: this.width, height: this.height });
      callback(new Blob(['webp'], { type: 'image/webp' }));
    });
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      created.push(blob);
      return `blob:${created.length}`;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
      revoked.push(url);
    });

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: RendererHandle, useValue: { captureFrameBlob: () => readFrame() } },
      ],
    });
    state = TestBed.inject(DocumentState);
    const record = makeRecord();
    state.shaders.set([summary(record.id)]);
    state.adopt(record, structuredClone(record.project));
    snapshots = TestBed.inject(SessionSnapshots);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('capture', () => {
    it('holds the exact draft, params, channels, frame and a 240×135 WebP thumbnail', async () => {
      state.setParams({ speed: 4 });
      const draft = state.draft();

      const snapshot = await snapshots.capture('first');

      expect(snapshot).not.toBeNull();
      expect(snapshot?.shaderId).toBe('waves');
      expect(snapshot?.revision).toBe(7);
      expect(snapshot?.label).toBe('first');
      expect(snapshot?.draft).toEqual(draft);
      expect(snapshot?.draft).not.toBe(draft);
      expect(snapshot?.params).toEqual({ speed: 4 });
      expect(snapshot?.channels).toEqual(DEFAULT_CHANNELS);
      expect(snapshot?.frame).toBe(frame);
      expect(canvasSizes).toEqual([{ width: 240, height: 135 }]);
      expect((created[0] as Blob).type).toBe('image/webp');
      expect(snapshot?.thumbnailUrl).toBe('blob:1');
      expect(snapshots.forShader('waves')).toEqual([snapshot]);
    });

    it('is deeply immutable and independent of later edits', async () => {
      const snapshot = await snapshots.capture();
      if (!snapshot) throw new Error('no snapshot');

      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.draft.project)).toBe(true);
      expect(Object.isFrozen(snapshot.draft.render.postProcessing.effects)).toBe(true);
      expect(Object.isFrozen(snapshot.channels[0])).toBe(true);
      expect(() => {
        (snapshot.params as ShaderParams)['speed'] = 9;
      }).toThrow(TypeError);

      state.setParams({ speed: 3 });
      state.patchDraft({ controlsText: '[]' });
      expect(snapshot.params).toEqual({ speed: 1 });
      expect(snapshot.draft.controlsText).not.toBe('[]');
    });

    it('leaves the draft, its revision, the params and dirty state untouched', async () => {
      const compilation = TestBed.inject(CompilationService);
      const draft = state.draft();
      const params = state.params();
      const revision = compilation.draftRevision();

      await snapshots.capture();

      expect(state.draft()).toBe(draft);
      expect(state.params()).toBe(params);
      expect(compilation.draftRevision()).toBe(revision);
      expect(state.dirty()).toBe(false);
    });

    it('takes the state as it was when asked, not when the frame arrived', async () => {
      let deliver: (blob: Blob) => void = () => undefined;
      readFrame = () => new Promise((resolve) => (deliver = resolve));

      const pending = snapshots.capture();
      state.setParams({ speed: 8 });
      deliver(new Blob(['png'], { type: 'image/png' }));

      expect((await pending)?.params).toEqual({ speed: 1 });
    });

    it('falls back to the PNG frame as the thumbnail when WebP cannot be encoded', async () => {
      context2d = null;

      const snapshot = await snapshots.capture();

      expect(created).toEqual([frame]);
      expect(snapshot?.thumbnailUrl).toBe('blob:1');
    });

    it('gives nothing when there is no document, no frame, or the selection moved', async () => {
      frame = null;
      expect(await snapshots.capture()).toBeNull();

      frame = new Blob(['png']);
      let deliver: (blob: Blob) => void = () => undefined;
      readFrame = () => new Promise((resolve) => (deliver = resolve));
      const pending = snapshots.capture();
      state.adopt(makeRecord('other'), makeRecord('other').project);
      deliver(new Blob(['png']));
      expect(await pending).toBeNull();

      state.clearWorkspace();
      expect(await snapshots.capture()).toBeNull();

      expect(created).toEqual([]);
      expect(snapshots.byShader().size).toBe(0);
    });

    it('bounds the label', async () => {
      const snapshot = await snapshots.capture(`  ${'x'.repeat(200)}  `);
      expect(snapshot?.label).toHaveLength(SNAPSHOT_LABEL_MAX);
      expect((await snapshots.capture('   '))?.label).toBeUndefined();
    });
  });

  describe('limits', () => {
    it('keeps newest first and evicts the oldest unlabelled snapshot past the cap', async () => {
      const kept = await snapshots.capture('keep');
      const oldestUnlabelled = await snapshots.capture();
      for (let i = 0; i < SNAPSHOT_CAP - 1; i++) await snapshots.capture();

      const list = snapshots.forShader('waves');
      expect(list).toHaveLength(SNAPSHOT_CAP);
      expect(list.at(-1)).toBe(kept);
      expect(list).not.toContain(oldestUnlabelled);
      expect(list[0].createdAt).toBeGreaterThanOrEqual(list[1].createdAt);
      expect(revoked).toEqual([oldestUnlabelled?.thumbnailUrl]);
    });

    it('evicts the oldest labelled one only when every older snapshot is labelled', async () => {
      const first = await snapshots.capture('a');
      for (let i = 0; i < SNAPSHOT_CAP - 1; i++) await snapshots.capture(`label ${i}`);
      const newest = await snapshots.capture();

      const list = snapshots.forShader('waves');
      expect(list).toHaveLength(SNAPSHOT_CAP);
      expect(list[0]).toBe(newest);
      expect(list).not.toContain(first);
      expect(revoked).toEqual([first?.thumbnailUrl]);
    });

    it('caps each shader separately', async () => {
      for (let i = 0; i < 3; i++) await snapshots.capture();
      const other = makeRecord('other');
      state.shaders.set([summary('waves'), summary('other')]);
      state.adopt(other, structuredClone(other.project));
      await snapshots.capture();

      expect(snapshots.forShader('waves')).toHaveLength(3);
      expect(snapshots.forShader('other')).toHaveLength(1);
    });
  });

  describe('editing and cleanup', () => {
    it('remove drops one snapshot and revokes its URL', async () => {
      const a = await snapshots.capture();
      const b = await snapshots.capture();
      snapshots.remove(a?.id ?? '');

      expect(snapshots.forShader('waves')).toEqual([b]);
      expect(revoked).toEqual([a?.thumbnailUrl]);

      snapshots.remove(b?.id ?? '');
      expect(snapshots.byShader().has('waves')).toBe(false);
    });

    it('label replaces the frozen snapshot, and blank text clears the label', async () => {
      const original = await snapshots.capture();
      const id = original?.id ?? '';

      snapshots.label(id, ' Night ');
      const labelled = snapshots.forShader('waves')[0];
      expect(labelled.label).toBe('Night');
      expect(Object.isFrozen(labelled)).toBe(true);
      expect(labelled.thumbnailUrl).toBe(original?.thumbnailUrl);
      expect(original?.label).toBeUndefined();

      snapshots.label(id, '');
      expect('label' in snapshots.forShader('waves')[0]).toBe(false);
      expect(revoked).toEqual([]);
    });

    it('clearShader drops and revokes only that shader', async () => {
      const a = await snapshots.capture();
      const b = await snapshots.capture();
      const other = makeRecord('other');
      state.adopt(other, structuredClone(other.project));
      await snapshots.capture();

      snapshots.clearShader('waves');

      expect(snapshots.forShader('waves')).toEqual([]);
      expect(snapshots.forShader('other')).toHaveLength(1);
      expect(revoked.sort()).toEqual([a?.thumbnailUrl, b?.thumbnailUrl].sort());
    });

    it('drops the snapshots of a shader that left the library, once it is no longer open', async () => {
      const a = await snapshots.capture();

      state.shaders.set([]);
      TestBed.tick();
      expect(snapshots.forShader('waves')).toHaveLength(1);

      const other = makeRecord('other');
      state.adopt(other, structuredClone(other.project));
      TestBed.tick();
      expect(snapshots.forShader('waves')).toEqual([]);
      expect(revoked).toEqual([a?.thumbnailUrl]);
    });

    it('revokes every URL when the app is torn down', async () => {
      const a = await snapshots.capture();
      const b = await snapshots.capture();

      TestBed.resetTestingModule();

      expect(revoked.sort()).toEqual([a?.thumbnailUrl, b?.thumbnailUrl].sort());
    });
  });
});
