/**
 * Pure TypeScript decay / angle-stepping fallbacks — used when the WASM
 * engine is unavailable or `useWasm` is false. Mirror `advanceLayerAngles`
 * and `simulateTracerDecay` in `cpp/chromashift_engine.cpp`.
 *
 * `durationToDecay` itself already lives in `../../math/decay.ts` (single
 * source of truth for the tracer-persistence formula) — re-exported here so
 * dispatch.ts has one fallback import surface.
 */

export { durationToDecay } from '../../math/decay';

/** Steps as many angles as `angles` carries — the layer count is its length. */
export function tsAdvanceAngles(
  angles: readonly number[],
  steps: readonly number[],
): number[] {
  // ((a + s) % 360 + 360) % 360 handles negative steps.
  return angles.map((angle, i) => ((angle + steps[i]) % 360 + 360) % 360);
}

export function tsSimulateTracerDecay(buffer: Float32Array, decayFactor: number): void {
  const pixelCount = Math.floor(buffer.length / 4);
  for (let i = 0; i < pixelCount * 4; i++) {
    buffer[i] *= decayFactor;
  }
}
