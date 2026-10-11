import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_CHANNELS,
  DEFAULT_RENDER,
  type ShaderRecord,
  type ShaderSummary,
} from '@shadergrove/shared/model';
import { migrateLegacyProject } from '@shadergrove/shared/project';
import { DocumentState } from '../workspace/state/document-state';
import { CompareReference, DEFAULT_COMPARE_SPLIT, clampSplit } from './compare-reference';
import { RendererHandle } from './renderer-handle';

function makeRecord(id: string): ShaderRecord {
  const fragment = 'void main() { gl_FragColor = vec4(1.0); }';
  const vertex = 'void main() { gl_Position = vec4(position, 1.0); }';
  return {
    id,
    kind: 'shader',
    name: id,
    description: '',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    revision: 1,
    controls: [],
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

/** A stand-in for `ImageBitmap`: jsdom has none, and `close` is what the lifecycle is about. */
function fakeBitmap(width = 800, height = 450) {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap & {
    close: ReturnType<typeof vi.fn>;
  };
}

/** A fake engine whose GPU context can be lost on demand. */
function fakeEngine() {
  const listeners = new Set<() => void>();
  return {
    context: {
      onLost: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    lose: () => listeners.forEach((listener) => listener()),
    listeners,
  };
}

describe('CompareReference', () => {
  let compare: CompareReference;
  let state: DocumentState;
  let engine: ReturnType<typeof fakeEngine>;
  let engineSignal: ReturnType<typeof signal<ReturnType<typeof fakeEngine> | null>>;
  let captureFrameBlob: ReturnType<typeof vi.fn>;
  let decoded: ReturnType<typeof fakeBitmap>[];

  beforeEach(() => {
    decoded = [];
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        const bitmap = fakeBitmap(1600, 900);
        decoded.push(bitmap);
        return bitmap;
      }),
    );
    engine = fakeEngine();
    engineSignal = signal<ReturnType<typeof fakeEngine> | null>(engine);
    captureFrameBlob = vi.fn(async () => new Blob(['png'], { type: 'image/png' }));

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: RendererHandle, useValue: { engine: engineSignal, captureFrameBlob } },
      ],
    });
    state = TestBed.inject(DocumentState);
    state.shaders.set([summary('waves'), summary('plasma')]);
    open('waves');
    compare = TestBed.inject(CompareReference);
    TestBed.tick();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function open(id: string): void {
    const record = makeRecord(id);
    state.adopt(record, structuredClone(record.project));
  }

  describe('pin (AC-CMP-01)', () => {
    it('decodes the current frame at drawing-buffer size, for the open shader', async () => {
      expect(await compare.pin('before')).toBe(true);

      const reference = compare.reference();
      expect(captureFrameBlob).toHaveBeenCalledTimes(1);
      expect(reference?.bitmap).toBe(decoded[0]);
      expect(reference).toMatchObject({
        width: 1600,
        height: 900,
        shaderId: 'waves',
        label: 'before',
      });
      expect(typeof reference?.capturedAt).toBe('number');
    });

    it('only reads the frame: no engine control is touched', async () => {
      // The renderer mock has nothing but `engine` and `captureFrameBlob`; any
      // call to pause, request frames or move the pointer would throw here.
      await compare.pin();
      expect(Object.keys(TestBed.inject(RendererHandle))).toEqual(['engine', 'captureFrameBlob']);
    });

    it('replaces the previous reference and closes its bitmap exactly once', async () => {
      await compare.pin();
      await compare.pin();
      await compare.pin();

      expect(decoded).toHaveLength(3);
      expect(decoded[0].close).toHaveBeenCalledTimes(1);
      expect(decoded[1].close).toHaveBeenCalledTimes(1);
      expect(decoded[2].close).not.toHaveBeenCalled();
      expect(compare.reference()?.bitmap).toBe(decoded[2]);
    });

    it('does nothing without a document or a frame', async () => {
      captureFrameBlob.mockResolvedValueOnce(null);
      expect(await compare.pin()).toBe(false);
      expect(createImageBitmap).not.toHaveBeenCalled();

      state.clearWorkspace();
      expect(await compare.pin()).toBe(false);
      expect(compare.reference()).toBeNull();
    });

    it('resolves false, leaving the current reference, when the frame cannot be read or decoded', async () => {
      await compare.pin();
      const kept = compare.reference();

      vi.mocked(createImageBitmap).mockRejectedValueOnce(
        new DOMException('bad', 'InvalidStateError'),
      );
      expect(await compare.pin()).toBe(false);
      captureFrameBlob.mockRejectedValueOnce(new Error('lost'));
      expect(await compare.pin()).toBe(false);

      expect(compare.reference()).toBe(kept);
      expect(decoded[0].close).not.toHaveBeenCalled();
    });

    it('drops, and closes, a frame whose shader was left while it was read', async () => {
      const pending = compare.pin();
      open('plasma');

      expect(await pending).toBe(false);
      expect(compare.reference()).toBeNull();
      expect(decoded[0].close).toHaveBeenCalledTimes(1);
    });

    it('drops a frame that finishes after an unpin', async () => {
      const pending = compare.pin();
      compare.unpin();

      expect(await pending).toBe(false);
      expect(compare.reference()).toBeNull();
      expect(decoded[0].close).toHaveBeenCalledTimes(1);
    });
  });

  describe('setReference (AC-CMP-05)', () => {
    it('adopts a bitmap from another feature under the single-reference rule', async () => {
      await compare.pin();
      const external = fakeBitmap(640, 360);

      compare.setReference(external, { shaderId: 'plasma', label: '  Snapshot 3 ' });

      expect(decoded[0].close).toHaveBeenCalledTimes(1);
      expect(compare.reference()).toMatchObject({
        bitmap: external,
        width: 640,
        height: 360,
        shaderId: 'plasma',
        label: 'Snapshot 3',
      });
      expect(external.close).not.toHaveBeenCalled();
    });

    it('does not close a bitmap that is set again', () => {
      const bitmap = fakeBitmap();
      compare.setReference(bitmap, { shaderId: 'waves' });
      compare.setReference(bitmap, { shaderId: 'waves' });

      expect(bitmap.close).not.toHaveBeenCalled();
      expect(compare.reference()?.label).toBeUndefined();
    });
  });

  describe('lifecycle (AC-CMP-04)', () => {
    it('is visible only for the shader it was taken from, and survives visiting others', async () => {
      await compare.pin();
      expect(compare.visibleFor('waves')).toBe(true);
      expect(compare.visibleFor('plasma')).toBe(false);
      expect(compare.visibleFor(null)).toBe(false);

      open('plasma');
      TestBed.tick();
      open('waves');
      TestBed.tick();

      expect(compare.reference()?.bitmap).toBe(decoded[0]);
      expect(decoded[0].close).not.toHaveBeenCalled();
    });

    it('closes the bitmap on unpin and resets the wipe', async () => {
      await compare.pin();
      compare.setSplit(0.2);
      compare.toggleSwap();
      compare.hold(true);

      compare.unpin();
      compare.unpin();

      expect(compare.reference()).toBeNull();
      expect(decoded[0].close).toHaveBeenCalledTimes(1);
      expect(compare.split()).toBe(DEFAULT_COMPARE_SPLIT);
      expect(compare.swapped()).toBe(false);
      expect(compare.holding()).toBe(false);
    });

    it('is cleared when its shader is deleted', async () => {
      await compare.pin();
      open('plasma');
      state.shaders.set([summary('plasma')]);
      TestBed.tick();

      expect(compare.reference()).toBeNull();
      expect(decoded[0].close).toHaveBeenCalledTimes(1);
    });

    it('is cleared when the active GPU context is lost, and stops listening to a replaced engine', async () => {
      await compare.pin();
      engine.lose();

      expect(compare.reference()).toBeNull();
      expect(decoded[0].close).toHaveBeenCalledTimes(1);

      const next = fakeEngine();
      engineSignal.set(next);
      TestBed.tick();
      expect(engine.listeners.size).toBe(0);
      expect(next.listeners.size).toBe(1);
    });

    it('is cleared, and stops listening, when the app is torn down', async () => {
      await compare.pin();
      TestBed.resetTestingModule();

      expect(decoded[0].close).toHaveBeenCalledTimes(1);
      expect(engine.listeners.size).toBe(0);

      const late = fakeBitmap();
      compare.setReference(late, { shaderId: 'waves' });
      expect(late.close).toHaveBeenCalledTimes(1);
      expect(compare.reference()).toBeNull();
    });
  });

  describe('wipe state', () => {
    it('clamps the split to [0, 1] and nudges from where it is', () => {
      compare.setSplit(1.4);
      expect(compare.split()).toBe(1);
      compare.nudge(-0.1);
      expect(compare.split()).toBeCloseTo(0.9);
      compare.setSplit(-3);
      expect(compare.split()).toBe(0);
      compare.nudge(-0.01);
      expect(compare.split()).toBe(0);
      expect(clampSplit(Number.NaN)).toBe(DEFAULT_COMPARE_SPLIT);
    });

    it('holds only while there is a reference', async () => {
      compare.hold(true);
      expect(compare.holding()).toBe(false);

      await compare.pin();
      compare.hold(true);
      expect(compare.holding()).toBe(true);
      compare.hold(false);
      expect(compare.holding()).toBe(false);
    });
  });
});
