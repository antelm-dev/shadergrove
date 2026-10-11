import { describe, expect, it, vi } from 'vitest';

import { targetSize } from './pass-targets';
import {
  IMAGE_PASS_ID,
  POST_PASS_ID,
  PROFILER_MIN_GPU_SAMPLES,
  PerformanceProfiler,
  bufferAllocationBytes,
} from './performance-profiler';

function createProfiler(options?: {
  supported?: boolean;
  disjoint?: boolean;
  pollResults?: number[];
  availableSequence?: readonly boolean[];
}) {
  let disjoint = options?.disjoint ?? false;
  const pollResults = [...(options?.pollResults ?? [])];
  const queries: WebGLQuery[] = [];

  // Extension only exposes TIME_ELAPSED + GPU_DISJOINT; results use core WebGL2 enums.
  const ext = {
    TIME_ELAPSED_EXT: 0x88bf,
    GPU_DISJOINT_EXT: 0x8fbb,
  };

  let pollIndex = 0;
  let availableForPoll = false;
  let forcedAvailable: boolean | null = null;

  const gl = {
    QUERY_RESULT_AVAILABLE: 0x8867,
    QUERY_RESULT: 0x8866,
    getExtension: (name: string) =>
      options?.supported === false || name !== 'EXT_disjoint_timer_query_webgl2' ? null : ext,
    createQuery: () => {
      const query = { id: queries.length } as WebGLQuery;
      queries.push(query);
      return query;
    },
    deleteQuery: vi.fn(),
    beginQuery: () => {},
    endQuery: () => {},
    getParameter: (pname: number) => {
      if (pname === ext.GPU_DISJOINT_EXT) {
        if (forcedAvailable !== null) {
          availableForPoll = forcedAvailable;
        } else {
          const seq = options?.availableSequence;
          availableForPoll = seq
            ? (seq[pollIndex] ?? seq[seq.length - 1]!)
            : pollResults.length > 0;
          pollIndex++;
        }
        return disjoint;
      }
      return false;
    },
    getQueryParameter: (query: WebGLQuery, pname: number) => {
      if (pname === gl.QUERY_RESULT_AVAILABLE) return availableForPoll;
      if (pname === gl.QUERY_RESULT) {
        return pollResults.shift() ?? options?.pollResults?.[0] ?? 2_000_000;
      }
      void query;
      return 0;
    },
  };

  const renderer = { getContext: () => gl } as never;
  const textures = {
    textureAllocations: () => ({
      items: [{ slot: 0, width: 64, height: 64, bytes: 64 * 64 * 4 }],
      totalBytes: 64 * 64 * 4,
      estimated: true as const,
    }),
  } as never;

  const profiler = new PerformanceProfiler(
    () => renderer,
    () => textures,
  );
  return {
    profiler,
    gl,
    queries,
    setDisjoint: (value: boolean) => {
      disjoint = value;
    },
    setResultAvailable: (value: boolean | null) => {
      forcedAvailable = value;
    },
  };
}

describe('bufferAllocationBytes', () => {
  it('counts two RGBA16F targets per buffer', () => {
    expect(bufferAllocationBytes(800, 600)).toBe(800 * 600 * 8 * 2);
  });
});

describe('targetSize', () => {
  it('keeps fixed-resolution passes at their declared size', () => {
    expect(
      targetSize({ mode: 'fixed', width: 512, height: 256, scale: 1 }, { width: 800, height: 600 }),
    ).toEqual({ width: 512, height: 256 });
  });
});

describe('PerformanceProfiler', () => {
  it('is disabled by default and creates no timer queries', () => {
    const { profiler, queries } = createProfiler();
    expect(profiler.isEnabled).toBe(false);
    profiler.endFrame(1);
    expect(queries).toHaveLength(0);
  });

  it('keeps Image and failed-new-pass compile records against requested project IDs', () => {
    const { profiler } = createProfiler();
    profiler.setEnabled(true);

    profiler.setRequestedPasses(['image-1', 'buf-new']);
    profiler.recordCompile('image-1', 8, true);
    profiler.recordCompile('buf-new', 3, false);

    // Timing schedule uses synthetic finals; must not prune real compile IDs.
    profiler.schedulePasses(['buf-a'], true, false);
    const snapshot = profiler.snapshot([]);
    expect(snapshot.compiles).toEqual(
      expect.arrayContaining([
        { passId: 'image-1', durationMs: 8, success: true },
        { passId: 'buf-new', durationMs: 3, success: false },
      ]),
    );

    profiler.setRequestedPasses(['image-1']);
    const pruned = profiler.snapshot([]);
    expect(pruned.compiles).toEqual([{ passId: 'image-1', durationMs: 8, success: true }]);
  });

  it('alternates total-frame and single-pass sampling schedules', () => {
    const { profiler } = createProfiler();
    profiler.setEnabled(true);

    const first = profiler.schedulePasses(['buf-a'], true, false);
    expect(first.mode).toBe('total');
    profiler.endFrame(1);

    const second = profiler.schedulePasses(['buf-a'], true, false);
    expect(second.mode).toBe('pass');
    expect(second.passId).toBe('buf-a');
    profiler.endFrame(1);

    const third = profiler.schedulePasses(['buf-a'], true, false);
    expect(third.mode).toBe('pass');
    expect(third.passId).toBe(IMAGE_PASS_ID);
    profiler.endFrame(1);

    const fourth = profiler.schedulePasses(['buf-a'], true, true);
    expect(fourth.mode).toBe('total');
    profiler.endFrame(1);

    const fifth = profiler.schedulePasses(['buf-a'], true, true);
    expect(fifth.passId).toBe('buf-a');
    profiler.endFrame(1);

    const sixth = profiler.schedulePasses(['buf-a'], true, true);
    expect(sixth.passId).toBe(POST_PASS_ID);
  });

  it('publishes CPU submission percentiles immediately after enough samples', () => {
    const { profiler } = createProfiler();
    profiler.setEnabled(true);

    for (let index = 0; index < PROFILER_MIN_GPU_SAMPLES; index++) {
      profiler.endFrame(10 + index * 0.1);
    }

    const snapshot = profiler.snapshot([]);
    expect(snapshot.cpuSubmission.medianMs).not.toBeNull();
    expect(snapshot.cpuSubmission.p95Ms).not.toBeNull();
  });

  it('stays warming until enough GPU samples resolve', () => {
    const { profiler } = createProfiler({ supported: true, pollResults: [] });
    profiler.setEnabled(true);
    profiler.schedulePasses(['buf-a'], true, false);
    profiler.beginGpu();
    profiler.endGpu();
    profiler.endFrame(2);

    expect(profiler.snapshot([]).gpuSupport).toBe('warming');
  });

  it('aggregates every resolved query event (sampleCount is not overwritten)', () => {
    const nanos = 2_000_000;
    const pollResults = [1, 2, 3, 4, 5].map(() => nanos);
    const availableSequence = [false, false, false, false, false, true];

    const { profiler } = createProfiler({ supported: true, pollResults, availableSequence });
    profiler.setEnabled(true);

    // Accumulate 5 in-flight queries across 5 polls.
    for (let frame = 0; frame < 5; frame++) {
      profiler.schedulePasses(['buf-a'], true, false);
      profiler.beginGpu();
      profiler.endGpu();
      profiler.endFrame(1);
    }

    // 6th poll resolves all pending queries at once.
    profiler.endFrame(1);

    const snapshot = profiler.snapshot([]);
    expect(snapshot.sampleCount).toBe(5);
  });

  it('suspends/clears during offline capture and resumes after endOffline', () => {
    const nanos = 2_000_000;

    const { profiler } = createProfiler({
      supported: true,
      pollResults: [nanos, nanos],
      availableSequence: [true, true, true],
    });

    profiler.setEnabled(true);
    profiler.schedulePasses(['buf-a'], true, false);
    profiler.beginGpu();
    profiler.endGpu();
    profiler.endFrame(1);

    expect(profiler.snapshot([]).sampleCount).toBeGreaterThan(0);

    profiler.onCaptureStart();
    expect(profiler.snapshot([]).sampleCount).toBe(0);

    profiler.onCaptureEnd();
    profiler.schedulePasses(['buf-a'], true, false);
    profiler.beginGpu();
    profiler.endGpu();
    profiler.endFrame(1);

    expect(profiler.snapshot([]).sampleCount).toBeGreaterThan(0);
  });

  it('resolves supported GPU timing asynchronously without blocking', () => {
    const nanos = 2_000_000;
    const frames = PROFILER_MIN_GPU_SAMPLES * 2;
    const pollResults = Array.from({ length: frames }, () => nanos);
    const { profiler } = createProfiler({ supported: true, pollResults });
    profiler.setEnabled(true);

    for (let frame = 0; frame < frames; frame++) {
      profiler.schedulePasses([], true, false);
      profiler.beginGpu();
      profiler.endGpu();
      profiler.endFrame(1);
    }

    const snapshot = profiler.snapshot([]);
    expect(snapshot.gpuSupport).toBe('supported');
    expect(snapshot.totalGpu.medianMs).toBeCloseTo(2, 5);
  });

  it('discards samples and reports disjoint when the driver signals it', () => {
    const { profiler, setDisjoint } = createProfiler({
      supported: true,
      disjoint: true,
      pollResults: [1_000_000],
    });
    profiler.setEnabled(true);
    profiler.schedulePasses(['buf-a'], true, false);
    profiler.beginGpu();
    profiler.endGpu();
    profiler.endFrame(1);

    const snapshot = profiler.snapshot([]);
    expect(snapshot.gpuSupport).toBe('disjoint');
    expect(snapshot.totalGpu.medianMs).toBeNull();

    setDisjoint(false);
    profiler.schedulePasses(['buf-a'], true, false);
    profiler.beginGpu();
    profiler.endGpu();
    profiler.endFrame(1);
    expect(profiler.snapshot([]).gpuSupport).toBe('warming');
  });

  it('recovers after a mid-flight disjoint with pending queries', () => {
    const { profiler, setDisjoint, gl, queries } = createProfiler({
      supported: true,
      pollResults: [2_000_000, 2_000_000, 2_000_000],
      availableSequence: [false, true, true, true],
    });
    profiler.setEnabled(true);
    profiler.schedulePasses(['buf-a'], true, false);
    profiler.beginGpu();
    profiler.endGpu();
    // First poll: result not available yet, query stays pending.
    profiler.endFrame(1);
    expect(queries.length).toBe(1);
    expect(gl.deleteQuery).not.toHaveBeenCalled();

    setDisjoint(true);
    profiler.endFrame(1);
    expect(profiler.snapshot([]).gpuSupport).toBe('disjoint');
    expect(profiler.snapshot([]).sampleCount).toBe(0);
    expect(gl.deleteQuery).toHaveBeenCalled();

    const queriesAfterDisjoint = queries.length;
    setDisjoint(false);
    profiler.schedulePasses(['buf-a'], true, false);
    profiler.beginGpu();
    profiler.endGpu();
    profiler.endFrame(1);
    expect(queries.length).toBeGreaterThan(queriesAfterDisjoint);
    expect(profiler.snapshot([]).gpuSupport).toBe('warming');
  });

  it('reports unavailable GPU timing when the extension is missing', () => {
    const { profiler } = createProfiler({ supported: false });
    profiler.setEnabled(true);
    expect(profiler.snapshot([]).gpuSupport).toBe('unavailable');
  });

  it('clears pending state when disabled', () => {
    const { profiler, gl } = createProfiler({ supported: true, pollResults: [1_000_000] });
    profiler.setEnabled(true);
    profiler.schedulePasses([], true, false);
    profiler.beginGpu();
    profiler.endGpu();
    profiler.setEnabled(false);

    expect(gl.deleteQuery).toHaveBeenCalled();
    expect(profiler.isEnabled).toBe(false);
  });

  it('includes owned buffer allocations and estimated texture bytes in snapshots', () => {
    const { profiler } = createProfiler();
    profiler.setEnabled(true);
    profiler.schedulePasses(['buf-a'], true, false);
    const snapshot = profiler.snapshot([
      { id: 'buf-a', width: 100, height: 50, bytes: bufferAllocationBytes(100, 50) },
    ]);

    expect(snapshot.renderTargetBytes).toBe(bufferAllocationBytes(100, 50) + 4);
    expect(snapshot.textureEstimated).toBe(true);
    expect(snapshot.textureBytes).toBe(64 * 64 * 4);
    expect(snapshot.passes.find((pass) => pass.id === 'buf-a')?.targetBytes).toBe(
      bufferAllocationBytes(100, 50),
    );
  });

  it('resets warming after a context loss and reacquires the adapter on restore', () => {
    const { profiler, gl, queries } = createProfiler({
      supported: true,
      pollResults: [2_000_000, 2_000_000],
      availableSequence: [true, true],
    });
    profiler.setEnabled(true);
    profiler.schedulePasses(['buf-a'], true, false);
    profiler.beginGpu();
    profiler.endGpu();
    const pendingBeforeLoss = queries.length;

    profiler.onContextLost();
    expect(gl.deleteQuery).toHaveBeenCalled();
    expect(profiler.snapshot([]).gpuSupport).toBe('warming');
    expect(profiler.snapshot([]).sampleCount).toBe(0);

    profiler.onContextRestored();
    profiler.schedulePasses(['buf-a'], true, false);
    profiler.beginGpu();
    profiler.endGpu();
    profiler.endFrame(1);

    expect(queries.length).toBeGreaterThan(pendingBeforeLoss);
    expect(profiler.snapshot([]).gpuSupport).toBe('warming');
  });

  it('resets timing samples without disabling profiling', () => {
    const { profiler } = createProfiler({
      supported: true,
      pollResults: [2_000_000],
      availableSequence: [true],
    });
    profiler.setEnabled(true);
    profiler.schedulePasses(['buf-a'], true, false);
    profiler.beginGpu();
    profiler.endGpu();
    profiler.endFrame(1);
    expect(profiler.snapshot([]).sampleCount).toBeGreaterThan(0);

    const generation = profiler.generation;
    profiler.resetTimingSamples();
    expect(profiler.isEnabled).toBe(true);
    expect(profiler.generation).toBeGreaterThan(generation);
    expect(profiler.snapshot([]).sampleCount).toBe(0);
    expect(profiler.snapshot([]).gpuSupport).toBe('warming');
  });

  it('deletes pending queries on reset so late results cannot enter the new generation', () => {
    const { profiler, gl, setResultAvailable } = createProfiler({
      supported: true,
      pollResults: [9_000_000, 2_000_000],
    });
    profiler.setEnabled(true);
    profiler.schedulePasses(['buf-a'], true, false);

    setResultAvailable(false);
    profiler.beginGpu();
    profiler.endGpu();
    profiler.endFrame(1);
    expect(profiler.snapshot([]).sampleCount).toBe(0);
    expect(gl.deleteQuery).not.toHaveBeenCalled();

    const generation = profiler.generation;
    profiler.resetTimingSamples();
    expect(gl.deleteQuery).toHaveBeenCalled();
    expect(profiler.isEnabled).toBe(true);
    expect(profiler.generation).toBeGreaterThan(generation);
    expect(profiler.snapshot([]).sampleCount).toBe(0);

    // Pre-reset query is gone; making results available must not resurrect it.
    setResultAvailable(true);
    profiler.endFrame(1);
    expect(profiler.snapshot([]).sampleCount).toBe(0);
    expect(profiler.snapshot([]).totalGpu.medianMs).toBeNull();

    profiler.schedulePasses(['buf-a'], true, false);
    profiler.beginGpu();
    profiler.endGpu();
    profiler.endFrame(1);
    expect(profiler.snapshot([]).sampleCount).toBe(1);
    expect(profiler.snapshot([]).gpuSupport).toBe('warming');
  });
});
