/**
 * Tracer-decay `*With()` dispatcher. See docs/wasm-engine.md for the call-site
 * matrix — it is test/benchmark-only. Nothing on the per-frame path routes
 * through it: persistence calls `durationToDecay()` from `math/decay.ts`
 * directly, and the layer angles are `advanceAngles()` in `math/rotation.ts`.
 */

import { canUseWasmFn, getWasmModule } from '../loadEngine';
import { durationToDecay } from '../fallbacks/decay';

/**
 * Compute the tracer persistence decay multiplier via the WASM/TS dispatcher.
 *
 * Solves `decay ^ (fps × durationMs / 1000) = 0.1` so that the tracer
 * reaches 10% of its original brightness after `durationMs` milliseconds.
 * Matches `durationToDecay()` in `math/decay.ts`. Kept for WASM/TS parity
 * testing and the benchmark page — the render hot path calls
 * `durationToDecay()` directly and never routes through WASM.
 *
 * @param durationMs  Desired tracer lifetime in milliseconds.
 * @param fps         Current frame rate.
 * @param useWasm     Attempt to use the C++ WASM engine.
 * @returns           Per-frame multiplier in [0, 1).
 */
export function durationToDecayWith(
  durationMs: number,
  fps: number,
  useWasm: boolean,
): number {
  if (canUseWasmFn('_durationToDecay', useWasm)) {
    return getWasmModule()!._durationToDecay(durationMs, fps);
  }

  return durationToDecay(durationMs, fps);
}
