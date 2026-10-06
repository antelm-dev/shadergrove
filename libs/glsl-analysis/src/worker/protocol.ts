import type { AnalysisJob, JobOutcome } from '../native-reply';
import type { FatalReason, FrontendInfo } from './runtime';

/** Host → Worker messages. Request identity stays on the host; only the job crosses. */
export type HostMessage =
  | {
      readonly type: 'init';
      readonly wasmUrl: string;
      readonly maxMemoryBytes: number;
      readonly maxSourceBytes: number;
    }
  | { readonly type: 'analyze'; readonly job: AnalysisJob };

export interface WorkerMetrics {
  readonly analysisMs: number;
  readonly heapBytes: number;
  readonly memoryBytes: number;
}

/** Worker → host messages. */
export type WorkerMessage =
  | {
      readonly type: 'ready';
      readonly frontend: FrontendInfo;
      readonly wasmBytes: number;
      readonly fetchMs: number;
      readonly instantiateMs: number;
      readonly memoryBytes: number;
      readonly heapBytes: number;
    }
  | { readonly type: 'init-error'; readonly message: string }
  | {
      readonly type: 'result';
      readonly requestId: string;
      readonly outcome: JobOutcome;
      readonly metrics: WorkerMetrics;
    }
  | {
      readonly type: 'rejected';
      readonly requestId: string;
      readonly reason: 'input-limit' | 'invalid-request';
      readonly message: string;
    }
  | {
      readonly type: 'fatal';
      readonly requestId: string;
      readonly reason: FatalReason;
      readonly message: string;
    };
