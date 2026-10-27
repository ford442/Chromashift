/**
 * Frame-timing / tracer `*With()` dispatchers. See docs/wasm-engine.md for
 * the call-site matrix — all of these are load-time, export-only, or
 * test/benchmark-only. None run on the per-frame render path; persistence
 * calls `durationToDecay()` from `math/decay.ts` directly.
 */

import { canUseWasmFn, getWasmModule } from '../loadEngine';
import { durationToDecay, tsAdvanceAngles } from '../fallbacks/decay';

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

/**
 * Advance a session's layer rotation angles by per-frame step sizes,
 * keeping all results in [0, 360).
 *
 * `angles.length` is the layer count. Always TypeScript, even with the engine
 * loaded: there are at most ten angles, so a `_malloc`, two heap copies and a
 * `_free` per exported frame cost more than the loop they would wrap. The C
 * `advanceLayerAngles` export stays as the reference this mirrors.
 *
 * Callers that own FPS-independent rates should scale with
 * `extensionStepsForFps()` before passing steps here (live loop + video export).
 *
 * @param angles   Current angles in degrees, one per layer.
 * @param steps    Per-frame step sizes in degrees, one per layer.
 * @returns        New angles in degrees, each in [0, 360).
 */
export function advanceAnglesBy(
  angles: readonly number[],
  steps: readonly number[],
): number[] {
  return tsAdvanceAngles(angles, steps);
}
