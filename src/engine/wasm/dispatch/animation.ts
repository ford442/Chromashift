/**
 * Frame-timing / tracer `*With()` dispatchers. See docs/wasm-engine.md for
 * the call-site matrix — all of these are load-time, export-only, or
 * test/benchmark-only. None run on the per-frame render path; persistence
 * calls `durationToDecay()` from `math/decay.ts` directly.
 */

import { buildRotationMat3 } from '../../math/rotation';
import { canUseWasmFn, getWasmModule, withWasmScratch } from '../loadEngine';
import { durationToDecay, tsAdvanceAngles, tsSimulateTracerDecay } from '../fallbacks/decay';

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

/**
 * Build a column-major 3×3 rotation matrix for a layer angle in degrees.
 * Matches `buildRotationMat3()` in src/engine/math/rotation.ts.
 */
export function buildRotationMat3With(
  angleDeg: number,
  useWasm: boolean,
): Float32Array {
  if (canUseWasmFn('_buildRotationMat3', useWasm)) {
    const mod = getWasmModule()!;
    return withWasmScratch(mod, 9 * 4, (outPtr) => {
      mod._buildRotationMat3(angleDeg, outPtr);
      return mod.HEAPF32.slice(outPtr >> 2, (outPtr >> 2) + 9);
    });
  }

  return buildRotationMat3(angleDeg);
}

/**
 * Apply per-frame decay to a flat Float32 RGBA buffer in-place.
 *
 * Each channel (R, G, B, A) is multiplied by `decayFactor`.  This replicates
 * the decay step of the WGSL persistence shader and is useful for CPU-side
 * tracer simulation and unit tests.  For real-time rendering the GPU pipeline
 * in `WebGPURenderer` handles this more efficiently.
 *
 * @param buffer      Float32 RGBA buffer — values in [0, 1], modified in-place.
 * @param decayFactor Per-frame multiplier, typically from `durationToDecayWith`.
 * @param useWasm     Attempt to use the C++ WASM engine.
 */
export function simulateTracerDecayWith(
  buffer: Float32Array,
  decayFactor: number,
  useWasm: boolean,
): void {
  const pixelCount = Math.floor(buffer.length / 4);

  if (canUseWasmFn('_simulateTracerDecay', useWasm)) {
    const mod = getWasmModule()!;
    const byteCount = pixelCount * 4 * 4; // pixelCount × 4 channels × 4 bytes/float
    withWasmScratch(mod, byteCount, (ptr) => {
      // Copy buffer into WASM heap (HEAPF32 is indexed by float, not byte)
      mod.HEAPF32.set(buffer.subarray(0, pixelCount * 4), ptr >> 2);
      mod._simulateTracerDecay(ptr, pixelCount, decayFactor);
      // Copy result back
      buffer.set(mod.HEAPF32.subarray(ptr >> 2, (ptr >> 2) + pixelCount * 4));
    });
    return;
  }

  tsSimulateTracerDecay(buffer, decayFactor);
}
