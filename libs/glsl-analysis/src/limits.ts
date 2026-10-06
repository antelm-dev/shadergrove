/** Default bounds; every one can be lowered (or raised) per client. */
export const DEFAULT_LIMITS = {
  /** UTF-8 bytes of one prepared source. */
  maxSourceBytes: 256 * 1024,
  /** Wall time for one synchronous analysis before the Worker is terminated. */
  timeoutMs: 3_000,
  /** Wall time for fetching/instantiating the WASM in a fresh Worker. */
  initTimeoutMs: 20_000,
  /** Hard WASM linear-memory ceiling inside the Worker. */
  maxMemoryBytes: 256 * 1024 * 1024,
  /** After a reply, a Worker whose memory has grown past this is recycled. */
  recycleMemoryBytes: 128 * 1024 * 1024,
  /** Sessions with a queued request (one per session; latest wins). */
  maxQueuedSessions: 16,
  /** Consecutive start-up/crash failures before the client stops retrying. */
  maxConsecutiveFailures: 3,
} as const;

export type AnalysisLimits = { -readonly [K in keyof typeof DEFAULT_LIMITS]: number };
