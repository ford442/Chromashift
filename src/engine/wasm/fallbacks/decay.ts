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
  // ((a + s) % 360 + 360) % 360 handles negative steps. The two arrays come
  // from different sources (live angles vs. settings), so a layer without a
  // step holds still rather than turning NaN for the rest of the export.
  return angles.map((angle, i) => ((angle + (steps[i] ?? 0)) % 360 + 360) % 360);
}
