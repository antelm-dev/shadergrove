import { PROFILER_MIN_GPU_SAMPLES, type ProfilerGpuSupport } from '@shadergrove/rendering';

export const TARGET_FRAME_MS = 1000 / 60;
export const OVER_BUDGET_RATIO = 1.1;
export const SAFETY_MARGIN = 0.9;
export const SCALE_STEP = 0.05;
export const MIN_RESOLUTION_SCALE = 0.25;
export const MAX_SAMPLE_AGE_MS = 500;

export interface PassCostInput {
  readonly id: string;
  readonly gpuP95Ms: number | null;
  readonly fixedResolution: boolean;
}

export interface ScaleRecommendationInput {
  readonly gpuSupport: ProfilerGpuSupport;
  readonly totalGpuP95Ms: number | null;
  readonly cpuSubmissionP95Ms: number | null;
  readonly sampleCount: number;
  readonly lastSampleAgeMs: number | null;
  readonly currentScale: number;
  readonly passes: readonly PassCostInput[];
}

export function roundScaleDown(value: number): number {
  return Math.round(Math.floor(value / SCALE_STEP) * SCALE_STEP * 100) / 100;
}

export function recommendLowerScale(input: ScaleRecommendationInput): number | null {
  if (input.gpuSupport !== 'supported') return null;
  if (input.sampleCount < PROFILER_MIN_GPU_SAMPLES) return null;
  if (input.lastSampleAgeMs !== null && input.lastSampleAgeMs > MAX_SAMPLE_AGE_MS) return null;

  const gpuP95 = input.totalGpuP95Ms;
  if (gpuP95 === null) return null;

  const cpuP95 = input.cpuSubmissionP95Ms;
  if (cpuP95 === null) return null;
  if (gpuP95 <= cpuP95 * 1.05) return null;
  if (gpuP95 <= TARGET_FRAME_MS * OVER_BUDGET_RATIO) return null;

  const fixedPasses = input.passes.filter((pass) => pass.fixedResolution);
  // Unknown/still-warming fixed cost must not produce a suggestion.
  if (fixedPasses.some((pass) => pass.gpuP95Ms === null)) return null;
  const fixedCost = fixedPasses.reduce((sum, pass) => sum + (pass.gpuP95Ms as number), 0);

  const scalableCost = gpuP95 - fixedCost;
  const targetScalable = (TARGET_FRAME_MS - fixedCost) * SAFETY_MARGIN;
  if (scalableCost <= 0 || targetScalable <= 0) return null;
  if (scalableCost <= targetScalable) return null;

  const ratio = Math.sqrt(targetScalable / scalableCost) * SAFETY_MARGIN;
  let proposed = roundScaleDown(input.currentScale * ratio);
  proposed = Math.min(proposed, roundScaleDown(input.currentScale - SCALE_STEP));
  proposed = Math.max(MIN_RESOLUTION_SCALE, proposed);

  if (proposed >= input.currentScale) return null;
  return proposed;
}

export function formatMilliseconds(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(2)} ms`;
}

export function formatBytes(value: number | null): string {
  if (value === null) return '—';
  if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

/**
 * Coherent frame-share from matching median statistics.
 * Returns null when a meaningful share cannot be established.
 */
export function frameSharePercent(
  passMedianMs: number | null,
  totalMedianMs: number | null,
): number | null {
  if (passMedianMs === null || totalMedianMs === null || !(totalMedianMs > 0)) return null;
  const share = (passMedianMs / totalMedianMs) * 100;
  if (!Number.isFinite(share) || share < 0) return null;
  return Math.min(share, 100);
}

export function formatFrameShare(
  passMedianMs: number | null,
  totalMedianMs: number | null,
): string {
  const share = frameSharePercent(passMedianMs, totalMedianMs);
  return share === null ? '—' : `${share.toFixed(0)}%`;
}
