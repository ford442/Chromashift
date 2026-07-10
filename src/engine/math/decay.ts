/**
 * Per-frame tracer decay multiplier — mirrors C++ durationToDecay and WGSL persistence.
 * After `durationMs` at `fps`, accumulated brightness reaches ~10%.
 */
export function durationToDecay(durationMs: number, fps: number): number {
  if (durationMs <= 0) return 0.0;
  const frames = fps * durationMs / 1000;
  if (frames < 1) return 0.0;
  return Math.pow(0.1, 1 / frames);
}
